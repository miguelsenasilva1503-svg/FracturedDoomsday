const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;
const COUNTDOWN_SECONDS = 3;
const DEFAULT_DURATION_MINUTES = 5;
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYERS_PER_ROOM = 8;

const DEFAULT_SETTINGS = {
  mapChoice: 0,
  duration: DEFAULT_DURATION_MINUTES,
  powerUps: true,
  difficulty: 'classic',
  bannedChars: [],
};

const rooms = new Map();

app.use(express.json());

app.get('/', (_req, res) => {
  res.status(200).send('Roguelite Legacy Arena backend online.');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    uptime: process.uptime(),
  });
});

app.get('/rooms', (_req, res) => {
  const payload = [...rooms.values()].map((room) => roomSnapshot(room));
  res.json(payload);
});

function safeName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'Jogador';
  return trimmed.slice(0, 20);
}

function safeCharId(charId) {
  const value = String(charId || '').trim();
  return value || 'strike';
}

function makeSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const duration = [2, 5, 10, 15].includes(Number(src.duration))
    ? Number(src.duration)
    : DEFAULT_SETTINGS.duration;

  const banned = Array.isArray(src.bannedChars)
    ? [...new Set(src.bannedChars.map((v) => String(v || '').trim()).filter(Boolean))]
    : [];

  return {
    mapChoice: Math.max(0, toInt(src.mapChoice, DEFAULT_SETTINGS.mapChoice)),
    duration,
    powerUps: src.powerUps === false || src.powerUps === 'false' || src.powerUps === 0 || src.powerUps === '0'
      ? false
      : true,
    difficulty: ['classic', 'hardcore', 'ultra'].includes(String(src.difficulty))
      ? String(src.difficulty)
      : DEFAULT_SETTINGS.difficulty,
    bannedChars: banned,
  };
}

function durationMsFromSettings(settings) {
  const minutes = [2, 5, 10, 15].includes(Number(settings?.duration))
    ? Number(settings.duration)
    : DEFAULT_DURATION_MINUTES;
  return minutes * 60 * 1000;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makeUniqueRoomCode() {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  return code;
}

function createRoom({ roomCode, hostId, hostName, hostCharId, settings }) {
  const room = {
    roomCode,
    hostId,
    players: [
      {
        id: hostId,
        name: safeName(hostName),
        charId: safeCharId(hostCharId),
        ready: false,
        score: 0,
        kills: 0,
        connected: true,
        sessionId: makeSessionId(),
      },
    ],
    started: false,
    starting: false,
    endsAt: null,
    timer: null,
    lastResult: null,
    settings: normalizeSettings(settings),
  };

  return room;
}

function roomSnapshot(room) {
  return {
    code: room.roomCode,
    roomCode: room.roomCode,
    hostId: room.hostId,
    status: room.started ? 'playing' : (room.starting ? 'starting' : 'lobby'),
    started: room.started,
    starting: room.starting,
    endsAt: room.endsAt,
    settings: normalizeSettings(room.settings),
    players: room.players
      .slice()
      .sort((a, b) => b.score - a.score || b.kills - a.kills || a.name.localeCompare(b.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        charId: safeCharId(p.charId),
        ready: !!p.ready,
        score: toInt(p.score, 0),
        kills: toInt(p.kills, 0),
        connected: !!p.connected,
        sessionId: p.sessionId || null,
      })),
    lastResult: room.lastResult || null,
  };
}

function emitRoomState(room) {
  const snapshot = roomSnapshot(room);
  io.to(room.roomCode).emit('room_state', snapshot);
  io.to(room.roomCode).emit('room:update', snapshot);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.id === socketId);
    if (player) return { room, player };
  }
  return null;
}

function assignHost(room) {
  const connected = room.players.filter((p) => p.connected);
  if (!connected.length) {
    room.hostId = null;
    return;
  }
  if (!connected.some((p) => p.id === room.hostId)) {
    room.hostId = connected[0].id;
  }
}

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function finishMatch(room, reason = 'finished') {
  stopTimer(room);
  room.started = false;
  room.starting = false;
  room.endsAt = null;

  const ranking = room.players
    .slice()
    .sort((a, b) => b.score - a.score || b.kills - a.kills || a.name.localeCompare(b.name))
    .map((p, index) => ({
      position: index + 1,
      id: p.id,
      name: p.name,
      charId: safeCharId(p.charId),
      score: toInt(p.score, 0),
      kills: toInt(p.kills, 0),
    }));

  room.lastResult = {
    reason,
    ranking,
    winner: ranking[0] || null,
    mvp: ranking[0] || null,
    top3: ranking.slice(0, 3),
    endedAt: Date.now(),
  };

  io.to(room.roomCode).emit('match_end', room.lastResult);
  io.to(room.roomCode).emit('match:end', room.lastResult);
  emitRoomState(room);
}

