// Back/server.js
// API HTTP protegida con Auth0 + PostgreSQL y servidor WebSocket en el mismo puerto.

require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { auth } = require("express-oauth2-jwt-bearer");
const { Pool } = require("pg");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 8080;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const LEVEL_THRESHOLDS = loadLevelThresholds();

if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
  throw new Error("AUTH0_DOMAIN y AUTH0_AUDIENCE son obligatorios para validar el JWT.");
}

const app = express();
const server = http.createServer(app);

function loadLevelThresholds() {
  try {
    const resolved = path.join(__dirname, "config", "levels.json");
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("config/levels.json no es un array; usando lista vacía.");
      return [];
    }
    return parsed
      .map((entry) => ({
        level: Number(entry.level) || 1,
        xp_to_reach: Number(entry.xp_to_reach) || 0,
      }))
      .sort((a, b) => a.xp_to_reach - b.xp_to_reach);
  } catch (err) {
    console.warn("No se pudieron cargar niveles desde config/levels.json:", err.message);
    return [];
  }
}

function computeLevelFromXp(xp, currentLevel = 1) {
  if (!Number.isInteger(xp) || xp < 0) return currentLevel;
  if (LEVEL_THRESHOLDS.length === 0) return Math.max(currentLevel, 1);
  let level = currentLevel;
  for (const entry of LEVEL_THRESHOLDS) {
    if (xp >= entry.xp_to_reach) {
      level = entry.level;
    } else {
      break;
    }
  }
  return level;
}

// Configuración de DB
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })
  : null;

