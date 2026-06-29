const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DRAWING_TIME = 70;
const VOTING_TIME = 35;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── JSON Store (sin dependencias nativas) ────────────────────────────────────
const DB_FILE = process.env.DB_PATH ||
  (fs.existsSync('/data') ? '/data/gotchly-data.json' : path.join(__dirname, 'gotchly-data.json'));

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { players: {} }; }
}
function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function savePlayer(id, name) {
  const db = loadDB();
  if (!db.players[id]) {
    db.players[id] = { id, name, total_games: 0, wins: 0, impostor_games: 0,
      impostor_caught: 0, points: 0, created_at: new Date().toISOString() };
  } else {
    db.players[id].name = name;
  }
  db.players[id].last_seen = new Date().toISOString();
  saveDB(db);
}
function getStats(id) {
  const db = loadDB();
  return db.players[id] || null;
}
function addStats(id, win, impGame, caught, pts) {
  const db = loadDB();
  const p = db.players[id];
  if (!p) return;
  p.total_games++; p.wins += win; p.impostor_games += impGame;
  p.impostor_caught += caught; p.points += pts;
  p.last_seen = new Date().toISOString();
  saveDB(db);
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
const PROMPTS = [
  { real: 'Tu desayuno ideal',        impostor: 'Lo último que comiste' },
  { real: 'Tu mascota imaginaria',    impostor: 'Tu animal favorito' },
  { real: 'Un superhéroe ridículo',   impostor: 'Tu villano favorito' },
  { real: 'Tu lugar favorito',        impostor: 'Un lugar que quieres visitar' },
  { real: 'El clima perfecto',        impostor: 'Una tormenta tropical' },
  { real: 'Tu trabajo soñado',        impostor: 'Lo que haces los lunes' },
  { real: 'Un monstruo amigable',     impostor: 'Tu mayor miedo' },
  { real: 'El fin de semana ideal',   impostor: 'Las vacaciones soñadas' },
  { real: 'Tu superpoder favorito',   impostor: 'Tu talento secreto' },
  { real: 'La luna llena',            impostor: 'El sol de mediodía' },
  { real: 'Un robot cocinero',        impostor: 'Una máquina del tiempo' },
  { real: 'La playa en verano',       impostor: 'Una tarde en el parque' },
  { real: 'Tu deporte favorito',      impostor: 'El ejercicio que más odias' },
  { real: 'Una fiesta de cumpleaños', impostor: 'Una reunión de trabajo' },
  { real: 'El universo',              impostor: 'Una bola de nieve' },
  { real: 'Tu película favorita',     impostor: 'Lo último que viste' },
  { real: 'Un dragón doméstico',      impostor: 'Un gato enojado' },
  { real: 'La ciudad perfecta',       impostor: 'Tu barrio actual' },
  { real: 'Tu canción favorita',      impostor: 'Un ruido muy molesto' },
  { real: 'Un castillo de arena',     impostor: 'Una montaña de nieve' },
];

// ─── Rooms (memoria) ──────────────────────────────────────────────────────────
const rooms = new Map();
const socketToRoom = new Map();
const socketToPlayer = new Map();

function genCode() {
  return 'GOTCH·' + Math.floor(1000 + Math.random() * 9000);
}
function genId() { return crypto.randomBytes(8).toString('hex'); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function publicPlayers(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, score: p.score,
    connected: p.connected, isHost: p.isHost,
  }));
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Conectado:', socket.id);

  // ── Crear sala ───────────────────────────────────────────────────────────
  socket.on('room:create', ({ name, playerId: existingId }) => {
    const playerName = (name || '').trim();
    if (playerName.length < 2) return socket.emit('error', 'El nombre debe tener al menos 2 caracteres');

    const playerId = existingId || genId();
    savePlayer(playerId, playerName);

    let code;
    do { code = genCode(); } while (rooms.has(code));

    const player = {
      id: playerId, socketId: socket.id, name: playerName,
      score: 0, isHost: true, connected: true,
      drawing: null, vote: null, isImpostor: false,
    };

    rooms.set(code, {
      code, state: 'waiting',
      players: new Map([[playerId, player]]),
      promptPair: null, impostorId: null,
      drawingOrder: [], timer: null, timerValue: 0, round: 0,
    });
    socketToRoom.set(socket.id, code);
    socketToPlayer.set(socket.id, playerId);
    socket.join(code);

    socket.emit('room:created', { code, playerId, players: publicPlayers(rooms.get(code)) });
    console.log(`Sala creada: ${code} por ${playerName}`);
  });

  // ── Unirse a sala ────────────────────────────────────────────────────────
  socket.on('room:join', ({ name, code: rawCode, playerId: existingId }) => {
    const code = (rawCode || '').trim().toUpperCase();
    const playerName = (name || '').trim();
    if (playerName.length < 2) return socket.emit('error', 'El nombre debe tener al menos 2 caracteres');

    const room = rooms.get(code);
    if (!room) return socket.emit('error', 'Sala no encontrada. Verifica el código');
    if (room.state !== 'waiting') return socket.emit('error', 'La partida ya comenzó');
    if (room.players.size >= MAX_PLAYERS) return socket.emit('error', `Sala llena (máx ${MAX_PLAYERS} jugadores)`);

    const playerId = existingId || genId();
    savePlayer(playerId, playerName);

    const player = {
      id: playerId, socketId: socket.id, name: playerName,
      score: 0, isHost: false, connected: true,
      drawing: null, vote: null, isImpostor: false,
    };

    room.players.set(playerId, player);
    socketToRoom.set(socket.id, code);
    socketToPlayer.set(socket.id, playerId);
    socket.join(code);

    socket.emit('room:joined', { code, playerId, players: publicPlayers(room) });
    socket.to(code).emit('room:players-update', { players: publicPlayers(room) });
    console.log(`${playerName} unido a ${code}`);
  });

  // ── Iniciar partida ──────────────────────────────────────────────────────
  socket.on('game:start', () => {
    const code = socketToRoom.get(socket.id);
    const playerId = socketToPlayer.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.state !== 'waiting') return;
    const player = room.players.get(playerId);
    if (!player?.isHost) return socket.emit('error', 'Solo el host puede iniciar');

    const connected = Array.from(room.players.values()).filter(p => p.connected).length;
    if (connected < MIN_PLAYERS) return socket.emit('error', `Necesitas al menos ${MIN_PLAYERS} jugadores`);

    room.state = 'drawing';
    room.round++;

    const promptPair = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    room.promptPair = promptPair;

    const ids = Array.from(room.players.keys());
    const impostorId = ids[Math.floor(Math.random() * ids.length)];
    room.impostorId = impostorId;

    room.players.forEach(p => {
      p.drawing = null; p.vote = null;
      p.isImpostor = (p.id === impostorId);
    });

    room.players.forEach(p => {
      io.to(p.socketId).emit('game:started', {
        prompt: p.isImpostor ? promptPair.impostor : promptPair.real,
        isImpostor: p.isImpostor,
        timerSeconds: DRAWING_TIME,
        playerCount: room.players.size,
      });
    });

    startDrawingTimer(room);
    console.log(`Partida ${code} — impostor: ${room.players.get(impostorId)?.name}`);
  });

  // ── Enviar dibujo ────────────────────────────────────────────────────────
  socket.on('game:submit-drawing', ({ dataURL }) => {
    const code = socketToRoom.get(socket.id);
    const playerId = socketToPlayer.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.state !== 'drawing') return;
    const player = room.players.get(playerId);
    if (!player || player.drawing) return;

    player.drawing = dataURL || 'empty';

    const total = room.players.size;
    const submitted = Array.from(room.players.values()).filter(p => p.drawing).length;
    io.to(code).emit('game:drawing-progress', { submitted, total });

    if (submitted === total) {
      clearInterval(room.timer);
      startVotingPhase(room);
    }
  });

  // ── Votar ────────────────────────────────────────────────────────────────
  socket.on('game:vote', ({ targetPlayerId }) => {
    const code = socketToRoom.get(socket.id);
    const playerId = socketToPlayer.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.state !== 'voting') return;
    const player = room.players.get(playerId);
    if (!player || player.vote) return;
    if (!room.players.has(targetPlayerId)) return;

    player.vote = targetPlayerId;
    const total = room.players.size;
    const voted = Array.from(room.players.values()).filter(p => p.vote).length;
    io.to(code).emit('game:vote-progress', { voted, total });

    if (voted === total) {
      clearInterval(room.timer);
      revealResults(room);
    }
  });

  // ── Jugar de nuevo ───────────────────────────────────────────────────────
  socket.on('game:play-again', () => {
    const code = socketToRoom.get(socket.id);
    const playerId = socketToPlayer.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player?.isHost) return;

    clearInterval(room.timer);
    room.state = 'waiting';
    room.impostorId = null;
    room.promptPair = null;
    room.drawingOrder = [];
    room.players.forEach(p => { p.drawing = null; p.vote = null; p.isImpostor = false; });

    io.to(code).emit('game:reset', { players: publicPlayers(room) });
  });

  // ── Obtener stats ────────────────────────────────────────────────────────
  socket.on('player:get-stats', ({ playerId }) => {
    if (!playerId) return;
    socket.emit('player:stats', { stats: getStats(playerId) });
  });

  // ── Desconexión ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socketToRoom.get(socket.id);
    const playerId = socketToPlayer.get(socket.id);
    socketToRoom.delete(socket.id);
    socketToPlayer.delete(socket.id);
    if (!code || !playerId) return;

    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.connected = false;

    io.to(code).emit('room:players-update', { players: publicPlayers(room) });

    setTimeout(() => {
      const r = rooms.get(code);
      if (!r) return;
      const anyOnline = Array.from(r.players.values()).some(p => p.connected);
      if (!anyOnline) {
        clearInterval(r.timer);
        rooms.delete(code);
        console.log(`Sala ${code} eliminada (vacía)`);
      }
    }, 5 * 60 * 1000);
  });
});

