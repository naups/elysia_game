import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import crypto from "crypto";
import pool from "./database.js";
import "dotenv/config";

// ═══════════════════════════════════════════════════════════════════
//  IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════

// Map<roomCode, Set<{ws, userId, username}>>
const roomConnections = new Map();
// Map<roomCode, { timer, questionOrder, delaySeconds, advanceAt, gameOver }>
const roomAdvanceTimers = new Map();
// Map<roomCode, { timer, questionOrder, expiresAt }>
const roomQuestionTimers = new Map();
// Map<token, { userId, expiresAt }>
const activeSessions = new Map();
// Map<socketId, { userId, username, roomCode }>
const socketStates = new Map();
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,50}$/;
const DEFAULT_ROOM_SETTINGS = {
  max_players: 6,
  question_count: 5,
  question_source: "database",
  question_mode: "same_for_all",
  result_mode: "instant",
  question_delay_seconds: 10,
  time_per_question_seconds: 0,
  room_idle_timeout_seconds: 1800,
  custom_questions: [],
};

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getAvatarUrl(username) {
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(username)}`;
}

function getBearerToken(headers) {
  return headers["authorization"]?.replace(/^Bearer\s+/i, "") || "";
}

// ═══════════════════════════════════════════════════════════════════
//  ZERO-DEPENDENCY JWT (Node crypto, no external libs)
// ═══════════════════════════════════════════════════════════════════

function base64UrlEncode(strOrObj) {
  const str =
    typeof strOrObj === "string" ? strOrObj : JSON.stringify(strOrObj);
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64").toString("utf8");
}

function signJwt(payload, secret, expiresInStr = "15m") {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  let exp = now + 15 * 60;
  const match = expiresInStr.match(/^(\d+)([mdh])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    if (unit === "m") exp = now + val * 60;
    else if (unit === "h") exp = now + val * 3600;
    else if (unit === "d") exp = now + val * 86400;
  }

  const fullPayload = { ...payload, iat: now, exp };
  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(fullPayload);
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(signatureInput)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signatureInput}.${signature}`;
}

function verifyJwt(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(signatureInput)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    if (signature !== expectedSignature) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp)
      return null;
    return payload;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  RATE LIMITER (in-memory, per IP)
// ═══════════════════════════════════════════════════════════════════

const rateLimitStore = new Map();

function checkRateLimit(ip, limit = 5, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, [now]);
    return true;
  }
  const timestamps = rateLimitStore.get(ip).filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  rateLimitStore.set(ip, timestamps);
  return true;
}

function getSecureAuthEnabled() {
  return process.env.ENABLE_SECURE_AUTH === "true";
}

function getJwtAccessSecret() {
  return process.env.JWT_ACCESS_SECRET || "change-me-access-secret";
}

function getJwtRefreshSecret() {
  return process.env.JWT_REFRESH_SECRET || "change-me-refresh-secret";
}

function getAccessTokenExpiresIn() {
  return process.env.ACCESS_TOKEN_EXPIRES_IN || "15m";
}

function getRefreshTokenExpiresIn() {
  return process.env.REFRESH_TOKEN_EXPIRES_IN || "7d";
}

function getSocketId(ws) {
  return ws.raw ?? ws.id ?? ws.data?.id;
}

function getSocketState(ws) {
  const socketId = getSocketId(ws);
  let state = socketStates.get(socketId);
  if (!state) {
    state = ws.data?.socketState || {};
    socketStates.set(socketId, state);
  }
  if (ws.data) ws.data.socketState = state;
  return state;
}

function removeSocketFromRoom(ws) {
  const socketId = getSocketId(ws);
  const state = getSocketState(ws);
  const code = state?.roomCode;
  if (!code || !roomConnections.has(code)) return null;

  const conns = roomConnections.get(code);
  for (const conn of conns) {
    if (
      conn.socketId === socketId ||
      (state.userId && conn.userId === state.userId)
    ) {
      conns.delete(conn);
      break;
    }
  }
  if (conns.size === 0) roomConnections.delete(code);

  state.roomCode = null;
  return { code, userId: state.userId };
}

async function authenticateSocketState(ws, token) {
  const state = getSocketState(ws);
  if (state.userId) return state;
  if (!token) return state;

  const userId = await validateSession(token);
  if (!userId) return state;

  const user = await getUser(userId);
  state.userId = userId;
  state.username = user?.username;
  return state;
}

function isValidUsername(username) {
  return typeof username === "string" && USERNAME_PATTERN.test(username.trim());
}

