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

// ─── JSON Store ───────────────────────────────────────────────────────────────
const DB_FILE = process.env.DB_PATH ||
  (fs.existsSync('/data') ? '/data/gotchly-data.json' : path.join(__dirname, 'gotchly-data.json'));

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { players: {}, accounts: {} }; }
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
function genId()    { return crypto.randomBytes(8).toString('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function genSalt()  { return crypto.randomBytes(16).toString('hex'); }
function hashPwd(pwd, salt) {
  return crypto.createHmac('sha256', salt).update(pwd).digest('hex');
}

function createAccount(username, password) {
  const db = loadDB();
  if (!db.accounts) db.accounts = {};
  const key = username.toLowerCase().trim();
  if (db.accounts[key]) return { error: 'Ese nombre ya está en uso' };
  const salt = genSalt();
  const id = genId();
  const token = genToken();
  db.accounts[key] = { id, username: username.trim(), salt,
    passwordHash: hashPwd(password, salt), token,
    createdAt: new Date().toISOString() };
  if (!db.players[id]) {
    db.players[id] = { id, name: username.trim(), total_games: 0, wins: 0,
      impostor_games: 0, impostor_caught: 0, points: 0,
      created_at: new Date().toISOString() };
  }
  saveDB(db);
  return { id, username: username.trim(), token };
}

function loginAccount(username, password) {
  const db = loadDB();
  const acc = (db.accounts || {})[username.toLowerCase().trim()];
  if (!acc) return { error: 'Usuario o contraseña incorrectos' };
  if (hashPwd(password, acc.salt) !== acc.passwordHash) return { error: 'Usuario o contraseña incorrectos' };
  acc.token = genToken();
  saveDB(db);
  return { id: acc.id, username: acc.username, token: acc.token };
}

function verifyToken(token) {
  if (!token) return null;
  const db = loadDB();
  const acc = Object.values(db.accounts || {}).find(a => a.token === token);
  return acc ? { id: acc.id, username: acc.username } : null;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
const PROMPT_PACKS = {
  free: [
    { real: 'Tu desayuno ideal',           impostor: 'Lo último que comiste' },
    { real: 'Tu mascota imaginaria',       impostor: 'Tu animal favorito' },
    { real: 'Un superhéroe ridículo',      impostor: 'Tu villano favorito' },
    { real: 'Tu lugar favorito del mundo', impostor: 'Un lugar que quieres visitar' },
    { real: 'El clima perfecto',           impostor: 'Una tormenta tropical' },
    { real: 'Tu trabajo soñado',           impostor: 'Lo que haces los lunes' },
    { real: 'Un monstruo amigable',        impostor: 'Tu mayor miedo' },
    { real: 'El fin de semana ideal',      impostor: 'Las vacaciones soñadas' },
    { real: 'Tu superpoder favorito',      impostor: 'Tu talento secreto' },
    { real: 'La luna llena',               impostor: 'El sol de mediodía' },
    { real: 'Un robot cocinero',           impostor: 'Una máquina del tiempo' },
    { real: 'La playa en verano',          impostor: 'Una tarde en el parque' },
    { real: 'Tu deporte favorito',         impostor: 'El ejercicio que más odias' },
    { real: 'Una fiesta de cumpleaños',    impostor: 'Una reunión de trabajo' },
    { real: 'El universo',                 impostor: 'Una bola de nieve' },
    { real: 'Tu película favorita',        impostor: 'Lo último que viste' },
    { real: 'Un dragón doméstico',         impostor: 'Un gato enojado' },
    { real: 'La ciudad perfecta',          impostor: 'Tu barrio actual' },
    { real: 'Tu canción favorita',         impostor: 'Un ruido muy molesto' },
    { real: 'Un castillo de arena',        impostor: 'Una montaña de nieve' },
    { real: 'Tu snack de medianoche',      impostor: 'Lo que desayunaste hoy' },
    { real: 'El regalo perfecto',          impostor: 'Lo que compraste esta semana' },
    { real: 'Un baile de celebración',     impostor: 'Cómo caminas cuando llueve' },
    { real: 'Tu villano favorito de película', impostor: 'Tu personaje de película' },
    { real: 'Un meme que te representa',   impostor: 'Tu foto de perfil actual' },
    { real: 'Un objeto volador misterioso',impostor: 'Un dron de delivery' },
    { real: 'Tu emoji favorito',           impostor: 'Tu estado de ánimo hoy' },
    { real: 'Una aventura espacial',       impostor: 'Un día en avión' },
    { real: 'Una sirena del siglo XXI',    impostor: 'Una persona nadando en la piscina' },
    { real: 'Tu app favorita del celular', impostor: 'La app que más usas en el trabajo' },
    { real: 'Un científico loco',          impostor: 'Tu profesor de química' },
    { real: 'Lo que soñaste anoche',       impostor: 'Una pesadilla clásica' },
    { real: 'La comida que preparas mejor',impostor: 'El plato que siempre pides' },
    { real: 'Un libro que cambió tu vida', impostor: 'El último libro que leíste' },
    { real: 'Tu momento más épico',        impostor: 'Lo mejor que hiciste este mes' },
  ],
  picantes: [
    { real: 'Una cita perfecta',             impostor: 'Una cena de trabajo' },
    { real: 'Lo que haces cuando estás solo',impostor: 'Tu hobby secreto' },
    { real: 'Tu crush de famoso',            impostor: 'Tu artista favorito' },
    { real: 'La persona más carismática que conoces', impostor: 'Tu mejor amigo' },
    { real: 'Una noche que nunca olvidarás', impostor: 'La última vez que saliste' },
    { real: 'Tu canción romántica favorita', impostor: 'La última canción que escuchaste' },
    { real: 'El lugar perfecto para un beso',impostor: 'Donde sueles esperar el bus' },
    { real: 'Lo que piensas antes de dormir',impostor: 'Tu lista de tareas' },
    { real: 'Tu tipo ideal de persona',      impostor: 'Tu compañero de trabajo' },
    { real: 'Una fantasía que pocas veces admitís', impostor: 'Lo que soñaste anoche' },
    { real: 'Lo que te hace sonrojar',       impostor: 'Una situación vergonzosa' },
    { real: 'Tu mensaje más atrevido',       impostor: 'El último mensaje que enviaste' },
    { real: 'Una canción para seducir',      impostor: 'La canción del gym' },
    { real: 'Lo que harías con $1000 extra para una noche', impostor: 'Tu plan del sábado' },
    { real: 'La mirada que lo dice todo',    impostor: 'Cómo miras el menú del restaurante' },
  ],
  parejas: [
    { real: 'La primera cita con tu pareja',       impostor: 'Una cena cualquiera' },
    { real: 'Lo que más admirás de tu pareja',     impostor: 'Lo que más admirás de vos' },
    { real: 'La pelea de pareja más tonta',        impostor: 'Discusión con un hermano' },
    { real: 'El viaje soñado en pareja',           impostor: 'Tus vacaciones del año pasado' },
    { real: 'Cómo te enamoras',                    impostor: 'Cómo hacés nuevos amigos' },
    { real: 'La señal de que alguien te gusta',    impostor: 'Cómo saludás a conocidos' },
    { real: 'El plan perfecto para San Valentín',  impostor: 'Un sábado en casa' },
    { real: 'La película ideal para ver juntos',   impostor: 'Lo que ves solo en Netflix' },
    { real: 'Cómo reconciliarse después de pelear',impostor: 'Cómo terminás una conversación difícil' },
    { real: 'El apodo más tierno que le pusiste a alguien', impostor: 'Tu apodo de la infancia' },
    { real: 'La promesa que nunca romperías',      impostor: 'Tu propósito de año nuevo' },
    { real: 'Tu mayor gesto romántico',            impostor: 'Lo más amable que hiciste esta semana' },
    { real: 'Lo que harías si tu pareja desaparece un día', impostor: 'Lo que hacés el día libre' },
    { real: 'La costumbre de pareja que tenés',    impostor: 'Tu ritual matutino' },
    { real: 'Cómo te gustaría que te propusieran matrimonio', impostor: 'Tu cumpleaños ideal' },
  ],
  halloween: [
    { real: 'Tu disfraz de Halloween soñado', impostor: 'Tu ropa favorita de diario' },
    { real: 'La casa embrujada perfecta',     impostor: 'Una casa vieja de tu barrio' },
    { real: 'Un fantasma simpático',          impostor: 'Alguien que conocés' },
    { real: 'Lo que harías si vieras un zombi', impostor: 'Tu reacción al despertador' },
    { real: 'La película de terror más aterradora', impostor: 'El peor documental de Netflix' },
    { real: 'Un monstruo que mete miedo de verdad', impostor: 'Tu profesor de matemáticas' },
    { real: 'El ritual de Halloween perfecto', impostor: 'Tu rutina de noche' },
    { real: 'Una bruja del siglo XXI',        impostor: 'La vecina del tercer piso' },
    { real: 'La noche más larga del año',     impostor: 'El fin de semana de exámenes' },
    { real: 'Tu parte favorita de Halloween', impostor: 'Tu otra festividad favorita' },
    { real: 'Un vampiro moderno',             impostor: 'Alguien que trabaja de noche' },
    { real: 'Lo que da más miedo en la oscuridad', impostor: 'Tu closet sin ordenar' },
    { real: 'Un hechizo que te gustaría tener', impostor: 'Tu superpoder favorito' },
    { real: 'El dulce perfecto para trick-or-treat', impostor: 'Tu golosina favorita' },
    { real: 'Una criatura del folklore latinoamericano', impostor: 'Un personaje de cuento' },
  ],
  fiestas: [
    { real: 'La fiesta perfecta',                    impostor: 'Una reunión familiar aburrida' },
    { real: 'Tu baile de fiesta característico',     impostor: 'Cómo te movés cuando estás contento' },
    { real: 'Lo que hacés cuando el DJ pone tu canción', impostor: 'Cuando suena la alarma' },
    { real: 'El brindis más épico de tu vida',       impostor: 'Celebrar que llegó el fin de semana' },
    { real: 'La foto de grupo perfecta',             impostor: 'Un selfie cualquiera' },
    { real: 'Cuando alguien llega sin avisar a la fiesta', impostor: 'Tu cara cuando llega una sorpresa' },
    { real: 'El momento cuando se acaba la música',  impostor: 'Cuando se corta el wifi' },
    { real: 'La resaca del día siguiente',           impostor: 'Un lunes por la mañana' },
    { real: 'El outfit de fiesta ideal',             impostor: 'Tu ropa favorita para salir' },
    { real: 'Cuando alguien baila mal pero con todo', impostor: 'Tu workout matutino' },
    { real: 'El snack perfecto de la fiesta',        impostor: 'Lo que comés viendo series' },
    { real: 'Cómo sabés que una fiesta fue buena',  impostor: 'Cómo evaluás una película' },
    { real: 'El invitado que siempre llega tarde',  impostor: 'Ese amigo tuyo en particular' },
    { real: 'Lo que hacés para que la fiesta no muera', impostor: 'Cómo animás una reunión' },
    { real: 'El final perfecto para una fiesta épica', impostor: 'Cómo terminás tu día' },
  ],
};

const PROMPTS = PROMPT_PACKS.free; // free always available

function getPromptForRoom(room) {
  const pack = room.packId && PROMPT_PACKS[room.packId] ? PROMPT_PACKS[room.packId] : PROMPTS;
  return pack[Math.floor(Math.random() * pack.length)];
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
const socketToRoom = new Map();
const socketToPlayer = new Map();

function genCode() {
  return 'GOTCH·' + Math.floor(1000 + Math.random() * 9000);
}
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
      packId: null,
    });
    socketToRoom.set(socket.id, code);
    socketToPlayer.set(socket.id, playerId);
    socket.join(code);
    socket.emit('room:created', { code, playerId, players: publicPlayers(rooms.get(code)) });
    console.log(`Sala creada: ${code} por ${playerName}`);
  });

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

  socket.on('game:start', ({ packId } = {}) => {
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
    if (packId) room.packId = packId;

    const promptPair = getPromptForRoom(room);
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
    room.impostorId = null; room.promptPair = null; room.drawingOrder = [];
    room.players.forEach(p => { p.drawing = null; p.vote = null; p.isImpostor = false; });
    io.to(code).emit('game:reset', { players: publicPlayers(room) });
  });

  socket.on('player:get-stats', ({ playerId }) => {
    if (!playerId) return;
    socket.emit('player:stats', { stats: getStats(playerId) });
  });

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
      if (!Array.from(r.players.values()).some(p => p.connected)) {
        clearInterval(r.timer);
        rooms.delete(code);
        console.log(`Sala ${code} eliminada (vacía)`);
      }
    }, 5 * 60 * 1000);
  });
});

