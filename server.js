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
// Map<token, userId>
const activeSessions = new Map();

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

async function validateSession(token) {
  if (!token) return null;
  // Check in-memory cache first
  const cached = activeSessions.get(token);
  if (cached) return cached;
  // Check database
  const result = await pool.query(
    `SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()`,
    [token],
  );
  if (result.rows.length > 0) {
    activeSessions.set(token, result.rows[0].user_id);
    return result.rows[0].user_id;
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

async function broadcastToRoom(roomCode, message, excludeWs = null) {
  const connections = roomConnections.get(roomCode);
  if (!connections) return;
  const data = JSON.stringify(message);
  for (const conn of connections) {
    if (conn.ws !== excludeWs && conn.ws.readyState === 1) {
      conn.ws.send(data);
    }
  }
}

async function getRoomState(roomCode) {
  const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
    roomCode,
  ]);
  if (roomResult.rows.length === 0) return null;
  const room = roomResult.rows[0];

  const playersResult = await pool.query(
    `SELECT rp.user_id, rp.is_ready, rp.score, u.username
     FROM room_players rp
     JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1
     ORDER BY rp.joined_at`,
    [room.id],
  );

  return {
    code: room.code,
    masterId: room.master_id,
    settings: room.settings,
    status: room.status,
    currentQuestionOrder: room.current_question_order || 0,
    players: playersResult.rows.map((p) => ({
      userId: p.user_id,
      username: p.username,
      avatar: getAvatarUrl(p.username),
      isReady: p.is_ready,
      score: p.score,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  APP SETUP
// ═══════════════════════════════════════════════════════════════════

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
  const username = body?.username;

  if (!username || typeof username !== "string" || username.trim().length < 2) {
    return {
      success: false,
      message: "Username must be at least 2 characters",
    };
  }

  try {
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username.trim()],
    );

    let user;
    if (existingUser.rows.length > 0) {
      // User exists — treat as login
      const result = await pool.query(
        "SELECT id, username, total_score FROM users WHERE username = $1",
        [username.trim()],
      );
      user = result.rows[0];
    } else {
      // Create new user
      const result = await pool.query(
        "INSERT INTO users (username) VALUES ($1) RETURNING id, username, total_score",
        [username.trim()],
      );
      user = result.rows[0];
    }

    // Create session token (expires in 24 hours)
    const token = generateToken();
    await pool.query(
      "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
      [user.id, token],
    );
    activeSessions.set(token, user.id);

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

// Logout
app.post("/api/logout", async ({ headers }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    activeSessions.delete(token);
  }
  return { success: true };
});

// Validate session
app.get("/api/auth/validate", async ({ headers }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
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
  const token = headers["authorization"]?.replace("Bearer ", "");
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
      },
      currentScore,
    };
  } catch (error) {
    console.error("Get question error:", error.message);
    return { success: false, message: "Failed to get question" };
  }
});

app.post("/api/answer", async ({ headers, body }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { questionId, userAnswer } = body || {};
  if (!questionId || !userAnswer) {
    return { success: false, message: "Missing required fields" };
  }

  try {
    const questionResult = await pool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [questionId],
    );
    if (questionResult.rows.length === 0)
      return { success: false, message: "Question not found" };

    const correctAnswer = questionResult.rows[0].correct_answer;
    const isCorrect = userAnswer.toLowerCase() === correctAnswer.toLowerCase();
    const points = isCorrect ? 10 : 0;

    await pool.query(
      "INSERT INTO game_history (user_id, question_id, is_correct) VALUES ($1, $2, $3)",
      [userId, questionId, isCorrect],
    );
    await pool.query(
      "UPDATE users SET total_score = total_score + $1 WHERE id = $2",
      [points, userId],
    );

    const userResult = await pool.query(
      "SELECT total_score FROM users WHERE id = $1",
      [userId],
    );
    const newScore = userResult.rows[0]?.total_score || 0;

    return {
      success: true,
      isNewScore: isCorrect,
      score: newScore,
      correctAnswer,
      isCorrect,
    };
  } catch (error) {
    console.error("Answer error:", error.message);
    return { success: false, message: "Failed to submit answer" };
  }
});