function normalizeAnswer(answer) {
  return String(answer || "")
    .trim()
    .toLowerCase();
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function getQuestionDelaySeconds(settings = {}) {
  return clampInteger(
    settings?.question_delay_seconds ?? settings?.questionDelaySeconds,
    0,
    60,
    DEFAULT_ROOM_SETTINGS.question_delay_seconds,
  );
}

function getTimePerQuestionSeconds(settings = {}) {
  return clampInteger(
    settings?.time_per_question_seconds ?? settings?.timePerQuestion,
    0,
    300,
    DEFAULT_ROOM_SETTINGS.time_per_question_seconds,
  );
}

function getRoomIdleTimeoutSeconds(settings = {}) {
  return clampInteger(
    settings?.room_idle_timeout_seconds ?? settings?.roomIdleTimeoutSeconds,
    0,
    86400,
    DEFAULT_ROOM_SETTINGS.room_idle_timeout_seconds,
  );
}

function withDefaultRoomSettings(settings = {}) {
  const merged = { ...DEFAULT_ROOM_SETTINGS, ...(settings || {}) };
  merged.question_delay_seconds = getQuestionDelaySeconds(merged);
  merged.time_per_question_seconds = getTimePerQuestionSeconds(merged);
  merged.room_idle_timeout_seconds = getRoomIdleTimeoutSeconds(merged);
  if (!Array.isArray(merged.custom_questions)) merged.custom_questions = [];
  return merged;
}

function clearRoomAdvanceTimer(roomCode) {
  const pending = roomAdvanceTimers.get(roomCode.toUpperCase());
  if (!pending) return;
  clearTimeout(pending.timer);
  roomAdvanceTimers.delete(roomCode.toUpperCase());
}

function clearRoomQuestionTimer(roomCode) {
  const pending = roomQuestionTimers.get(roomCode.toUpperCase());
  if (!pending) return;
  clearTimeout(pending.timer);
  roomQuestionTimers.delete(roomCode.toUpperCase());
}

function getPendingRoomTransition(roomCode, questionOrder) {
  const pending = roomAdvanceTimers.get(roomCode.toUpperCase());
  if (!pending || pending.questionOrder !== questionOrder) return null;
  return {
    questionNumber: pending.questionOrder,
    nextQuestionNumber: pending.gameOver ? null : pending.questionOrder + 1,
    delaySeconds: pending.delaySeconds,
    advanceAt: pending.advanceAt,
    gameOver: pending.gameOver,
  };
}

function hasQuestionTimeExpired(room, settings, now = Date.now()) {
  const timeLimit = settings?.time_per_question_seconds || 0;
  if (!timeLimit || !room?.current_question_started_at) return false;

  const startedAt = Date.parse(room.current_question_started_at);
  if (!Number.isFinite(startedAt)) return false;

  return now >= startedAt + timeLimit * 1000;
}

async function rollbackAndReturn(client, response) {
  await client.query("ROLLBACK").catch(() => {});
  return response;
}

function normalizeQuestionType(type) {
  return ["multiple_choice", "true_false", "fill_blank"].includes(type)
    ? type
    : "multiple_choice";
}

function formatQuestionOptions(type, options) {
  if (type === "true_false") return ["True", "False"];
  if (type === "fill_blank") return [];
  return Array.isArray(options) ? options : [];
}

function normalizeCustomQuestions(questions) {
  if (!Array.isArray(questions)) return [];

  return questions
    .map((question) => {
      const type = normalizeQuestionType(
        question?.type || question?.question_type,
      );
      const correctAnswer =
        typeof question?.correct_answer === "string"
          ? question.correct_answer.trim()
          : "";
      const normalized = {
        text: typeof question?.text === "string" ? question.text.trim() : "",
        type,
        options: formatQuestionOptions(
          type,
          Array.isArray(question?.options)
            ? question.options
                .map((option) => String(option).trim())
                .filter(Boolean)
            : [],
        ),
        correct_answer: correctAnswer,
      };

      if (type === "true_false") {
        normalized.correct_answer =
          normalizeAnswer(correctAnswer) === "false" ? "False" : "True";
      }

      return normalized;
    })
    .filter((question) => {
      if (!question.text || !question.correct_answer) return false;
      if (question.type === "fill_blank") return true;
      return (
        question.options.length >= 2 &&
        question.options.some(
          (option) =>
            normalizeAnswer(option) ===
            normalizeAnswer(question.correct_answer),
        )
      );
    });
}

function normalizeRoomSettings(body = {}) {
  const customQuestions = normalizeCustomQuestions(body?.customQuestions);
  const questionSource =
    body?.questionSource === "custom" && customQuestions.length > 0
      ? "custom"
      : "database";
  const questionCount =
    questionSource === "custom"
      ? customQuestions.length
      : clampInteger(
          body?.questionCount,
          1,
          20,
          DEFAULT_ROOM_SETTINGS.question_count,
        );

  return {
    max_players: clampInteger(
      body?.maxPlayers,
      2,
      10,
      DEFAULT_ROOM_SETTINGS.max_players,
    ),
    question_count: questionCount,
    question_source: questionSource,
    question_mode:
      body?.questionMode === "random_per_player"
        ? "random_per_player"
        : DEFAULT_ROOM_SETTINGS.question_mode,
    result_mode:
      body?.resultMode === "end" ? "end" : DEFAULT_ROOM_SETTINGS.result_mode,
    question_delay_seconds: getQuestionDelaySeconds(body),
    time_per_question_seconds: getTimePerQuestionSeconds(body),
    room_idle_timeout_seconds: getRoomIdleTimeoutSeconds(body),
    custom_questions: customQuestions,
  };
}

async function ensureDatabaseShape() {
  const statements = [
    "CREATE EXTENSION IF NOT EXISTS pgcrypto",
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_question_order INTEGER DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_question_started_at TIMESTAMPTZ",
    "ALTER TABLE rooms ALTER COLUMN current_question_started_at TYPE TIMESTAMPTZ USING current_question_started_at AT TIME ZONE 'UTC'",
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW()",
    "UPDATE rooms SET last_activity_at = COALESCE(last_activity_at, created_at AT TIME ZONE 'UTC', NOW()) WHERE last_activity_at IS NULL",
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_type VARCHAR(20) DEFAULT 'multiple_choice'",
    "ALTER TABLE room_players ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0",
    "ALTER TABLE room_questions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
    "ALTER TABLE room_answers ADD COLUMN IF NOT EXISTS question_order INTEGER",
    "UPDATE room_answers SET question_order = COALESCE(question_order, question_id, 0) WHERE question_order IS NULL",
    "ALTER TABLE room_answers ALTER COLUMN question_order SET NOT NULL",
    `UPDATE rooms
     SET settings = settings || '{"question_delay_seconds": 10}'::jsonb
     WHERE NOT (settings ? 'question_delay_seconds')`,
    `UPDATE rooms
     SET settings = settings || '{"time_per_question_seconds": 0}'::jsonb
     WHERE NOT (settings ? 'time_per_question_seconds')`,
    `UPDATE rooms
     SET settings = settings || '{"room_idle_timeout_seconds": 1800}'::jsonb
     WHERE NOT (settings ? 'room_idle_timeout_seconds')`,
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP",
  ];

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      console.error("Database shape check skipped:", error.message);
    }
  }
}

await ensureDatabaseShape();

async function validateSession(token) {
  if (!token) return null;

  // Secure JWT flow
  if (getSecureAuthEnabled()) {
    const payload = verifyJwt(token, getJwtAccessSecret());
    return payload ? payload.userId : null;
  }

  // Legacy: database token flow
  // Check in-memory cache first
  const cached = activeSessions.get(token);
  if (cached) {
    if (cached.expiresAt <= Date.now()) activeSessions.delete(token);
  }
  // Check database
  const result = await pool.query(
    `SELECT user_id, expires_at FROM sessions WHERE token = $1 AND expires_at > NOW()`,
    [token],
  );
  if (result.rows.length > 0) {
    const session = result.rows[0];
    activeSessions.set(token, {
      userId: session.user_id,
      expiresAt: new Date(session.expires_at).getTime(),
    });
    return session.user_id;
  }
  return null;
}

async function getUser(userId) {
  const result = await pool.query(
    "SELECT id, username, total_score FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0] || null;
}

async function isRoomMember(roomId, userId) {
  const result = await pool.query(
    "SELECT 1 FROM room_players WHERE room_id = $1 AND user_id = $2",
    [roomId, userId],
  );
  return result.rows.length > 0;
}

async function broadcastToRoom(roomCode, message, excludeWs = null) {
  const connections = roomConnections.get(roomCode);
  if (!connections) return;
  const data = JSON.stringify(message);
  const excludedSocketId = excludeWs ? getSocketId(excludeWs) : null;
  for (const conn of connections) {
    if (conn.socketId !== excludedSocketId && conn.ws.readyState === 1) {
      conn.ws.send(data);
    }
  }
}

function clearRoomRuntimeState(roomCode) {
  const code = roomCode.toUpperCase();
  clearRoomAdvanceTimer(code);
  clearRoomQuestionTimer(code);

  const connections = roomConnections.get(code);
  if (connections) {
    for (const conn of connections) {
      const state = socketStates.get(conn.socketId);
      if (state?.roomCode === code) state.roomCode = null;
    }
  }
  roomConnections.delete(code);
}

async function destroyRoomSession(room, reason = "deleted") {
  const code = room.code.toUpperCase();
  await broadcastToRoom(code, {
    type: "room_deleted",
    roomCode: code,
    reason,
  });
  await pool.query("DELETE FROM rooms WHERE id = $1", [room.id]);
  clearRoomRuntimeState(code);
}

async function cleanupExpiredWaitingRooms() {
  const expired = await pool.query(
    `SELECT id, code
     FROM (
       SELECT id,
              code,
              COALESCE(
                CASE
                  WHEN settings ? 'room_idle_timeout_seconds'
                  THEN NULLIF(settings->>'room_idle_timeout_seconds', '')::integer
                END,
                $1
              ) AS idle_timeout_seconds,
              COALESCE(last_activity_at, created_at AT TIME ZONE 'UTC', NOW()) AS last_activity
       FROM rooms
       WHERE status = 'waiting'
     ) waiting_rooms
     WHERE idle_timeout_seconds > 0
       AND last_activity <= NOW() - (idle_timeout_seconds * INTERVAL '1 second')`,
    [DEFAULT_ROOM_SETTINGS.room_idle_timeout_seconds],
  );

  if (expired.rows.length === 0) return [];

  for (const room of expired.rows) {
    await broadcastToRoom(room.code, {
      type: "room_deleted",
      roomCode: room.code,
      reason: "idle_timeout",
    });
  }

  const deleted = await pool.query(
    "DELETE FROM rooms WHERE id = ANY($1::uuid[]) RETURNING code",
    [expired.rows.map((room) => room.id)],
  );

  for (const room of deleted.rows) clearRoomRuntimeState(room.code);
  return deleted.rows.map((room) => room.code);
}

async function touchRoomActivity(roomId) {
  await pool.query(
    "UPDATE rooms SET last_activity_at = NOW() WHERE id = $1 AND status = 'waiting'",
    [roomId],
  );
}

async function touchRoomActivityByCode(roomCode) {
  await pool.query(
    "UPDATE rooms SET last_activity_at = NOW() WHERE code = $1 AND status = 'waiting'",
    [roomCode.toUpperCase()],
  );
}

async function findRoomByCode(roomCode) {
  await cleanupExpiredWaitingRooms();
  const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
    roomCode.toUpperCase(),
  ]);
  return roomResult.rows[0] || null;
}