// ─── Timers ───────────────────────────────────────────────────────────────────
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
    playerId: id, dataURL: p.drawing === 'empty' ? null : p.drawing,
  }));
  shuffle(entries);
  room.drawingOrder = entries;
  io.to(room.code).emit('game:voting-start', {
    drawings: entries.map((d, i) => ({
      index: i, label: `RESPUESTA ${i + 1}`,
      playerId: d.playerId, dataURL: d.dataURL,
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
    if (p.isImpostor) { if (!impostorCaught) pts = 150; }
    else {
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
        pts);
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
    voteSummary, scoreUpdates,
    players: publicPlayers(room).map(p => ({ ...p, score: room.players.get(p.id)?.score || 0 })),
  });
  console.log(`Reveal ${room.code} — ${impostor?.name} ${impostorCaught ? 'ATRAPADO' : 'ESCAPÓ'}`);
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get('/api/stats/:id', (req, res) => {
  try { res.json({ stats: getStats(req.params.id) }); }
  catch { res.json({ stats: null }); }
});

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || username.trim().length < 2)
    return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  const result = createAccount(username, password);
  if (result.error) return res.status(409).json(result);
  res.json({ ok: true, ...result });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  const result = loginAccount(username, password);
  if (result.error) return res.status(401).json(result);
  res.json({ ok: true, ...result });
});

app.get('/api/auth/verify', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, ...user, stats: getStats(user.id) });
});

app.get('/api/packs', (req, res) => {
  res.json({
    packs: [
      { id: 'free',      name: 'Básico',    emoji: '🎨', price: 'Gratis',  count: PROMPT_PACKS.free.length },
      { id: 'picantes',  name: 'Picantes',  emoji: '🌶️', price: '$1.99',   count: PROMPT_PACKS.picantes.length },
      { id: 'parejas',   name: 'Parejas',   emoji: '👫', price: '$1.99',   count: PROMPT_PACKS.parejas.length },
      { id: 'halloween', name: 'Halloween', emoji: '🎃', price: '$0.99',   count: PROMPT_PACKS.halloween.length },
      { id: 'fiestas',   name: 'Fiestas',   emoji: '🎉', price: '$2.99',   count: PROMPT_PACKS.fiestas.length },
    ]
  });
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => {
  console.log(`\n🎮 Gotchly en http://localhost:${PORT}\n`);
});