app.get("/api/score/:userId", async ({ params }) => {
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

app.get("/api/history/:userId", async ({ params }) => {
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
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const settings = {
    max_players: body?.maxPlayers || 6,
    question_count: body?.questionCount || 5,
    question_source: body?.questionSource || "database",
    question_mode: body?.questionMode || "same_for_all",
    result_mode: body?.resultMode || "instant",
    custom_questions: body?.customQuestions || [],
  };

  try {
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
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    if (room.status !== "waiting")
      return { success: false, message: "Room is not accepting players" };

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
      const state = await getRoomState(params.code.toUpperCase());
      return { success: true, room: state };
    }

    await pool.query(
      "INSERT INTO room_players (room_id, user_id, is_ready) VALUES ($1, $2, false)",
      [room.id, userId],
    );

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
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
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
        await pool.query("DELETE FROM rooms WHERE id = $1", [room.id]);
        roomConnections.delete(params.code.toUpperCase());
        return { success: true, roomDestroyed: true };
      }
    }

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

// Kick player (master only)
app.post("/api/rooms/:code/kick", async ({ headers, body, params }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { targetUserId } = body || {};
  if (!targetUserId) return { success: false, message: "Target user required" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    if (room.master_id !== userId)
      return { success: false, message: "Only room master can kick" };
    if (targetUserId === userId)
      return { success: false, message: "Cannot kick yourself" };

    await pool.query(
      "DELETE FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, targetUserId],
    );

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
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    await pool.query(
      `UPDATE room_players SET is_ready = NOT is_ready
       WHERE room_id = $1 AND user_id = $2 RETURNING is_ready`,
      [room.id, userId],
    );

    const updated = await pool.query(
      "SELECT is_ready FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );

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
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    if (room.master_id !== userId)
      return { success: false, message: "Only room master can start" };

    // Check all players ready
    const notReady = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1 AND is_ready = false",
      [room.id],
    );
    if (parseInt(notReady.rows[0].count) > 0)
      return { success: false, message: "Not all players are ready" };

    const playerCount = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [room.id],
    );
    if (parseInt(playerCount.rows[0].count) < 2)
      return { success: false, message: "Need at least 2 players" };

    // Assign questions to room
    const settings = room.settings;
    let questionsToAssign = [];

    if (
      settings.question_source === "custom" &&
      settings.custom_questions?.length > 0
    ) {
      questionsToAssign = settings.custom_questions.map((q, i) => ({
        custom_question: q,
        question_order: i + 1,
      }));
    } else {
      // Get random questions from DB
      const dbQuestions = await pool.query(
        "SELECT * FROM questions ORDER BY RANDOM() LIMIT $1",
        [settings.question_count],
      );
      questionsToAssign = dbQuestions.rows.map((q, i) => ({
        question_id: q.id,
        question_order: i + 1,
      }));
    }

    // Insert room questions
    for (const q of questionsToAssign) {
      await pool.query(
        `INSERT INTO room_questions (room_id, question_id, custom_question, question_order)
         VALUES ($1, $2, $3, $4)`,
        [
          room.id,
          q.question_id || null,
          q.custom_question ? JSON.stringify(q.custom_question) : null,
          q.question_order,
        ],
      );
    }

    // Update room status and set current question
    await pool.query(
      "UPDATE rooms SET status = 'playing', current_question_order = 1 WHERE id = $1",
      [room.id],
    );

    // Reset player scores
    await pool.query("UPDATE room_players SET score = 0 WHERE room_id = $1", [
      room.id,
    ]);

    // Get first question(s) based on mode
    const firstQuestions = await getQuestionsForRoom(room, 1);

    broadcastToRoom(room.code, {
      type: "game_started",
      questions: firstQuestions,
      questionNumber: 1,
      totalQuestions: settings.question_count,
      resultMode: settings.result_mode,
    });

    // Return first question in REST response as fallback
    return {
      success: true,
      gameStarted: true,
      questions: firstQuestions,
      questionNumber: 1,
      totalQuestions: settings.question_count,
      resultMode: settings.result_mode,
    };
  } catch (error) {
    console.error("Start game error:", error.message);
    return { success: false, message: "Failed to start game" };
  }
});

// Helper: Get question(s) for room based on mode
async function getQuestionsForRoom(room, questionOrder) {
  const settings = room.settings;

  if (settings.question_mode === "random_per_player") {
    // Each player gets a different question
    const players = await pool.query(
      "SELECT user_id FROM room_players WHERE room_id = $1",
      [room.id],
    );
    const result = {};
    for (const p of players.rows) {
      const q = await pool.query(
        "SELECT * FROM questions ORDER BY RANDOM() LIMIT 1",
      );
      if (q.rows.length > 0) {
        const question = q.rows[0];
        result[p.user_id] = {
          id: question.id,
          text: question.question_text,
          options:
            typeof question.options === "string"
              ? JSON.parse(question.options)
              : question.options,
        };
      }
    }
    return result;
  } else {
    // Same question for all
    const rq = await pool.query(
      `SELECT rq.*, q.question_text, q.options, q.correct_answer
       FROM room_questions rq
       LEFT JOIN questions q ON rq.question_id = q.id
       WHERE rq.room_id = $1 AND rq.question_order = $2`,
      [room.id, questionOrder],
    );
    if (rq.rows.length === 0) return null;
    const row = rq.rows[0];
    const question = row.custom_question
      ? JSON.parse(row.custom_question)
      : {
          id: row.question_id,
          text: row.question_text,
          options:
            typeof row.options === "string"
              ? JSON.parse(row.options)
              : row.options,
        };
    return { all: question };
  }
}

// Get room info
app.get("/api/rooms/:code", async ({ headers, params }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const state = await getRoomState(params.code.toUpperCase());
  if (!state) return { success: false, message: "Room not found" };
  return { success: true, room: state };
});

// Get game state for reconnection
app.get("/api/rooms/:code/state", async ({ headers, params }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    const state = await getRoomState(params.code.toUpperCase());

    if (room.status !== "playing") {
      return { success: true, room: state, inGame: false };
    }

    // Get current question for this room
    const currentOrder = room.current_question_order || 1;
    const questions = await getQuestionsForRoom(room, currentOrder);

    // Check if this player already answered the current question
    let alreadyAnswered = false;
    if (room.settings.question_mode === "same_for_all") {
      const qId = await pool.query(
        "SELECT question_id FROM room_questions WHERE room_id = $1 AND question_order = $2",
        [room.id, currentOrder],
      );
      if (qId.rows.length > 0) {
        const ansCheck = await pool.query(
          "SELECT id FROM room_answers WHERE room_id = $1 AND user_id = $2 AND question_id = $3",
          [room.id, userId, qId.rows[0].question_id],
        );
        alreadyAnswered = ansCheck.rows.length > 0;
      }
    }

    return {
      success: true,
      room: state,
      inGame: true,
      gameState: {
        questions,
        questionNumber: currentOrder,
        totalQuestions: room.settings.question_count,
        resultMode: room.settings.result_mode,
        alreadyAnswered,
      },
    };
  } catch (error) {
    console.error("Get game state error:", error.message);
    return { success: false, message: "Failed to get game state" };
  }
});