async function getRoomState(roomCode) {
  const room = await findRoomByCode(roomCode);
  if (!room) return null;

  const playersResult = await pool.query(
    `SELECT rp.user_id, rp.is_ready, rp.score, rp.streak, u.username
     FROM room_players rp
     JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1
     ORDER BY rp.joined_at`,
    [room.id],
  );

  return {
    code: room.code,
    masterId: room.master_id,
    settings: withDefaultRoomSettings(room.settings),
    status: room.status,
    currentQuestionOrder: room.current_question_order || 0,
    players: playersResult.rows.map((p) => ({
      userId: p.user_id,
      username: p.username,
      avatar: getAvatarUrl(p.username),
      isReady: p.is_ready,
      score: p.score,
      streak: p.streak || 0,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  APP SETUP
// ═══════════════════════════════════════════════════════════════════

async function buildRoomLeaderboard(roomId, currentUserId) {
  const standings = await pool.query(
    `SELECT rp.user_id, rp.score, rp.streak, u.username
     FROM room_players rp
     JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1
     ORDER BY rp.score DESC, rp.joined_at ASC`,
    [roomId],
  );

  return standings.rows.map((player, index) => ({
    rank: index + 1,
    userId: player.user_id,
    username: player.username,
    avatar: getAvatarUrl(player.username),
    score: player.score,
    streak: player.streak || 0,
    isCurrentUser: player.user_id === currentUserId,
  }));
}

const app = new Elysia()
  .use(cors())
  .use(
    staticPlugin({
      assets: "./public",
      prefix: "/",
      index: "index.html",
    }),
  )
  .onError(({ code, error }) => {
    console.error(`[${code}] Server Error:`, error?.message || error);
    return new Response(
      JSON.stringify({
        success: false,
        message: error?.message || "Internal Server Error",
      }),
      {
        status: code === "NOT_FOUND" ? 404 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  });

// Serve index.html at root
app.get("/", () => {
  return new Response(Bun.file("./public/index.html"), {
    headers: { "Content-Type": "text/html" },
  });
});

// ═══════════════════════════════════════════════════════════════════
//  AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// Register + Login (returns token)
app.post("/api/register", async ({ body }) => {
  const username = body?.username?.trim();

  if (!isValidUsername(username)) {
    return {
      success: false,
      message:
        "Username must be at least 2 characters, at most 50 characters, and use only letters, numbers, underscores, or hyphens",
    };
  }

  try {
    const existingUser = await pool.query(
      "SELECT id, username, total_score FROM users WHERE username = $1",
      [username],
    );

    let user;
    if (existingUser.rows.length > 0) {
      // User exists — treat as login
      user = existingUser.rows[0];
    } else {
      // Create new user
      const result = await pool.query(
        "INSERT INTO users (username) VALUES ($1) RETURNING id, username, total_score",
        [username],
      );
      user = result.rows[0];
    }

    // Create session token (expires in 24 hours)
    const token = generateToken();
    await pool.query(
      "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
      [user.id, token],
    );
    activeSessions.set(token, {
      userId: user.id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    return {
      success: true,
      user: { ...user, avatar: getAvatarUrl(user.username) },
      token,
    };
  } catch (error) {
    console.error("Register error:", error.message);
    return { success: false, message: "Failed to register user" };
  }
});

// ═══════════════════════════════════════════════════════════════════
//  SECURE AUTH ENDPOINTS (enabled by ENABLE_SECURE_AUTH=true)
// ═══════════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post("/api/auth/register", async ({ body, headers, set }) => {
  if (!getSecureAuthEnabled()) {
    set.status = 503;
    return { success: false, message: "Secure authentication is disabled" };
  }

  const ip = headers["x-forwarded-for"] || "127.0.0.1";
  if (!checkRateLimit(ip, 5, 60000)) {
    set.status = 429;
    return { success: false, message: "Too many requests" };
  }

  const { username, email, password } = body || {};

  if (!username || username.length < 3 || !USERNAME_PATTERN.test(username)) {
    set.status = 400;
    return { success: false, message: "Invalid username" };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    set.status = 400;
    return { success: false, message: "Invalid email" };
  }
  if (
    !password ||
    password.length < 8 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    set.status = 400;
    return {
      success: false,
      message:
        "Password must be at least 8 characters and contain uppercase, lowercase, and a number",
    };
  }

  try {
    const existing = await pool.query(
      "SELECT id, username, email FROM users WHERE username = $1 OR email = $2",
      [username, email],
    );
    if (existing.rows.length > 0) {
      set.status = 400;
      return { success: false, message: "Username or email already exists" };
    }

    const cost = parseInt(process.env.PASSWORD_HASH_COST || "12");
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "bcrypt",
      cost,
    });

    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash, auth_provider) VALUES ($1, $2, $3, 'local') RETURNING id, username, email, created_at",
      [username, email, passwordHash],
    );

    set.status = 201;
    return { success: true, user: result.rows[0] };
  } catch (error) {
    console.error("Auth register error:", error.message);
    set.status = 500;
    return { success: false, message: "Internal server error" };
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async ({ body, headers, set }) => {
  if (!getSecureAuthEnabled()) {
    set.status = 503;
    return { success: false, message: "Secure authentication is disabled" };
  }

  const ip = headers["x-forwarded-for"] || "127.0.0.1";
  if (!checkRateLimit(ip, 10, 60000)) {
    set.status = 429;
    return { success: false, message: "Too many requests" };
  }

  const { login, password } = body || {};
  if (!login || !password) {
    set.status = 400;
    return { success: false, message: "Login and password are required" };
  }

  try {
    const result = await pool.query(
      "SELECT id, username, email, password_hash FROM users WHERE (username = $1 OR email = $1) AND password_hash IS NOT NULL",
      [login],
    );
    if (result.rows.length === 0) {
      set.status = 401;
      return { success: false, message: "Invalid credentials" };
    }

    const user = result.rows[0];
    const valid = await Bun.password.verify(password, user.password_hash);
    if (!valid) {
      set.status = 401;
      return { success: false, message: "Invalid credentials" };
    }

    // Update last login
    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
      user.id,
    ]);

    const accessToken = signJwt(
      { userId: user.id },
      getJwtAccessSecret(),
      getAccessTokenExpiresIn(),
    );
    const refreshToken = signJwt(
      { userId: user.id, type: "refresh" },
      getJwtRefreshSecret(),
      getRefreshTokenExpiresIn(),
    );

    return {
      success: true,
      user: { id: user.id, username: user.username, email: user.email },
      accessToken,
      refreshToken,
    };
  } catch (error) {
    console.error("Auth login error:", error.message);
    set.status = 500;
    return { success: false, message: "Internal server error" };
  }
});

// POST /api/auth/refresh
app.post("/api/auth/refresh", async ({ body, set }) => {
  if (!getSecureAuthEnabled()) {
    set.status = 503;
    return { success: false, message: "Secure authentication is disabled" };
  }

  const { refreshToken } = body || {};
  if (!refreshToken) {
    set.status = 400;
    return { success: false, message: "Refresh token required" };
  }

  const payload = verifyJwt(refreshToken, getJwtRefreshSecret());
  if (!payload || payload.type !== "refresh") {
    set.status = 401;
    return { success: false, message: "Invalid refresh token" };
  }

  const user = await getUser(payload.userId);
  if (!user) {
    set.status = 401;
    return { success: false, message: "User not found" };
  }

  const accessToken = signJwt(
    { userId: user.id },
    getJwtAccessSecret(),
    getAccessTokenExpiresIn(),
  );
  const newRefreshToken = signJwt(
    { userId: user.id, type: "refresh" },
    getJwtRefreshSecret(),
    getRefreshTokenExpiresIn(),
  );

  return { success: true, accessToken, refreshToken: newRefreshToken };
});

// GET /api/auth/me
app.get("/api/auth/me", async ({ headers, set }) => {
  if (!getSecureAuthEnabled()) {
    set.status = 503;
    return { success: false, message: "Secure authentication is disabled" };
  }

  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) {
    set.status = 401;
    return { success: false, message: "Unauthorized" };
  }

  const user = await pool.query(
    "SELECT id, username, email, total_score, created_at, last_login_at FROM users WHERE id = $1",
    [userId],
  );
  if (user.rows.length === 0) {
    set.status = 404;
    return { success: false, message: "User not found" };
  }

  return { success: true, user: user.rows[0] };
});

// Logout
app.post("/api/logout", async ({ headers }) => {
  const token = getBearerToken(headers);
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    activeSessions.delete(token);
  }
  return { success: true };
});

// Validate session
app.get("/api/auth/validate", async ({ headers }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) {
    return { success: false, message: "Invalid or expired session" };
  }
  const user = await getUser(userId);
  if (!user) {
    return { success: false, message: "User not found" };
  }
  return {
    success: true,
    user: { ...user, avatar: getAvatarUrl(user.username) },
  };
});

