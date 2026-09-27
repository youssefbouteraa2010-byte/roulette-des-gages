// ============================================================================
// app.js — Logique frontend du jeu "Roulette des Gages"
//
// Sommaire :
//   1. Connexion Socket.io + navigation entre écrans (accueil / jeu)
//   2. Caméra locale (getUserMedia) + mesh WebRTC peer-to-peer entre joueurs
//      -> aucune vidéo ne passe par le serveur, seule la signalisation y transite
//   3. Réception des tours de jeu : Text-to-Speech (Web Speech) ou son absurde
//      (généré localement via Web Audio API, donc aucun fichier audio requis)
//   4. Fonctionnalité secrète "master" : écouteur clavier discret qui active
//      un mode admin (immunité au tirage / possibilité de forcer une cible)
// ============================================================================

const socket = io();

// ---------------------------------------------------------------------------
// Etat local du client
// ---------------------------------------------------------------------------
let myId = null;
let myPseudo = '';
let roomCode = null;
let isHost = false;
let localStream = null;
let cheatActive = false; // mode secret activé ou non

// pcs[peerId] = { pc: RTCPeerConnection, videoEl }
const pcs = {};

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ---------------------------------------------------------------------------
// Références DOM
// ---------------------------------------------------------------------------
const homeScreen = document.getElementById('home-screen');
const gameScreen = document.getElementById('game-screen');
const videoGrid = document.getElementById('video-grid');
const roomCodeDisplay = document.getElementById('room-code-display');
const startRoundBtn = document.getElementById('start-round-btn');
const joinError = document.getElementById('join-error');
const cheatIndicator = document.getElementById('cheat-indicator');

// ---------------------------------------------------------------------------
// 1. Navigation / création & jointure de salon
// ---------------------------------------------------------------------------

document.getElementById('create-room-btn').addEventListener('click', async () => {
  myPseudo = document.getElementById('create-pseudo').value.trim() || 'Hôte';
  await ensureCamera();
  socket.emit('create-room', myPseudo, (res) => {
    if (!res.ok) return;
    roomCode = res.code;
    isHost = true;
    enterGameScreen();
  });
});

document.getElementById('join-room-btn').addEventListener('click', async () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  myPseudo = document.getElementById('join-pseudo').value.trim() || 'Joueur';
  if (!code) { joinError.textContent = 'Entre un code de salon.'; return; }

  await ensureCamera();
  socket.emit('join-room', { code, pseudo: myPseudo }, (res) => {
    if (!res.ok) { joinError.textContent = res.error; return; }
    roomCode = res.code;
    isHost = false;
    enterGameScreen();
  });
});

function enterGameScreen() {
  homeScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  roomCodeDisplay.textContent = roomCode;
  if (isHost) startRoundBtn.classList.remove('hidden');
}

socket.on('connect', () => { myId = socket.id; });

// ---------------------------------------------------------------------------
// 2. Caméra locale
// ---------------------------------------------------------------------------

async function ensureCamera() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (err) {
    alert("Impossible d'accéder à la caméra : " + err.message);
    localStream = null;
  }
  return localStream;
}

// Crée (ou met à jour) une tuile vidéo dans la grille pour un joueur donné
function ensureTile(playerId, pseudo, isPlayerHost) {
  let tile = document.getElementById('tile-' + playerId);
  if (tile) return tile;

  tile = document.createElement('div');
  tile.className = 'tile' + (isPlayerHost ? ' host-tile' : '');
  tile.id = 'tile-' + playerId;

  const pseudoTag = document.createElement('div');
  pseudoTag.className = 'pseudo-tag';
  pseudoTag.textContent = pseudo;
  tile.appendChild(pseudoTag);

  // Clic sur la caméra d'un pote = forcer la cible du prochain tour (mode secret uniquement)
  tile.addEventListener('click', () => {
    if (!cheatActive || playerId === myId) return;
    socket.emit('cheat-force-target', playerId);
    tile.style.outline = '2px dashed var(--accent)';
    setTimeout(() => (tile.style.outline = ''), 600);
  });

  videoGrid.appendChild(tile);
  return tile;
}

function setTileStream(tile, stream) {
  tile.querySelectorAll('video, .placeholder').forEach((el) => el.remove());
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = (tile.dataset.isLocal === 'true');
  video.srcObject = stream;
  tile.prepend(video);
}

// ---------------------------------------------------------------------------
// Liste des joueurs (met à jour la grille + le badge de mode "cheat" visuel)
// ---------------------------------------------------------------------------
socket.on('players-update', (players) => {
  const knownIds = new Set(players.map((p) => p.id));

  // Retire les tuiles des joueurs partis
  document.querySelectorAll('.tile').forEach((tile) => {
    const id = tile.id.replace('tile-', '');
    if (!knownIds.has(id)) tile.remove();
  });

  players.forEach((p) => {
    const tile = ensureTile(p.id, p.pseudo + (p.id === myId ? ' (toi)' : ''), p.isHost);
    tile.classList.toggle('cheat-clickable', cheatActive && p.id !== myId);
    if (p.id === myId) {
      tile.dataset.isLocal = 'true';
      if (localStream) setTileStream(tile, localStream);
    }
    if (p.isHost && p.id === myId) isHost = true;
  });
});