// ─── Lógica del juego ─────────────────────────────────────────────────────────
function startDrawingTimer(room) {
  room.timerValue = DRAWING_TIME;
  clearInterval(room.timer);
  io.to(room.code).emit('game:timer', { seconds: DRAWING_TIME, phase: 'drawing' });

  room.timer = setInterval(() => {
    room.timerValue--;
    io.to(room.code).emit('game:timer', { seconds: room.timerValue, phase: 'drawing' });
    if (room.timerValue <= 0) {
      clearInterval(room.timer);
      room.players.forEach(p => { if (!p.drawing) p.drawing = 'empty'; });
      startVotingPhase(room);
    }
  }, 1000);
}

function startVotingPhase(room) {
  if (room.state !== 'drawing') return;
  room.state = 'voting';

  const entries = Array.from(room.players.entries()).map(([id, p]) => ({
    playerId: id,
    dataURL: p.drawing === 'empty' ? null : p.drawing,
  }));
  shuffle(entries);
  room.drawingOrder = entries;

  io.to(room.code).emit('game:voting-start', {
    drawings: entries.map((d, i) => ({
      index: i,
      label: `RESPUESTA ${i + 1}`,
      playerId: d.playerId,
      dataURL: d.dataURL,
    })),
    timerSeconds: VOTING_TIME,
  });

  room.timerValue = VOTING_TIME;
  room.timer = setInterval(() => {
    room.timerValue--;
    io.to(room.code).emit('game:timer', { seconds: room.timerValue, phase: 'voting' });
    if (room.timerValue <= 0) {
      clearInterval(room.timer);
      revealResults(room);
    }
  }, 1000);
}