async function ensureTables() {
  if (!pool) {
    console.warn("DATABASE_URL no configurado; las rutas protegidas fallarán hasta definirlo.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        auth0_id TEXT UNIQUE NOT NULL,
        email TEXT,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_progress (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        level INTEGER NOT NULL DEFAULT 1,
        xp INTEGER NOT NULL DEFAULT 0,
        coins INTEGER NOT NULL DEFAULT 0,
        gems INTEGER NOT NULL DEFAULT 0,
        troops_unlocked JSONB NOT NULL DEFAULT '[]'::jsonb,
        decks JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'player_progress' AND column_name = 'metal'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'player_progress' AND column_name = 'coins'
          ) THEN
            ALTER TABLE player_progress RENAME COLUMN metal TO coins;
          ELSE
            ALTER TABLE player_progress DROP COLUMN metal;
          END IF;
        END IF;
      END;
      $$;
    `);
    await client.query("COMMIT");
    console.log("Tablas users y player_progress listas.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creando tablas", err);
    throw err;
  } finally {
    client.release();
  }
}

function formatUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    auth0_id: row.auth0_id,
    email: row.email,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatProgress(row) {
  if (!row) return null;
  return {
    level: row.level,
    xp: row.xp,
    coins: row.coins,
    gems: row.gems,
    troops_unlocked: row.troops_unlocked || [],
    decks: row.decks || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function extractAuthData(authPayload) {
  const auth0Id = authPayload?.payload?.sub;
  if (!auth0Id) {
    throw new Error("Token sin sub (auth0_id).");
  }
  return {
    auth0Id,
    email: authPayload.payload.email || null,
    name: authPayload.payload.name || authPayload.payload.nickname || null,
  };
}

async function upsertUserAndProgress({ auth0Id, email, name }) {
  if (!pool) {
    throw new Error("DATABASE_URL no configurado.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      `
        INSERT INTO users (auth0_id, email, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (auth0_id) DO UPDATE
          SET email = COALESCE(EXCLUDED.email, users.email),
              name = COALESCE(EXCLUDED.name, users.name),
              updated_at = NOW()
        RETURNING *;
      `,
      [auth0Id, email, name]
    );
    const user = userResult.rows[0];

    const progressResult = await client.query(
      `
        INSERT INTO player_progress (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
        RETURNING *;
      `,
      [user.id]
    );

    let progressRow = progressResult.rows[0];
    if (!progressRow) {
      const existing = await client.query("SELECT * FROM player_progress WHERE user_id = $1", [user.id]);
      progressRow = existing.rows[0];
    }

    await client.query("COMMIT");
    return { user: formatUser(user), progress: formatProgress(progressRow) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function buildProgressUpdate(payload = {}) {
  const updates = {};

  const checkInt = (value, field) => {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`El campo ${field} debe ser entero >= 0`);
    }
  };

  if (payload.level !== undefined) {
    checkInt(payload.level, "level");
    updates.level = payload.level;
  }
  if (payload.xp !== undefined) {
    checkInt(payload.xp, "xp");
    updates.xp = payload.xp;
  }
  if (payload.coins !== undefined) {
    checkInt(payload.coins, "coins");
    updates.coins = payload.coins;
  }
  if (payload.gems !== undefined) {
    checkInt(payload.gems, "gems");
    updates.gems = payload.gems;
  }
  if (payload.troops_unlocked !== undefined) {
    if (!Array.isArray(payload.troops_unlocked)) {
      throw new Error("troops_unlocked debe ser un array");
    }
    updates.troops_unlocked = payload.troops_unlocked;
  }
  if (payload.decks !== undefined) {
    if (!Array.isArray(payload.decks)) {
      throw new Error("decks debe ser un array");
    }
    updates.decks = payload.decks;
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("Nada para actualizar en progreso.");
  }

  return updates;
}

async function applyProgressUpdate(userId, progressUpdate) {
  if (!pool) {
    throw new Error("DATABASE_URL no configurado.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM player_progress WHERE user_id = $1 FOR UPDATE", [userId]);
    const current = currentResult.rows[0];
    if (!current) {
      throw new Error("Progreso no encontrado para el usuario.");
    }

    const updates = { ...progressUpdate };
    const targetXp = updates.xp !== undefined ? updates.xp : current.xp;
    const computedLevel = computeLevelFromXp(targetXp, current.level);
    // Solo permitimos subir (o mantener) nivel; nunca bajar.
    updates.level = Math.max(computedLevel, current.level);

    const fields = [];
    const values = [userId];
    let idx = 2;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx += 1;
    }
    fields.push("updated_at = NOW()");

    const query = `UPDATE player_progress SET ${fields.join(", ")} WHERE user_id = $1 RETURNING *;`;
    const result = await client.query(query, values);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Middlewares base
app.use(
  cors({
    origin: CLIENT_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// Middleware JWT contra JWKS de Auth0
const jwtCheck = auth({
  audience: AUTH0_AUDIENCE,
  issuerBaseURL: `https://${AUTH0_DOMAIN}`,
  tokenSigningAlg: "RS256",
});

app.use(jwtCheck);

// Rutas protegidas
app.get("/me", async (req, res) => {
  try {
    const { auth0Id, email, name } = extractAuthData(req.auth);
    const result = await upsertUserAndProgress({ auth0Id, email, name });
    res.json(result);
  } catch (err) {
    console.error("Error en GET /me", err);
    res.status(500).json({ error: err.message || "Error interno" });
  }
});

app.patch("/me/progress", async (req, res) => {
  let user;
  try {
    const authData = extractAuthData(req.auth);
    const progressUpdate = buildProgressUpdate(req.body || {});
    const ensured = await upsertUserAndProgress(authData);
    user = ensured.user;

    const updatedProgress = await applyProgressUpdate(user.id, progressUpdate);
    res.json({ user, progress: formatProgress(updatedProgress) });
  } catch (err) {
    console.error("Error en PATCH /me/progress", err);
    res.status(400).json({ error: err.message || "Datos inválidos" });
  }
});

app.post("/me/migrate_guest", async (req, res) => {
  try {
    const authData = extractAuthData(req.auth);
    const guestProgress = req.body?.progress;
    if (!guestProgress || typeof guestProgress !== "object") {
      return res.status(400).json({ error: "progress requerido para migrar" });
    }
    const progressUpdate = buildProgressUpdate(guestProgress);
    const ensured = await upsertUserAndProgress(authData);
    const user = ensured.user;

    const updatedProgress = await applyProgressUpdate(user.id, progressUpdate);
    res.json({ user, progress: formatProgress(updatedProgress), migrated: true });
  } catch (err) {
    console.error("Error en POST /me/migrate_guest", err);
    res.status(400).json({ error: err.message || "Datos inválidos" });
  }
});

// --- Servidor WebSocket (reutiliza el mismo puerto HTTP) ---
const wss = new WebSocket.Server({ server });
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

    if (msg.type === "join") {
      const roomId = msg.room || "default-room";
      joinRoom(ws, roomId);
      const totalInRoom = rooms.get(roomId)?.size || 0;
      console.log(`[room:${roomId}] Cliente conectado. Total en sala: ${totalInRoom}`);
      return;
    }

    if (msg.type === "action" && ws.roomId) {
      broadcast(ws.roomId, JSON.stringify(msg), ws);
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });
});

// Inicio del servidor HTTP + WS
ensureTables()
  .catch((err) => {
    console.error("No se pudieron preparar las tablas", err);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`API escuchando en http://localhost:${PORT}`);
      console.log(`WS server activo en ws://localhost:${PORT}`);
    });
  });