function resetMatch(room) {
  if (!room) return;
  stopTimer(room);
  room.started = false;
  room.starting = false;
  room.endsAt = null;
  room.players.forEach((p) => {
    p.ready = false;
  });
  emitRoomState(room);
}

function startTimer(room) {
  stopTimer(room);
  const durationMs = durationMsFromSettings(room.settings);
  room.endsAt = Date.now() + durationMs;

  room.timer = setInterval(() => {
    const remainingMs = Math.max(0, room.endsAt - Date.now());

    io.to(room.roomCode).emit('match_tick', {
      timeLeftMs: remainingMs,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      endsAt: room.endsAt,
    });
    io.to(room.roomCode).emit('match:tick', {
      timeLeftMs: remainingMs,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      endsAt: room.endsAt,
    });

    if (remainingMs <= 0) {
      finishMatch(room, 'time_up');
      room.endsAt = null;
    }
  }, 1000);
}

function startMatch(room, cb = () => {}) {
  if (room.started || room.starting) {
    cb({ ok: false, error: 'already_started' });
    return;
  }

  room.starting = true;
  room.started = false;
  room.players.forEach((p) => {
    p.ready = false;
    p.score = 0;
    p.kills = 0;
  });

  emitRoomState(room);

  let countdown = COUNTDOWN_SECONDS;

  io.to(room.roomCode).emit('match_starting', { countdownSec: countdown });
  io.to(room.roomCode).emit('match:starting', { countdownSec: countdown });

  const prepTimer = setInterval(() => {
    countdown -= 1;

    if (countdown > 0) {
      io.to(room.roomCode).emit('match_starting', { countdownSec: countdown });
      io.to(room.roomCode).emit('match:starting', { countdownSec: countdown });
      return;
    }

    clearInterval(prepTimer);

    room.starting = false;
    room.started = true;
    const durationMs = durationMsFromSettings(room.settings);
    room.endsAt = Date.now() + durationMs;

    const payload = {
      roomCode: room.roomCode,
      durationMs,
      endsAt: room.endsAt,
      settings: normalizeSettings(room.settings),
    };

    io.to(room.roomCode).emit('match_start', payload);
    io.to(room.roomCode).emit('match:start', payload);

    startTimer(room);
    emitRoomState(room);
    cb({ ok: true, room: roomSnapshot(room) });
  }, 1000);
}

function handleCreateRoom(socket, payload = {}, cb = () => {}) {
  try {
    const roomCode = makeUniqueRoomCode();
    const nick = safeName(payload.name ?? payload.nickname ?? 'Jogador');
    const charId = safeCharId(payload.charId ?? payload.selectedChar ?? 'strike');
    const settings = normalizeSettings(payload.settings);

    const room = createRoom({
      roomCode,
      hostId: socket.id,
      hostName: nick,
      hostCharId: charId,
      settings,
    });

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerName = nick;
    socket.data.charId = charId;

    const snapshot = roomSnapshot(room);
    emitRoomState(room);

    cb({
      ok: true,
      code: roomCode,
      roomCode,
      sessionId: room.players[0]?.sessionId || null,
      room: snapshot,
    });
  } catch (error) {
    cb({ ok: false, error: 'failed_to_create_room' });
  }
}

function handleJoinRoom(socket, payload = {}, cb = () => {}) {
  try {
    const code = String(payload.code ?? payload.roomCode ?? '').trim().toUpperCase();
    const nick = safeName(payload.name ?? payload.nickname ?? 'Jogador');
    const charId = safeCharId(payload.charId ?? payload.selectedChar ?? 'strike');

    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'room_not_found' });
    if (room.started || room.starting) return cb({ ok: false, error: 'match_already_started' });
    if (room.players.length >= MAX_PLAYERS_PER_ROOM) return cb({ ok: false, error: 'room_full' });

    room.players = room.players.filter((p) => p.id !== socket.id);
    const sessionId = makeSessionId();
    room.players.push({
      id: socket.id,
      name: nick,
      charId,
      ready: false,
      score: 0,
      kills: 0,
      connected: true,
      sessionId,
    });

    socket.join(room.roomCode);
    socket.data.roomCode = room.roomCode;
    socket.data.roomSessionId = sessionId;
    socket.data.playerName = nick;
    socket.data.charId = charId;

    if (!room.hostId || !room.players.some((p) => p.id === room.hostId)) {
      room.hostId = socket.id;
    }

    const snapshot = roomSnapshot(room);
    emitRoomState(room);

    cb({
      ok: true,
      code: room.roomCode,
      roomCode: room.roomCode,
      sessionId,
      room: snapshot,
    });
  } catch (error) {
    cb({ ok: false, error: 'failed_to_join_room' });
  }
}