// ═══════════════════════════════════════════════════════════════════
//  QUESTION ENDPOINTS (protected)
// ═══════════════════════════════════════════════════════════════════

async function getRandomQuestions(userId, count = 1) {
  const result = await pool.query(
    `SELECT * FROM questions
     WHERE id NOT IN (
       SELECT question_id FROM game_history WHERE user_id = $1
     )
     ORDER BY RANDOM() LIMIT $2`,
    [userId, count],
  );
  return result.rows;
}

app.get("/api/questions/next", async ({ headers }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const userResult = await pool.query(
      "SELECT total_score FROM users WHERE id = $1",
      [userId],
    );
    if (userResult.rows.length === 0)
      return { success: false, message: "User not found" };

    const currentScore = userResult.rows[0].total_score;
    const questions = await getRandomQuestions(userId, 1);
    if (questions.length === 0)
      return { success: false, message: "No questions available" };

    const question = questions[0];
    const options =
      typeof question.options === "string"
        ? JSON.parse(question.options)
        : question.options;

    return {
      success: true,
      question: {
        id: question.id,
        text: question.question_text,
        options,
        type: question.question_type || "multiple_choice",
      },
      currentScore,
    };
  } catch (error) {
    console.error("Get question error:", error.message);
    return { success: false, message: "Failed to get question" };
  }
});

app.post("/api/answer", async ({ headers, body }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { questionId, userAnswer } = body || {};
  if (!questionId || typeof userAnswer !== "string" || !userAnswer.trim()) {
    return { success: false, message: "Missing required fields" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE game_history IN SHARE ROW EXCLUSIVE MODE");

    const questionResult = await client.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [questionId],
    );
    if (questionResult.rows.length === 0)
      return rollbackAndReturn(client, {
        success: false,
        message: "Question not found",
      });

    const correctAnswer = questionResult.rows[0].correct_answer;
    const isCorrect =
      normalizeAnswer(userAnswer) === normalizeAnswer(correctAnswer);
    const points = isCorrect ? 10 : 0;

    const existingAnswer = await client.query(
      "SELECT is_correct FROM game_history WHERE user_id = $1 AND question_id = $2 LIMIT 1",
      [userId, questionId],
    );
    if (existingAnswer.rows.length > 0) {
      const userResult = await client.query(
        "SELECT total_score FROM users WHERE id = $1",
        [userId],
      );
      await client.query("COMMIT");

      return {
        success: true,
        isDuplicate: true,
        isNewScore: false,
        score: userResult.rows[0]?.total_score || 0,
        correctAnswer,
        isCorrect: existingAnswer.rows[0].is_correct,
      };
    }

    await client.query(
      "INSERT INTO game_history (user_id, question_id, is_correct) VALUES ($1, $2, $3)",
      [userId, questionId, isCorrect],
    );
    await client.query(
      "UPDATE users SET total_score = total_score + $1 WHERE id = $2",
      [points, userId],
    );

    const userResult = await client.query(
      "SELECT total_score FROM users WHERE id = $1",
      [userId],
    );
    const newScore = userResult.rows[0]?.total_score || 0;
    await client.query("COMMIT");

    return {
      success: true,
      isDuplicate: false,
      isNewScore: isCorrect,
      score: newScore,
      correctAnswer,
      isCorrect,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Answer error:", error.message);
    return { success: false, message: "Failed to submit answer" };
  } finally {
    client.release();
  }
});

app.get("/api/score/:userId", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };
  if (userId !== params.userId) return { success: false, message: "Forbidden" };

  try {
    const result = await pool.query(
      "SELECT id, username, total_score FROM users WHERE id = $1",
      [params.userId],
    );
    if (result.rows.length === 0)
      return { success: false, message: "User not found" };
    return {
      success: true,
      user: {
        ...result.rows[0],
        avatar: getAvatarUrl(result.rows[0].username),
      },
    };
  } catch (error) {
    console.error("Get score error:", error.message);
    return { success: false, message: "Failed to get score" };
  }
});

app.get("/api/history/:userId", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };
  if (userId !== params.userId) return { success: false, message: "Forbidden" };

  try {
    const result = await pool.query(
      `SELECT gh.*, q.question_text, q.correct_answer
       FROM game_history gh
       JOIN questions q ON gh.question_id = q.id
       WHERE gh.user_id = $1
       ORDER BY gh.created_at DESC LIMIT 20`,
      [params.userId],
    );
    return { success: true, history: result.rows };
  } catch (error) {
    console.error("Get history error:", error.message);
    return { success: false, message: "Failed to get history" };
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROOM ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// Create room
app.post("/api/rooms", async ({ headers, body }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const settings = normalizeRoomSettings(body);

  try {
    await cleanupExpiredWaitingRooms();
    const code = generateRoomCode();
    const result = await pool.query(
      `INSERT INTO rooms (code, master_id, settings) VALUES ($1, $2, $3) RETURNING *`,
      [code, userId, JSON.stringify(settings)],
    );
    const room = result.rows[0];

    // Master auto-joins as first player
    await pool.query(
      "INSERT INTO room_players (room_id, user_id, is_ready) VALUES ($1, $2, true)",
      [room.id, userId],
    );

    // Create connection set
    roomConnections.set(code, new Set());

    return {
      success: true,
      room: {
        code: room.code,
        settings: room.settings,
        status: room.status,
      },
    };
  } catch (error) {
    console.error("Create room error:", error.message);
    return { success: false, message: "Failed to create room" };
  }
});

// Join room
app.post("/api/rooms/:code/join", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (room.status !== "waiting")
      return { success: false, message: "Room is not accepting players" };
    room.settings = withDefaultRoomSettings(room.settings);

    const playerCount = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [room.id],
    );
    if (parseInt(playerCount.rows[0].count) >= room.settings.max_players)
      return { success: false, message: "Room is full" };

    const existing = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );
    if (existing.rows.length > 0) {
      // Already in room — return state
      await touchRoomActivity(room.id);
      const state = await getRoomState(params.code.toUpperCase());
      return { success: true, room: state };
    }

    await pool.query(
      "INSERT INTO room_players (room_id, user_id, is_ready) VALUES ($1, $2, false)",
      [room.id, userId],
    );
    await touchRoomActivity(room.id);

    // Broadcast to room
    const user = await getUser(userId);
    broadcastToRoom(params.code.toUpperCase(), {
      type: "player_joined",
      player: {
        userId,
        username: user.username,
        avatar: getAvatarUrl(user.username),
        isReady: false,
        score: 0,
      },
    });

    const state = await getRoomState(params.code.toUpperCase());
    return { success: true, room: state };
  } catch (error) {
    console.error("Join room error:", error.message);
    return { success: false, message: "Failed to join room" };
  }
});

