const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;
const MATCH_DURATION_MS = 5 * 60 * 1000;

app.get("/", (_req, res) => {
  res.status(200).send("Roguelite Legacy Arena backend online.");
});

const rooms = new Map(); // roomCode -> room object

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeUniqueRoomCode() {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  return code;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    ready: player.ready,
    score: player.score,
    kills: player.kills,
    connected: player.connected,
  };
}

function getRoomSnapshot(room) {
  return {
    code: room.code,
    status: room.status, // lobby | playing | finished
    hostId: room.hostId,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    timeLeftMs: room.endsAt ? Math.max(0, room.endsAt - Date.now()) : 0,
    players: Array.from(room.players.values()).map(publicPlayer),
    winner: room.winner || null,
  };
}

function emitRoomUpdate(room) {
  io.to(room.code).emit("room:update", getRoomSnapshot(room));
}

function startMatch(room) {
  if (room.status !== "lobby") return;
  if (room.players.size < 1) return;

  room.status = "playing";
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + MATCH_DURATION_MS;
  room.winner = null;

  for (const player of room.players.values()) {
    player.score = 0;
    player.kills = 0;
  }

  io.to(room.code).emit("match:start", {
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    durationMs: MATCH_DURATION_MS,
  });

  emitRoomUpdate(room);

  clearTimeout(room.matchTimeout);
  room.matchTimeout = setTimeout(() => {
    endMatch(room.code);
  }, MATCH_DURATION_MS + 100);
}

function endMatch(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== "playing") return;

  room.status = "finished";

  const players = Array.from(room.players.values());
  players.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.name.localeCompare(b.name);
  });

  const top = players[0] || null;
  room.winner = top
    ? {
        id: top.id,
        name: top.name,
        score: top.score,
        kills: top.kills,
      }
    : null;

  io.to(room.code).emit("match:end", {
    winner: room.winner,
    ranking: players.map((p, index) => ({
      position: index + 1,
      id: p.id,
      name: p.name,
      score: p.score,
      kills: p.kills,
    })),
  });

  emitRoomUpdate(room);
}

function ensureRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return null;
  return rooms.get(roomCode) || null;
}

function maybeDeleteRoom(room) {
  if (!room) return;
  if (room.players.size > 0) return;
  clearTimeout(room.matchTimeout);
  rooms.delete(room.code);
}