// ---------------------------------------------------------------------------
// Un nouveau joueur arrive -> on initie/complète la connexion WebRTC avec lui
// ---------------------------------------------------------------------------
socket.on('peer-joined', ({ id }) => {
  // Convention simple pour éviter le "glare" (double offre) :
  // celui dont l'id est lexicographiquement le plus petit initie l'offre.
  if (myId < id) createPeerConnection(id, true);
  else createPeerConnection(id, false);
});

socket.on('peer-left', (id) => {
  if (pcs[id]) {
    pcs[id].pc.close();
    delete pcs[id];
  }
});

function createPeerConnection(peerId, isInitiator) {
  if (pcs[peerId]) return pcs[peerId].pc;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  pcs[peerId] = { pc };

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-signal', { to: peerId, data: { candidate: event.candidate } });
    }
  };

  pc.ontrack = (event) => {
    const tile = document.getElementById('tile-' + peerId);
    if (tile) setTileStream(tile, event.streams[0]);
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { to: peerId, data: { sdp: pc.localDescription } });
    };
  }

  return pc;
}

// Réception de la signalisation WebRTC (offer / answer / ICE candidate)
socket.on('webrtc-signal', async ({ from, data }) => {
  const pc = createPeerConnection(from, false);

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { /* ignoré */ }
  }
});

// ---------------------------------------------------------------------------
// 3. Déroulement d'un tour de jeu
// ---------------------------------------------------------------------------

startRoundBtn.addEventListener('click', () => socket.emit('start-round'));

socket.on('round-started', ({ targetId, targetPseudo }) => {
  document.querySelectorAll('.tile').forEach((t) => t.classList.remove('selected'));
  const tile = document.getElementById('tile-' + targetId);
  if (tile) tile.classList.add('selected');
  console.log(`🎯 ${targetPseudo} a été tiré au sort !`);
});

socket.on('round-ended', () => {
  document.querySelectorAll('.tile').forEach((t) => t.classList.remove('selected'));
});

// Le joueur tiré au sort reçoit son gage
socket.on('you-are-selected', (gage) => {
  if (gage.type === 'tts') {
    speakText(gage.text);
  } else if (gage.type === 'sound') {
    playAbsurdSound(gage.sound);
  }
});

function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'fr-FR';
  utter.rate = 1.0;
  utter.pitch = 1.1;
  window.speechSynthesis.speak(utter);
}

// Génère des sons absurdes purement en JS via Web Audio API (aucun fichier requis)
function playAbsurdSound(name) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;

  function tone(freq, start, duration, type = 'sine', gainVal = 0.3) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now + start);
    gain.gain.setValueAtTime(gainVal, now + start);
    gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration);
  }

  switch (name) {
    case 'klaxon':
      tone(220, 0, 0.4, 'sawtooth');
      tone(220, 0.5, 0.4, 'sawtooth');
      break;
    case 'canard':
      for (let i = 0; i < 4; i++) tone(600 - i * 40, i * 0.15, 0.1, 'square', 0.25);
      break;
    case 'corne_de_brume':
      tone(90, 0, 1.4, 'sawtooth', 0.35);
      break;
    case 'boing':
      tone(440, 0, 0.05, 'triangle');
      tone(220, 0.05, 0.3, 'triangle');
      break;
    default:
      tone(440, 0, 0.3);
  }
}

// ---------------------------------------------------------------------------
// 4. Fonctionnalité secrète : séquence clavier "master"
// ---------------------------------------------------------------------------
// Ecouteur clavier global et discret : aucune UI ne signale son existence.
// Dès que le buffer des dernières touches tapées se termine par "master",
// le mode admin s'active silencieusement.
(function setupSecretCheat() {
  const TRIGGER = 'master';
  let buffer = '';

  window.addEventListener('keydown', (e) => {
    if (e.key.length !== 1) return; // ignore Shift, Enter, flèches, etc.
    buffer = (buffer + e.key.toLowerCase()).slice(-TRIGGER.length);
    if (buffer === TRIGGER) {
      activateCheatMode();
    }
  });
})();

function activateCheatMode() {
  cheatActive = true;
  socket.emit('cheat-activate');
  cheatIndicator.classList.add('active'); // seul indice visuel : un petit point discret
  document.querySelectorAll('.tile').forEach((tile) => {
    const id = tile.id.replace('tile-', '');
    tile.classList.toggle('cheat-clickable', id !== myId);
  });
}

socket.on('cheat-ack', (info) => {
  // Confirmation discrète en console uniquement (pas de popup qui trahirait le joueur)
  if (info.type === 'immune') console.log('%c✓ immunité activée', 'color:#6c5ce7');
  if (info.type === 'forced') console.log(`%c✓ cible forcée : ${info.pseudo}`, 'color:#6c5ce7');
}
);