// Leave room
app.post("/api/rooms/:code/leave", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    await pool.query(
      "DELETE FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );

    // If master leaves, assign new master or destroy room
    if (room.master_id === userId) {
      const remaining = await pool.query(
        "SELECT user_id FROM room_players WHERE room_id = $1 ORDER BY joined_at LIMIT 1",
        [room.id],
      );
      if (remaining.rows.length > 0) {
        await pool.query("UPDATE rooms SET master_id = $1 WHERE id = $2", [
          remaining.rows[0].user_id,
          room.id,
        ]);
      } else {
        await destroyRoomSession(room, "empty_room");
        return { success: true, roomDestroyed: true };
      }
    }
    await touchRoomActivity(room.id);

    broadcastToRoom(params.code.toUpperCase(), {
      type: "player_left",
      userId,
    });

    return { success: true };
  } catch (error) {
    console.error("Leave room error:", error.message);
    return { success: false, message: "Failed to leave room" };
  }
});

// Delete room session (master only)
app.delete("/api/rooms/:code", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (room.master_id !== userId)
      return { success: false, message: "Only room master can delete" };

    await destroyRoomSession(room, "deleted");
    return { success: true, roomDestroyed: true };
  } catch (error) {
    console.error("Delete room error:", error.message);
    return { success: false, message: "Failed to delete room" };
  }
});

// Kick player (master only)
app.post("/api/rooms/:code/kick", async ({ headers, body, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { targetUserId } = body || {};
  if (!targetUserId) return { success: false, message: "Target user required" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (room.master_id !== userId)
      return { success: false, message: "Only room master can kick" };
    if (targetUserId === userId)
      return { success: false, message: "Cannot kick yourself" };

    await pool.query(
      "DELETE FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, targetUserId],
    );
    await touchRoomActivity(room.id);

    broadcastToRoom(room.code, {
      type: "player_kicked",
      userId: targetUserId,
      kickedBy: userId,
    });

    return { success: true };
  } catch (error) {
    console.error("Kick error:", error.message);
    return { success: false, message: "Failed to kick player" };
  }
});

// Toggle ready
app.post("/api/rooms/:code/ready", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    const updated = await pool.query(
      `UPDATE room_players SET is_ready = NOT is_ready
       WHERE room_id = $1 AND user_id = $2 RETURNING is_ready`,
      [room.id, userId],
    );
    if (updated.rows.length === 0)
      return { success: false, message: "Forbidden" };
    await touchRoomActivity(room.id);

    broadcastToRoom(room.code, {
      type: "player_ready",
      userId,
      isReady: updated.rows[0]?.is_ready || false,
    });

    return { success: true, isReady: updated.rows[0]?.is_ready || false };
  } catch (error) {
    console.error("Ready error:", error.message);
    return { success: false, message: "Failed to toggle ready" };
  }
});