io.on("connection", (socket) => {
  socket.data.playerId = socket.id;
  socket.data.roomCode = null;
  socket.data.playerName = null;

  socket.emit("server:hello", {
    ok: true,
    socketId: socket.id,
  });

  socket.on("room:create", (payload, ack) => {
    try {
      const name = String(payload?.name || "Jogador").trim().slice(0, 20) || "Jogador";
      const code = makeUniqueRoomCode();

      const room = {
        code,
        hostId: socket.id,
        status: "lobby",
        createdAt: Date.now(),
        startedAt: null,
        endsAt: null,
        winner: null,
        matchTimeout: null,
        players: new Map(),
      };

      room.players.set(socket.id, {
        id: socket.id,
        name,
        ready: false,
        score: 0,
        kills: 0,
        connected: true,
      });

      rooms.set(code, room);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerName = name;

      const snapshot = getRoomSnapshot(room);

      if (typeof ack === "function") {
        ack({ ok: true, room: snapshot, code });
      }

      io.to(code).emit("room:update", snapshot);
    } catch (err) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Falha ao criar sala." });
      }
    }
  });

  socket.on("room:join", (payload, ack) => {
    try {
      const code = String(payload?.code || "").trim().toUpperCase();
      const name = String(payload?.name || "Jogador").trim().slice(0, 20) || "Jogador";
      const room = rooms.get(code);

      if (!room) {
        if (typeof ack === "function") ack({ ok: false, error: "Sala não encontrada." });
        return;
      }

      if (room.status === "playing") {
        if (typeof ack === "function") ack({ ok: false, error: "Partida em andamento." });
        return;
      }

      const existing = room.players.get(socket.id);
      if (existing) {
        existing.name = name;
        existing.connected = true;
      } else {
        room.players.set(socket.id, {
          id: socket.id,
          name,
          ready: false,
          score: 0,
          kills: 0,
          connected: true,
        });
      }

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerName = name;

      if (!room.hostId || !room.players.has(room.hostId)) {
        room.hostId = socket.id;
      }

      if (typeof ack === "function") {
        ack({ ok: true, room: getRoomSnapshot(room), code });
      }

      emitRoomUpdate(room);
    } catch (err) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Falha ao entrar na sala." });
      }
    }
  });

  socket.on("room:leave", (_payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: true });
      return;
    }

    socket.leave(room.code);

    room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const nextHost = room.players.values().next().value;
      room.hostId = nextHost ? nextHost.id : null;
    }

    socket.data.roomCode = null;

    if (typeof ack === "function") ack({ ok: true });

    emitRoomUpdate(room);
    maybeDeleteRoom(room);
  });

  socket.on("player:ready", (payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false, error: "Sem sala." });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      if (typeof ack === "function") ack({ ok: false, error: "Jogador não encontrado." });
      return;
    }

    if (room.status !== "lobby") {
      if (typeof ack === "function") ack({ ok: false, error: "Partida já começou." });
      return;
    }

    player.ready = Boolean(payload?.ready);
    if (typeof ack === "function") ack({ ok: true, ready: player.ready });

    emitRoomUpdate(room);
  });

  socket.on("room:start", (_payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false, error: "Sem sala." });
      return;
    }

    if (room.hostId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, error: "Só o host inicia." });
      return;
    }

    if (room.status !== "lobby") {
      if (typeof ack === "function") ack({ ok: false, error: "Sala já iniciou." });
      return;
    }

    const players = Array.from(room.players.values());
    if (players.length < 1) {
      if (typeof ack === "function") ack({ ok: false, error: "Sala vazia." });
      return;
    }

    startMatch(room);

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("score:update", (payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false });
      return;
    }

    if (room.status !== "playing") {
      if (typeof ack === "function") ack({ ok: false, error: "Partida não está ativa." });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      if (typeof ack === "function") ack({ ok: false });
      return;
    }

    const score = Number(payload?.score);
    const kills = Number(payload?.kills);

    if (Number.isFinite(score)) player.score = Math.max(0, Math.floor(score));
    if (Number.isFinite(kills)) player.kills = Math.max(0, Math.floor(kills));

    if (typeof ack === "function") ack({ ok: true });

    emitRoomUpdate(room);
  });

  socket.on("score:add", (payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false });
      return;
    }

    if (room.status !== "playing") {
      if (typeof ack === "function") ack({ ok: false, error: "Partida não está ativa." });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      if (typeof ack === "function") ack({ ok: false });
      return;
    }

    const points = Number(payload?.points || 0);
    const kills = Number(payload?.kills || 0);

    if (Number.isFinite(points)) player.score += Math.max(0, Math.floor(points));
    if (Number.isFinite(kills)) player.kills += Math.max(0, Math.floor(kills));

    if (typeof ack === "function") ack({ ok: true, score: player.score, kills: player.kills });

    emitRoomUpdate(room);
  });

  socket.on("room:get", (_payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false, error: "Sem sala." });
      return;
    }

    if (typeof ack === "function") {
      ack({ ok: true, room: getRoomSnapshot(room) });
    }
  });

  socket.on("match:reset", (_payload, ack) => {
    const room = ensureRoom(socket);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false });
      return;
    }

    if (room.hostId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, error: "Só o host reseta." });
      return;
    }

    clearTimeout(room.matchTimeout);

    room.status = "lobby";
    room.startedAt = null;
    room.endsAt = null;
    room.winner = null;

    for (const player of room.players.values()) {
      player.ready = false;
      player.score = 0;
      player.kills = 0;
    }

    if (typeof ack === "function") ack({ ok: true });

    emitRoomUpdate(room);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const nextHost = room.players.values().next().value;
      room.hostId = nextHost ? nextHost.id : null;
    }

    emitRoomUpdate(room);
    maybeDeleteRoom(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status === "playing" && room.endsAt) {
      const remaining = room.endsAt - Date.now();
      if (remaining <= 0) {
        endMatch(room.code);
      } else {
        io.to(room.code).emit("match:tick", {
          endsAt: room.endsAt,
          timeLeftMs: remaining,
        });
      }
    }
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`Arena backend online on port ${PORT}`);
});