// ============================================================================
// server.js
// Serveur Node.js / Express / Socket.io pour "Roulette des Gages" (jeu de visio)
//
// Rôle du serveur :
//   1. Gérer les salons (création / jointure / départ)
//   2. Tirer au sort le joueur "gagé" à chaque tour et lui envoyer un gage
//      (texte à lire via Web Speech, ou son absurde à jouer via Web Audio)
//   3. Relayer la signalisation WebRTC (offer/answer/ICE) entre les clients
//      -> la vidéo elle-même ne transite JAMAIS par le serveur (peer-to-peer),
//         seules quelques métadonnées de connexion passent par ici.
//   4. Gérer le mode secret "master" (immunité / cible forcée)
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sert les fichiers statiques du dossier /public (index.html, app.js, css...)
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// Etat en mémoire des salons (pas de base de données : simplicité avant tout)
// ----------------------------------------------------------------------------
// rooms = {
//   "AB12": {
//     hostId: "socketId",
//     roundInProgress: false,
//     players: {
//       "socketId": { pseudo: "Kevin", immune: false, forcedTarget: null }
//     }
//   }
// }
const rooms = {};

// Banque de "gages" envoyés au joueur tiré au sort.
// type "tts"   -> le client utilise l'API Web Speech Synthesis pour lire le texte
// type "sound" -> le client joue un son absurde généré via Web Audio API (voir app.js)
const GAGES = [
  { type: 'tts', text: "Bonjour, je suis une licorne magique et je vends des tacos." },
  { type: 'tts', text: "Cot cot codèk, je suis la reine des poules du quartier." },
  { type: 'tts', text: "Alerte générale, mon percolateur vient de prendre feu." },
  { type: 'tts', text: "Je déclare officiellement la guerre aux pigeons du parc." },
  { type: 'tts', text: "Mesdames et messieurs, le spectacle peut enfin commencer." },
  { type: 'sound', sound: 'klaxon' },
  { type: 'sound', sound: 'canard' },
  { type: 'sound', sound: 'corne_de_brume' },
  { type: 'sound', sound: 'boing' },
];

// Génère un code de salon à 4 caractères, sans caractères ambigus (0/O, 1/I...)
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function roomPlayersList(code) {
  const room = rooms[code];
  if (!room) return [];
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    pseudo: p.pseudo,
    isHost: id === room.hostId,
  }));
}

function broadcastPlayers(code) {
  io.to(code).emit('players-update', roomPlayersList(code));
}

io.on('connection', (socket) => {
  // ---- Création de salon ----
  socket.on('create-room', (pseudo, cb) => {
    const code = genRoomCode();
    rooms[code] = { hostId: socket.id, roundInProgress: false, players: {} };
    rooms[code].players[socket.id] = { pseudo: pseudo || 'Hôte', immune: false, forcedTarget: null };
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code });
    broadcastPlayers(code);
  });

  // ---- Rejoindre un salon existant ----
  socket.on('join-room', ({ code, pseudo }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: "Ce salon n'existe pas." });

    room.players[socket.id] = { pseudo: pseudo || 'Joueur', immune: false, forcedTarget: null };
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, players: roomPlayersList(code) });
    broadcastPlayers(code);

    // On prévient les pairs déjà connectés qu'un nouveau venu doit être relié en WebRTC
    socket.to(code).emit('peer-joined', { id: socket.id, pseudo });
  });

  // ---- Lancement d'un tour (réservé à l'hôte) ----
  socket.on('start-round', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId || room.roundInProgress) return;

    const ids = Object.keys(room.players);
    if (ids.length === 0) return;

    // On exclut du tirage les joueurs immunisés (cheat "master")
    const eligibles = ids.filter((id) => !room.players[id].immune);
    const pool = eligibles.length > 0 ? eligibles : ids; // sécurité si tout le monde est immunisé

    // Si un joueur a secrètement forcé une cible, on la respecte en priorité
    let targetId = null;
    const forcer = ids.find((id) => room.players[id].forcedTarget);
    if (forcer && room.players[room.players[forcer].forcedTarget]) {
      targetId = room.players[forcer].forcedTarget;
      room.players[forcer].forcedTarget = null;
    } else {
      targetId = pool[Math.floor(Math.random() * pool.length)];
    }

    // L'immunité ne dure qu'un tour
    if (room.players[targetId]) room.players[targetId].immune = false;

    room.roundInProgress = true;
    const gage = GAGES[Math.floor(Math.random() * GAGES.length)];

    io.to(code).emit('round-started', {
      targetId,
      targetPseudo: room.players[targetId] ? room.players[targetId].pseudo : '???',
    });
    io.to(targetId).emit('you-are-selected', gage);

    // Fin de tour automatique (laisse le temps au fou rire général)
    setTimeout(() => {
      if (rooms[code]) rooms[code].roundInProgress = false;
      io.to(code).emit('round-ended');
    }, 12000);
  });

  // ---- Signalisation WebRTC : relais brut offer/answer/ICE candidate ----
  socket.on('webrtc-signal', ({ to, data }) => {
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  // ---- Fonctionnalité secrète : activation via la séquence clavier "master" ----
  // Pas d'authentification particulière : c'est un easter egg ludique entre potes,
  // pas une fonctionnalité de sécurité sensible.
  socket.on('cheat-activate', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].immune = true;
    socket.emit('cheat-ack', { type: 'immune' });
  });

  // Forcer la cible du prochain tour (clic sur la caméra d'un pote en mode cheat)
  socket.on('cheat-force-target', (targetId) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.players[socket.id] || !room.players[targetId]) return;
    room.players[socket.id].forcedTarget = targetId;
    socket.emit('cheat-ack', { type: 'forced', pseudo: room.players[targetId].pseudo });
  });

  // ---- Déconnexion ----
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    delete room.players[socket.id];
    socket.to(code).emit('peer-left', socket.id);

    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0]; // on transmet l'hôte au suivant
    }
    broadcastPlayers(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur "Roulette des Gages" lancé sur http://localhost:${PORT}`);
});