function revealResults(room) {
  if (room.state !== 'voting') return;
  room.state = 'reveal';

  const voteCounts = new Map();
  room.players.forEach(p => {
    const target = p.vote || room.impostorId;
    voteCounts.set(target, (voteCounts.get(target) || 0) + 1);
  });

  let maxVotes = 0, mostVotedId = null;
  voteCounts.forEach((n, id) => { if (n > maxVotes) { maxVotes = n; mostVotedId = id; } });

  const impostorCaught = mostVotedId === room.impostorId;
  const impostor = room.players.get(room.impostorId);
  const scoreUpdates = {};

  room.players.forEach(p => {
    let pts = 0;
    if (p.isImpostor) {
      if (!impostorCaught) pts = 150;
    } else {
      if (p.vote === room.impostorId) pts += 100;
      if (impostorCaught) pts += 30;
    }
    p.score += pts;
    scoreUpdates[p.id] = pts;
    try {
      addStats(p.id,
        (p.isImpostor ? (!impostorCaught ? 1 : 0) : (impostorCaught ? 1 : 0)),
        p.isImpostor ? 1 : 0,
        (p.isImpostor && impostorCaught) ? 1 : 0,
        pts
      );
    } catch {}
  });

  const voteSummary = Array.from(room.players.values()).map(p => ({
    voterName: p.name,
    targetName: room.players.get(p.vote)?.name || '—',
    correct: p.vote === room.impostorId,
  }));

  io.to(room.code).emit('game:reveal', {
    impostorId: room.impostorId,
    impostorName: impostor?.name || '?',
    impostorCaught,
    realPrompt: room.promptPair.real,
    impostorPrompt: room.promptPair.impostor,
    impostorDrawing: (impostor?.drawing && impostor.drawing !== 'empty') ? impostor.drawing : null,
    voteSummary,
    scoreUpdates,
    players: publicPlayers(room).map(p => ({ ...p, score: room.players.get(p.id)?.score || 0 })),
  });

  console.log(`Reveal ${room.code} — ${impostor?.name} ${impostorCaught ? 'ATRAPADO' : 'ESCAPÓ'}`);
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get('/api/stats/:id', (req, res) => {
  try { res.json({ stats: getStats(req.params.id) }); }
  catch { res.json({ stats: null }); }
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 Gotchly en http://localhost:${PORT}\n`);
});