// Submit answer in multiplayer
app.post("/api/rooms/:code/answer", async ({ headers, params, body }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  const { questionId, answer, questionOrder } = body || {};
  if (!answer || questionOrder === undefined)
    return { success: false, message: "Missing fields" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];
    const settings = room.settings;

    // Get correct answer
    let correctAnswer;
    if (questionId) {
      const qResult = await pool.query(
        "SELECT correct_answer FROM questions WHERE id = $1",
        [questionId],
      );
      correctAnswer = qResult.rows[0]?.correct_answer;
    } else {
      // Custom question — check room_questions
      const rq = await pool.query(
        "SELECT custom_question FROM room_questions WHERE room_id = $1 AND question_order = $2",
        [room.id, questionOrder],
      );
      const cq = rq.rows[0]?.custom_question;
      if (cq) {
        const parsed = typeof cq === "string" ? JSON.parse(cq) : cq;
        correctAnswer = parsed.correct_answer;
      }
    }

    const isCorrect = answer.toLowerCase() === correctAnswer?.toLowerCase();
    const points = isCorrect ? 10 : 0;

    // Save answer
    await pool.query(
      `INSERT INTO room_answers (room_id, user_id, question_id, answer, is_correct)
       VALUES ($1, $2, $3, $4, $5)`,
      [room.id, userId, questionId || null, answer, isCorrect],
    );

    // Update score
    await pool.query(
      "UPDATE room_players SET score = score + $1 WHERE room_id = $2 AND user_id = $3",
      [points, room.id, userId],
    );

    const userScore = await pool.query(
      "SELECT score FROM room_players WHERE room_id = $1 AND user_id = $2",
      [room.id, userId],
    );

    const responseData = {
      userId,
      isCorrect,
      correctAnswer,
      score: userScore.rows[0]?.score || 0,
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
    const playerCount = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [room.id],
    );
    const answerCount = await pool.query(
      "SELECT COUNT(DISTINCT user_id) FROM room_answers WHERE room_id = $1 AND question_id = $2",
      [room.id, questionId],
    );

    const allAnswered =
      parseInt(answerCount.rows[0].count) >=
      parseInt(playerCount.rows[0].count);

    if (allAnswered) {
      // Check if more questions
      if (questionOrder >= settings.question_count) {
        // Game over — send summary
        await endGame(room);
        return {
          success: true,
          ...responseData,
          gameOver: true,
        };
      } else {
        // Send next question
        const nextOrder = questionOrder + 1;
        // Update current question order in DB
        await pool.query(
          "UPDATE rooms SET current_question_order = $1 WHERE id = $2",
          [nextOrder, room.id],
        );
        const nextQuestions = await getQuestionsForRoom(room, nextOrder);
        broadcastToRoom(room.code, {
          type: "next_question",
          questions: nextQuestions,
          questionNumber: nextOrder,
          totalQuestions: settings.question_count,
          resultMode: settings.result_mode,
        });
        // Return next question in REST response as fallback
        return {
          success: true,
          ...responseData,
          allAnswered: true,
          nextQuestion: {
            questions: nextQuestions,
            questionNumber: nextOrder,
            totalQuestions: settings.question_count,
            resultMode: settings.result_mode,
          },
        };
      }
    }

    return { success: true, ...responseData };
  } catch (error) {
    console.error("Room answer error:", error.message);
    return { success: false, message: "Failed to submit answer" };
  }
});

