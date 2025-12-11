// Back/server.js
// Servidor WebSocket simple con salas por roomId

const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// roomId -> Set<WebSocket>
const rooms = new Map();

function joinRoom(ws, roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId).add(ws);
  ws.roomId = roomId;
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomId);
  if (room) {
    room.delete(ws);
    const remaining = room.size;
    if (remaining === 0) {
      rooms.delete(ws.roomId);
    }
    console.log(`[room:${ws.roomId || "unknown"}] Cliente desconectado. Restantes: ${remaining}`);
  }
}

function broadcast(roomId, data, excludeWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("Cliente conectado al WS");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Mensaje de union
    if (msg.type === "join") {
      const roomId = msg.room || "default-room";
      joinRoom(ws, roomId);
      const totalInRoom = rooms.get(roomId)?.size || 0;
      console.log(`[room:${roomId}] Cliente conectado. Total en sala: ${totalInRoom}`);
      return;
    }

    // Acciones de juego
    if (msg.type === "action" && ws.roomId) {
      broadcast(ws.roomId, JSON.stringify(msg), ws);
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });
});

console.log(`WS server listening on ws://localhost:${PORT}`);