// Start game (master only)
app.post("/api/rooms/:code/start", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (room.master_id !== userId)
      return { success: false, message: "Only room master can start" };
    if (room.status !== "waiting")
      return { success: false, message: "Room has already started" };

    // Check all players ready
    const notReady = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1 AND is_ready = false",
      [room.id],
    );
    if (parseInt(notReady.rows[0].count) > 0)
      return { success: false, message: "Not all players are ready" };

    const playersResult = await pool.query(
      "SELECT user_id FROM room_players WHERE room_id = $1 ORDER BY joined_at",
      [room.id],
    );
    if (playersResult.rows.length < 2)
      return { success: false, message: "Need at least 2 players" };

    clearRoomAdvanceTimer(room.code);

    // Assign questions to room
    const settings = withDefaultRoomSettings(room.settings);
    const totalQuestions =
      settings.question_source === "custom"
        ? settings.custom_questions?.length || 0
        : settings.question_count;
    if (totalQuestions < 1)
      return { success: false, message: "No questions configured" };

    settings.question_count = totalQuestions;
    room.settings = settings;

    await pool.query("DELETE FROM room_answers WHERE room_id = $1", [room.id]);
    await pool.query("DELETE FROM room_questions WHERE room_id = $1", [
      room.id,
    ]);

    if (settings.question_mode === "random_per_player") {
      for (const player of playersResult.rows) {
        for (let i = 0; i < totalQuestions; i++) {
          if (settings.question_source === "custom") {
            await pool.query(
              `INSERT INTO room_questions
                 (room_id, user_id, question_id, custom_question, question_order)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                room.id,
                player.user_id,
                null,
                JSON.stringify(settings.custom_questions[i]),
                i + 1,
              ],
            );
          } else {
            const dbQuestion = await pool.query(
              "SELECT id FROM questions ORDER BY RANDOM() LIMIT 1",
            );
            if (dbQuestion.rows.length === 0)
              return { success: false, message: "No questions available" };
            await pool.query(
              `INSERT INTO room_questions
                 (room_id, user_id, question_id, custom_question, question_order)
               VALUES ($1, $2, $3, $4, $5)`,
              [room.id, player.user_id, dbQuestion.rows[0].id, null, i + 1],
            );
          }
        }
      }
    } else if (settings.question_source === "custom") {
      for (let i = 0; i < totalQuestions; i++) {
        await pool.query(
          `INSERT INTO room_questions
             (room_id, user_id, question_id, custom_question, question_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            room.id,
            null,
            null,
            JSON.stringify(settings.custom_questions[i]),
            i + 1,
          ],
        );
      }
    } else {
      const dbQuestions = await pool.query(
        "SELECT id FROM questions ORDER BY RANDOM() LIMIT $1",
        [totalQuestions],
      );
      if (dbQuestions.rows.length < totalQuestions)
        return { success: false, message: "Not enough questions available" };

      for (const [i, question] of dbQuestions.rows.entries()) {
        await pool.query(
          `INSERT INTO room_questions
             (room_id, user_id, question_id, custom_question, question_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [room.id, null, question.id, null, i + 1],
        );
      }
    }

    // Update room status and set current question
    const questionStartedAt = new Date().toISOString();
    await pool.query(
      "UPDATE rooms SET status = 'playing', current_question_order = 1, current_question_started_at = $1, settings = $2, last_activity_at = NOW() WHERE id = $3",
      [questionStartedAt, JSON.stringify(settings), room.id],
    );

    // Reset player scores
    await pool.query(
      "UPDATE room_players SET score = 0, streak = 0 WHERE room_id = $1",
      [room.id],
    );

    // Get first question(s) based on mode
    const firstQuestions = await getQuestionsForRoom({ ...room, settings }, 1);

    scheduleQuestionTimeout({ ...room, settings }, 1, questionStartedAt);

    broadcastToRoom(room.code, {
      type: "game_started",
      questions: firstQuestions,
      questionNumber: 1,
      totalQuestions,
      resultMode: settings.result_mode,
      timePerQuestionSeconds: settings.time_per_question_seconds,
      questionStartedAt,
    });

    // Return first question in REST response as fallback
    return {
      success: true,
      gameStarted: true,
      questions: firstQuestions,
      questionNumber: 1,
      totalQuestions,
      resultMode: settings.result_mode,
      timePerQuestionSeconds: settings.time_per_question_seconds,
      questionStartedAt,
    };
  } catch (error) {
    console.error("Start game error:", error.message);
    return { success: false, message: "Failed to start game" };
  }
});

// Helper: Get question(s) for room based on mode
async function getQuestionsForRoom(room, questionOrder) {
  const settings = withDefaultRoomSettings(room.settings);

  if (settings.question_mode === "random_per_player") {
    // Each player gets the question assigned at game start.
    const assignedQuestions = await pool.query(
      `SELECT rq.user_id, rq.question_id, rq.custom_question, q.question_text, q.options, q.question_type
       FROM room_questions rq
       LEFT JOIN questions q ON rq.question_id = q.id
       WHERE rq.room_id = $1 AND rq.question_order = $2 AND rq.user_id IS NOT NULL`,
      [room.id, questionOrder],
    );
    const result = {};
    for (const row of assignedQuestions.rows) {
      const customQuestion =
        typeof row.custom_question === "string"
          ? JSON.parse(row.custom_question)
          : row.custom_question;
      result[row.user_id] = customQuestion
        ? {
            text: customQuestion.text,
            options: customQuestion.options || [],
            type: customQuestion.type || "multiple_choice",
          }
        : {
            id: row.question_id,
            text: row.question_text,
            options:
              typeof row.options === "string"
                ? JSON.parse(row.options)
                : row.options,
            type: row.question_type || "multiple_choice",
          };
    }
    return result;
  } else {
    // Same question for all
    const rq = await pool.query(
      `SELECT rq.*, q.question_text, q.options, q.correct_answer, q.question_type
       FROM room_questions rq
       LEFT JOIN questions q ON rq.question_id = q.id
       WHERE rq.room_id = $1 AND rq.question_order = $2 AND rq.user_id IS NULL`,
      [room.id, questionOrder],
    );
    if (rq.rows.length === 0) return null;
    const row = rq.rows[0];
    const customQuestion =
      typeof row.custom_question === "string"
        ? JSON.parse(row.custom_question)
        : row.custom_question;
    const question = customQuestion
      ? {
          text: customQuestion.text,
          options: customQuestion.options || [],
          type: customQuestion.type || "multiple_choice",
        }
      : {
          id: row.question_id,
          text: row.question_text,
          options:
            typeof row.options === "string"
              ? JSON.parse(row.options)
              : row.options,
          type: row.question_type || "multiple_choice",
        };
    return { all: question };
  }
}

async function markMissingAnswersWrong(room, questionOrder) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE room_answers IN SHARE ROW EXCLUSIVE MODE");

    const roomResult = await client.query("SELECT * FROM rooms WHERE id = $1", [
      room.id,
    ]);
    if (roomResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const latestRoom = roomResult.rows[0];
    if (
      latestRoom.status !== "playing" ||
      (latestRoom.current_question_order || 1) !== questionOrder
    ) {
      await client.query("ROLLBACK");
      return null;
    }

    const missingPlayers = await client.query(
      `SELECT rp.user_id, rq.question_id
       FROM room_players rp
       LEFT JOIN room_answers ra
         ON ra.room_id = rp.room_id
        AND ra.user_id = rp.user_id
        AND ra.question_order = $2
       LEFT JOIN room_questions rq
         ON rq.room_id = rp.room_id
        AND rq.question_order = $2
        AND (rq.user_id = rp.user_id OR rq.user_id IS NULL)
       WHERE rp.room_id = $1 AND ra.id IS NULL`,
      [room.id, questionOrder],
    );

    for (const player of missingPlayers.rows) {
      await client.query(
        `INSERT INTO room_answers
           (room_id, user_id, question_id, question_order, answer, is_correct)
         VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT DO NOTHING`,
        [
          room.id,
          player.user_id,
          player.question_id || null,
          questionOrder,
          "",
        ],
      );
      await client.query(
        "UPDATE room_players SET streak = 0 WHERE room_id = $1 AND user_id = $2",
        [room.id, player.user_id],
      );
    }

    await client.query("COMMIT");
    return latestRoom;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Question timeout error:", error.message);
    return null;
  } finally {
    client.release();
  }
}

function scheduleQuestionTimeout(room, questionOrder, questionStartedAt) {
  const code = room.code.toUpperCase();
  const settings = withDefaultRoomSettings(room.settings);
  const timeLimit = settings.time_per_question_seconds;
  clearRoomQuestionTimer(code);
  if (!timeLimit) return;

  const expiresAt = new Date(
    Date.parse(questionStartedAt) + timeLimit * 1000,
  ).toISOString();

  const timer = setTimeout(
    async () => {
      roomQuestionTimers.delete(code);
      const latestRoom = await markMissingAnswersWrong(room, questionOrder);
      if (!latestRoom) return;
      await scheduleRoomAdvance(
        {
          ...latestRoom,
          settings: withDefaultRoomSettings(latestRoom.settings),
        },
        questionOrder,
      );
    },
    Math.max(0, Date.parse(expiresAt) - Date.now()),
  );
  if (typeof timer.unref === "function") timer.unref();

  roomQuestionTimers.set(code, {
    timer,
    questionOrder,
    expiresAt,
  });
}

async function scheduleRoomAdvance(room, questionOrder) {
  const code = room.code.toUpperCase();
  const settings = withDefaultRoomSettings(room.settings);
  const delaySeconds = getQuestionDelaySeconds(settings);
  const gameOver = questionOrder >= settings.question_count;
  const advanceAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  clearRoomAdvanceTimer(code);
  clearRoomQuestionTimer(code);

  const timer = setTimeout(async () => {
    roomAdvanceTimers.delete(code);
    try {
      const roomResult = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code],
      );
      if (roomResult.rows.length === 0) return;

      const latestRoom = roomResult.rows[0];
      const latestSettings = withDefaultRoomSettings(latestRoom.settings);
      const activeOrder = latestRoom.current_question_order || 1;
      if (latestRoom.status !== "playing" || activeOrder !== questionOrder)
        return;

      if (questionOrder >= latestSettings.question_count) {
        await endGame({ ...latestRoom, settings: latestSettings });
        return;
      }

      const nextOrder = questionOrder + 1;
      const questionStartedAt = new Date().toISOString();
      await pool.query(
        `UPDATE rooms
         SET current_question_order = $1, current_question_started_at = $2
         WHERE id = $3 AND status = 'playing' AND current_question_order = $4`,
        [nextOrder, questionStartedAt, latestRoom.id, questionOrder],
      );

      const nextQuestions = await getQuestionsForRoom(
        { ...latestRoom, settings: latestSettings },
        nextOrder,
      );
      scheduleQuestionTimeout(
        { ...latestRoom, settings: latestSettings },
        nextOrder,
        questionStartedAt,
      );
      broadcastToRoom(code, {
        type: "next_question",
        questions: nextQuestions,
        questionNumber: nextOrder,
        totalQuestions: latestSettings.question_count,
        resultMode: latestSettings.result_mode,
        timePerQuestionSeconds: latestSettings.time_per_question_seconds,
        questionStartedAt,
      });
    } catch (error) {
      console.error("Scheduled room advance error:", error.message);
    }
  }, delaySeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();

  roomAdvanceTimers.set(code, {
    timer,
    questionOrder,
    delaySeconds,
    advanceAt,
    gameOver,
  });

  const payload = {
    type: "question_transition_scheduled",
    questionNumber: questionOrder,
    nextQuestionNumber: gameOver ? null : questionOrder + 1,
    delaySeconds,
    advanceAt,
    gameOver,
  };
  broadcastToRoom(code, payload);
  return payload;
}

// Get room info
app.get("/api/rooms/:code", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const state = await getRoomState(params.code.toUpperCase());
  if (!state) return { success: false, message: "Room not found" };
  if (!state.players.some((player) => player.userId === userId))
    return { success: false, message: "Forbidden" };
  await touchRoomActivityByCode(params.code);
  return { success: true, room: state };
});

app.get("/api/rooms/:code/leaderboard", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (!(await isRoomMember(room.id, userId)))
      return { success: false, message: "Forbidden" };
    await touchRoomActivity(room.id);

    const leaderboard = await buildRoomLeaderboard(room.id, userId);
    return { success: true, leaderboard };
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return { success: false, message: "Failed to get leaderboard" };
  }
});

// Get game state for reconnection
app.get("/api/rooms/:code/state", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    const settings = withDefaultRoomSettings(room.settings);
    room.settings = settings;
    const state = await getRoomState(params.code.toUpperCase());
    if (!state) return { success: false, message: "Room not found" };
    if (!state.players.some((player) => player.userId === userId))
      return { success: false, message: "Forbidden" };
    await touchRoomActivity(room.id);

    if (room.status === "finished") {
      const summary = await buildRoomSummary(room);
      return {
        success: true,
        room: state,
        inGame: false,
        finished: true,
        summary,
        winner: summary[0] || null,
      };
    }

    if (room.status !== "playing") {
      return { success: true, room: state, inGame: false };
    }

    // Get current question for this room
    const currentOrder = room.current_question_order || 1;
    const questions = await getQuestionsForRoom(room, currentOrder);

    // Check if this player already answered the current question
    const ansCheck = await pool.query(
      "SELECT id FROM room_answers WHERE room_id = $1 AND user_id = $2 AND question_order = $3",
      [room.id, userId, currentOrder],
    );
    const alreadyAnswered = ansCheck.rows.length > 0;

    return {
      success: true,
      room: state,
      inGame: true,
      gameState: {
        questions,
        questionNumber: currentOrder,
        totalQuestions: settings.question_count,
        resultMode: settings.result_mode,
        timePerQuestionSeconds: settings.time_per_question_seconds,
        questionStartedAt: room.current_question_started_at
          ? new Date(room.current_question_started_at).toISOString()
          : null,
        alreadyAnswered,
        transition: getPendingRoomTransition(room.code, currentOrder),
      },
    };
  } catch (error) {
    console.error("Get game state error:", error.message);
    return { success: false, message: "Failed to get game state" };
  }
});

// Submit answer in multiplayer
app.post("/api/rooms/:code/answer", async ({ headers, params, body }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { questionId, answer, questionOrder } = body || {};
  const order = Number.parseInt(questionOrder, 10);
  if (typeof answer !== "string" || !Number.isInteger(order))
    return { success: false, message: "Missing fields" };

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE room_answers IN SHARE ROW EXCLUSIVE MODE");

    const roomResult = await client.query(
      "SELECT * FROM rooms WHERE code = $1",
      [params.code.toUpperCase()],
    );
    if (roomResult.rows.length === 0)
      return rollbackAndReturn(client, {
        success: false,
        message: "Room not found",
      });

    const room = roomResult.rows[0];
    const settings = withDefaultRoomSettings(room.settings);
    room.settings = settings;
    if (room.status !== "playing")
      return rollbackAndReturn(client, {
        success: false,
        message: "Room is not playing",
      });

    const member = await client.query(
      "SELECT score, streak FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );
    if (member.rows.length === 0)
      return rollbackAndReturn(client, {
        success: false,
        message: "Forbidden",
      });

    if (order !== (room.current_question_order || 1))
      return rollbackAndReturn(client, {
        success: false,
        message: "Question is not active",
      });

    if (hasQuestionTimeExpired(room, settings))
      return rollbackAndReturn(client, {
        success: false,
        message: "Question time has ended",
      });

    const assignedQuestion = await client.query(
      settings.question_mode === "random_per_player"
        ? `SELECT rq.*, q.correct_answer
           FROM room_questions rq
           LEFT JOIN questions q ON rq.question_id = q.id
           WHERE rq.room_id = $1 AND rq.question_order = $2 AND rq.user_id = $3`
        : `SELECT rq.*, q.correct_answer
           FROM room_questions rq
           LEFT JOIN questions q ON rq.question_id = q.id
           WHERE rq.room_id = $1 AND rq.question_order = $2 AND rq.user_id IS NULL`,
      settings.question_mode === "random_per_player"
        ? [room.id, order, userId]
        : [room.id, order],
    );
    if (assignedQuestion.rows.length === 0)
      return rollbackAndReturn(client, {
        success: false,
        message: "Question not found",
      });

    const assigned = assignedQuestion.rows[0];
    if (
      questionId &&
      assigned.question_id &&
      Number(questionId) !== assigned.question_id
    )
      return rollbackAndReturn(client, {
        success: false,
        message: "Question mismatch",
      });

    // Get correct answer
    let correctAnswer;
    if (questionId) {
      const qResult = await client.query(
        "SELECT correct_answer FROM questions WHERE id = $1",
        [questionId],
      );
      correctAnswer = qResult.rows[0]?.correct_answer;
    } else {
      // Custom question — check room_questions
      const rq = await client.query(
        `SELECT custom_question
         FROM room_questions
         WHERE room_id = $1
           AND question_order = $2
           AND (user_id = $3 OR user_id IS NULL)
         ORDER BY user_id NULLS LAST
         LIMIT 1`,
        [room.id, order, userId],
      );
      const cq = rq.rows[0]?.custom_question;
      if (cq) {
        const parsed = typeof cq === "string" ? JSON.parse(cq) : cq;
        correctAnswer = parsed.correct_answer;
      }
    }

    const assignedCustom =
      typeof assigned.custom_question === "string"
        ? JSON.parse(assigned.custom_question)
        : assigned.custom_question;
    correctAnswer =
      assignedCustom?.correct_answer ||
      assigned.correct_answer ||
      correctAnswer;

    if (!correctAnswer)
      return rollbackAndReturn(client, {
        success: false,
        message: "Question not found",
      });

    const existingAnswer = await client.query(
      "SELECT is_correct FROM room_answers WHERE room_id = $1 AND user_id = $2 AND question_order = $3",
      [room.id, userId, order],
    );
    if (existingAnswer.rows.length > 0) {
      await client.query("COMMIT");
      return {
        success: true,
        isDuplicate: true,
        userId,
        isCorrect: existingAnswer.rows[0].is_correct,
        correctAnswer,
        score: member.rows[0]?.score || 0,
        streak: member.rows[0]?.streak || 0,
        streakBonus: 0,
      };
    }

    const isCorrect =
      normalizeAnswer(answer) === normalizeAnswer(correctAnswer);
    const nextStreak = isCorrect ? (member.rows[0]?.streak || 0) + 1 : 0;
    const streakBonus = isCorrect && nextStreak >= 3 ? 5 : 0;
    const points = isCorrect ? 10 + streakBonus : 0;

    // Save answer
    await client.query(
      `INSERT INTO room_answers
         (room_id, user_id, question_id, question_order, answer, is_correct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        room.id,
        userId,
        assigned.question_id || null,
        order,
        answer.trim(),
        isCorrect,
      ],
    );

    // Update score
    await client.query(
      "UPDATE room_players SET score = score + $1, streak = $2 WHERE room_id = $3 AND user_id = $4",
      [points, nextStreak, room.id, userId],
    );

    const userScore = await client.query(
      "SELECT score, streak FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );

    const responseData = {
      userId,
      isCorrect,
      correctAnswer,
      score: userScore.rows[0]?.score || 0,
      streak: userScore.rows[0]?.streak || 0,
      streakBonus,
      pointsAwarded: points,
    };

    // Handle result mode
    if (settings.result_mode === "instant") {
      // Broadcast result to all in room
      broadcastToRoom(room.code, {
        type: "answer_result",
        ...responseData,
      });
    } else {
      // Only send to the answering user via ws
      const connections = roomConnections.get(room.code);
      if (connections) {
        for (const conn of connections) {
          if (conn.userId === userId && conn.ws.readyState === 1) {
            conn.ws.send(
              JSON.stringify({ type: "answer_result", ...responseData }),
            );
          }
        }
      }
    }

    // Check if all players answered this question
    const playerCount = await client.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [room.id],
    );
    const answerCount = await client.query(
      "SELECT COUNT(DISTINCT user_id) FROM room_answers WHERE room_id = $1 AND question_order = $2",
      [room.id, order],
    );

    const allAnswered =
      parseInt(answerCount.rows[0].count) >=
      parseInt(playerCount.rows[0].count);

    if (allAnswered) {
      await client.query("COMMIT");
      const transition = await scheduleRoomAdvance(room, order);
      return {
        success: true,
        ...responseData,
        allAnswered: true,
        nextQuestionScheduled: !transition.gameOver,
        gameOverScheduled: transition.gameOver,
        delaySeconds: transition.delaySeconds,
        advanceAt: transition.advanceAt,
      };
    }

    await client.query("COMMIT");
    return { success: true, ...responseData };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Room answer error:", error.message);
    return { success: false, message: "Failed to submit answer" };
  } finally {
    client.release();
  }
});

async function buildRoomSummary(room) {
  const standings = await pool.query(
    `SELECT rp.user_id, rp.score, rp.streak, u.username
     FROM room_players rp
     JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1
     ORDER BY rp.score DESC`,
    [room.id],
  );

  const answers = await pool.query(
    `SELECT ra.user_id, ra.question_id, ra.question_order, ra.answer, ra.is_correct,
            COALESCE(q.question_text, rq.custom_question->>'text') AS question_text,
            COALESCE(q.correct_answer, rq.custom_question->>'correct_answer') AS correct_answer_text
     FROM room_answers ra
     LEFT JOIN questions q ON ra.question_id = q.id
     LEFT JOIN room_questions rq
       ON rq.room_id = ra.room_id
      AND rq.question_order = ra.question_order
      AND (rq.user_id = ra.user_id OR rq.user_id IS NULL)
     WHERE ra.room_id = $1
     ORDER BY ra.answered_at`,
    [room.id],
  );

  return standings.rows.map((player, rank) => {
    const playerAnswers = answers.rows.filter(
      (a) => a.user_id === player.user_id,
    );
    const correctCount = playerAnswers.filter((a) => a.is_correct).length;
    const accuracy =
      playerAnswers.length > 0
        ? Math.round((correctCount / playerAnswers.length) * 100)
        : 0;

    return {
      rank: rank + 1,
      userId: player.user_id,
      username: player.username,
      avatar: getAvatarUrl(player.username),
      score: player.score,
      streak: player.streak || 0,
      accuracy,
      correctCount,
      totalAnswered: playerAnswers.length,
      answers: playerAnswers.map((a) => ({
        questionText: a.question_text || "Custom Question",
        userAnswer: a.answer,
        correctAnswer: a.correct_answer_text,
        isCorrect: a.is_correct,
      })),
    };
  });
}

// End game and send summary
async function endGame(room) {
  clearRoomAdvanceTimer(room.code);
  clearRoomQuestionTimer(room.code);

  await pool.query("UPDATE rooms SET status = 'finished' WHERE id = $1", [
    room.id,
  ]);

  const playerSummaries = await buildRoomSummary(room);

  broadcastToRoom(room.code, {
    type: "game_over",
    summary: playerSummaries,
    winner: playerSummaries[0] || null,
  });
}

// Get game summary
app.get("/api/rooms/:code/summary", async ({ headers, params }) => {
  const token = getBearerToken(headers);
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const room = await findRoomByCode(params.code);
    if (!room) return { success: false, message: "Room not found" };
    if (!(await isRoomMember(room.id, userId)))
      return { success: false, message: "Forbidden" };
    await touchRoomActivity(room.id);

    const summary = await buildRoomSummary(room);
    return { success: true, summary, winner: summary[0] || null };
  } catch (error) {
    console.error("Summary error:", error.message);
    return { success: false, message: "Failed to get summary" };
  }
});