function handleLeaveRoom(socket, payload = {}, cb = () => {}) {
  const currentSessionId = socket.data?.roomSessionId || null;
  const requestedSessionId = String(payload?.sessionId || '').trim() || null;
  if (requestedSessionId && currentSessionId && requestedSessionId !== currentSessionId) {
    return cb({ ok: true, ignored: true });
  }

  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: true });

  const { room } = found;
  room.players = room.players.filter((p) => p.id !== socket.id);
  socket.leave(room.roomCode);
  socket.data.roomCode = null;
  socket.data.roomSessionId = null;
  socket.data.playerName = null;
  socket.data.charId = null;
  assignHost(room);

  if (room.players.length === 0) {
    stopTimer(room);
    rooms.delete(room.roomCode);
    cb({ ok: true, removed: true });
    return;
  }

  emitRoomState(room);
  cb({ ok: true, removed: true });
}

function handleSetReady(socket, payload = {}, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });

  const { room, player } = found;
  if (room.started || room.starting) return cb({ ok: false, error: 'match_already_started' });

  player.ready = !!payload.ready;
  emitRoomState(room);
  cb({ ok: true });
}

function handleRoomSettings(socket, payload = {}, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });

  const { room } = found;
  if (room.hostId !== socket.id) return cb({ ok: false, error: 'not_host' });
  if (room.started || room.starting) return cb({ ok: false, error: 'match_already_started' });

  const nextSettings = payload.settings && typeof payload.settings === 'object'
    ? payload.settings
    : payload;

  room.settings = normalizeSettings({
    ...room.settings,
    ...nextSettings,
  });

  emitRoomState(room);
  cb({ ok: true, settings: normalizeSettings(room.settings) });
}

function handleUpdateChar(socket, payload = {}, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });

  const { room, player } = found;
  const charId = safeCharId(payload.charId ?? payload.selectedChar ?? payload.id ?? player.charId);

  player.charId = charId;
  socket.data.charId = charId;

  emitRoomState(room);
  cb({ ok: true, charId });
}

function handleStartMatch(socket, _payload = {}, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });

  const { room } = found;
  if (room.hostId !== socket.id) return cb({ ok: false, error: 'not_host' });
  if (room.started || room.starting) return cb({ ok: false, error: 'already_started' });

  startMatch(room, cb);
}

function handleUpdateScore(socket, payload = {}, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });

  const { room, player } = found;
  if (!room.started) return cb({ ok: false, error: 'match_not_started' });

  const nextScore = Number(payload.score);
  const nextKills = Number(payload.kills);

  if (Number.isFinite(nextScore)) player.score = Math.max(0, Math.floor(nextScore));
  if (Number.isFinite(nextKills)) player.kills = Math.max(0, Math.floor(nextKills));

  emitRoomState(room);
  cb({ ok: true });
}

function handleRequestRoomState(socket, cb = () => {}) {
  const found = findRoomBySocket(socket.id);
  if (!found) return cb({ ok: false, error: 'not_in_room' });
  cb({ ok: true, room: roomSnapshot(found.room) });
}

function registerAlias(socket, names, handler) {
  for (const name of names) {
    socket.on(name, (payload, cb) => handler(socket, payload, cb));
  }
}

io.on('connection', (socket) => {
  socket.emit('server_ready', { ok: true, socketId: socket.id });

  registerAlias(socket, ['create_room', 'room:create'], handleCreateRoom);
  registerAlias(socket, ['join_room', 'room:join'], handleJoinRoom);
  registerAlias(socket, ['leave_room', 'room:leave'], handleLeaveRoom);
  registerAlias(socket, ['set_ready', 'player:ready'], handleSetReady);
  registerAlias(socket, ['start_match', 'room:start'], handleStartMatch);
  registerAlias(socket, ['update_score', 'score:update'], handleUpdateScore);
  registerAlias(socket, ['request_room_state', 'room:get', 'room:state'], handleRequestRoomState);
  registerAlias(socket, ['player:update_char', 'player:update-char'], handleUpdateChar);
  registerAlias(socket, ['room:settings', 'room_settings'], handleRoomSettings);

  socket.on('disconnect', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;

    const { room } = found;
    room.players = room.players.filter((p) => p.id !== socket.id);
    socket.data.roomSessionId = null;
    assignHost(room);

    if (room.players.length === 0) {
      stopTimer(room);
      rooms.delete(room.roomCode);
      return;
    }

    emitRoomState(room);
  });

  socket.on('match:reset', (_payload, cb = () => {}) => {
    const foundReset = findRoomBySocket(socket.id);
    if (!foundReset) return cb({ ok: false, error: 'not_in_room' });
    const { room } = foundReset;
    if (room.hostId !== socket.id) return cb({ ok: false, error: 'not_host' });
    resetMatch(room);
    cb({ ok: true });
  });
});

server.listen(PORT, () => {
  console.log(`Arena server running on port ${PORT}`);
});