// End game and send summary
async function endGame(room) {
  // Update room status
  await pool.query("UPDATE rooms SET status = 'finished' WHERE id = $1", [
    room.id,
  ]);

  // Get final standings
  const standings = await pool.query(
    `SELECT rp.user_id, rp.score, u.username
     FROM room_players rp
     JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1
     ORDER BY rp.score DESC`,
    [room.id],
  );

  // Get detailed answers
  const answers = await pool.query(
    `SELECT ra.user_id, ra.question_id, ra.answer, ra.is_correct,
            COALESCE(q.question_text, (SELECT custom_question->>'text' FROM room_questions WHERE room_id = ra.room_id AND question_order = ra.question_id)) as question_text,
            COALESCE(q.correct_answer, (SELECT custom_question->>'correct_answer' FROM room_questions WHERE room_id = ra.room_id AND question_order = ra.question_id)) as correct_answer_text
     FROM room_answers ra
     LEFT JOIN questions q ON ra.question_id = q.id
     WHERE ra.room_id = $1
     ORDER BY ra.answered_at`,
    [room.id],
  );

  // Build summary per player
  const settings = room.settings;
  const playerSummaries = standings.rows.map((player, rank) => {
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

  broadcastToRoom(room.code, {
    type: "game_over",
    summary: playerSummaries,
    winner: playerSummaries[0] || null,
  });
}

// Get game summary
app.get("/api/rooms/:code/summary", async ({ headers, params }) => {
  const token = headers["authorization"]?.replace("Bearer ", "");
  const userId = await validateSession(token);
  if (!userId) return { success: false, message: "Unauthorized" };

  try {
    const roomResult = await pool.query("SELECT * FROM rooms WHERE code = $1", [
      params.code.toUpperCase(),
    ]);
    if (roomResult.rows.length === 0)
      return { success: false, message: "Room not found" };

    const room = roomResult.rows[0];

    const standings = await pool.query(
      `SELECT rp.user_id, rp.score, u.username
       FROM room_players rp
       JOIN users u ON rp.user_id = u.id
       WHERE rp.room_id = $1
       ORDER BY rp.score DESC`,
      [room.id],
    );

    const answers = await pool.query(
      `SELECT ra.user_id, ra.question_id, ra.answer, ra.is_correct,
              q.question_text, q.correct_answer as correct_answer_text
       FROM room_answers ra
       LEFT JOIN questions q ON ra.question_id = q.id
       WHERE ra.room_id = $1`,
      [room.id],
    );

    const playerSummaries = standings.rows.map((player, rank) => {
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

    return { success: true, summary: playerSummaries };
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
      ws.userId = userId;
      const user = await getUser(userId);
      ws.username = user?.username;
      ws.send(JSON.stringify({ type: "auth_ok", userId }));
      return;
    }

    if (!ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    // Join room channel
    if (type === "join_room") {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      if (!roomConnections.has(code)) {
        roomConnections.set(code, new Set());
      }
      roomConnections.get(code).add({
        ws,
        userId: ws.userId,
        username: ws.username,
      });
      ws.roomCode = code;

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
          userId: ws.userId,
          username: ws.username,
          avatar: getAvatarUrl(ws.username),
        },
        ws,
      );
      return;
    }

    // Leave room channel
    if (type === "leave_room") {
      const code = ws.roomCode;
      if (code && roomConnections.has(code)) {
        const conns = roomConnections.get(code);
        for (const conn of conns) {
          if (conn.ws === ws) {
            conns.delete(conn);
            break;
          }
        }
        broadcastToRoom(code, {
          type: "user_disconnected",
          userId: ws.userId,
        });
      }
      ws.roomCode = null;
      return;
    }

    // Ping/pong for keepalive
    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  },
  close(ws) {
    // Clean up connections
    const code = ws.roomCode;
    if (code && roomConnections.has(code)) {
      const conns = roomConnections.get(code);
      for (const conn of conns) {
        if (conn.ws === ws) {
          conns.delete(conn);
          break;
        }
      }
      broadcastToRoom(code, {
        type: "user_disconnected",
        userId: ws.userId,
      });
    }
  },
});

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