// ═══════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════

app.ws("/ws", {
  async open(ws) {
    getSocketState(ws);
    // Connection established — waiting for auth message
  },
  async message(ws, raw) {
    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { type, token, roomCode } = data;

    // Auth
    if (type === "auth") {
      const userId = await validateSession(token);
      if (!userId) {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
        return;
      }
      const user = await getUser(userId);
      const state = getSocketState(ws);
      state.userId = userId;
      state.username = user?.username;
      ws.send(JSON.stringify({ type: "auth_ok", userId }));
      return;
    }

    const state = await authenticateSocketState(ws, token);
    if (!state?.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    // Join room channel
    if (type === "join_room") {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const room = await findRoomByCode(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
        return;
      }
      if (!(await isRoomMember(room.id, state.userId))) {
        ws.send(JSON.stringify({ type: "error", message: "Forbidden" }));
        return;
      }
      await touchRoomActivity(room.id);

      if (!roomConnections.has(code)) {
        roomConnections.set(code, new Set());
      }
      roomConnections.get(code).add({
        ws,
        socketId: getSocketId(ws),
        userId: state.userId,
        username: state.username,
      });
      state.roomCode = code;

      ws.send(
        JSON.stringify({
          type: "room_joined",
          roomCode: code,
        }),
      );

      // Broadcast presence
      broadcastToRoom(
        code,
        {
          type: "user_connected",
          userId: state.userId,
          username: state.username,
          avatar: getAvatarUrl(state.username),
        },
        ws,
      );
      return;
    }

    // Leave room channel
    if (type === "leave_room") {
      if (!state.roomCode && roomCode) state.roomCode = roomCode.toUpperCase();
      const left = removeSocketFromRoom(ws);
      if (left) {
        broadcastToRoom(left.code, {
          type: "user_disconnected",
          userId: left.userId,
        });
      }
      return;
    }

    // Ping/pong for keepalive
    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  },
  close(ws) {
    const left = removeSocketFromRoom(ws);
    if (left) {
      broadcastToRoom(left.code, {
        type: "user_disconnected",
        userId: left.userId,
      });
    }
    socketStates.delete(getSocketId(ws));
  },
});

const roomCleanupInterval = setInterval(() => {
  cleanupExpiredWaitingRooms().catch((error) => {
    console.error("Room cleanup error:", error.message);
  });
}, 60_000);
roomCleanupInterval.unref?.();

// ═══════════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🎮 Trivia Quiz Server running on http://localhost:${PORT}`);
  console.log(`📂 Frontend available at http://localhost:${PORT}/`);
  console.log(`🔌 WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
});
