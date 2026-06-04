/**
 * Unit Tests: Trivia Quiz Game API (Multiplayer)
 *
 * Tests cover:
 *  1. POST /api/register (auth + token)
 *  2. POST /api/logout
 *  3. GET  /api/auth/validate
 *  4. GET  /api/questions/next (with auth)
 *  5. POST /api/answer (with auth)
 *  6. GET  /api/score/:userId
 *  7. GET  /api/history/:userId
 *  8. Room CRUD (create, join, leave, kick, ready, start)
 *  9. Full game flow
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;
const testPool = new Pool({ connectionString: process.env.DATABASE_URL });

let BASE = "http://localhost:3456";
let serverProcess = null;
let serverPort = 3456;

// ── Start server for testing ──────────────────────────────────────
beforeAll(async () => {
  serverPort = 3456 + Math.floor(Math.random() * 1000);
  BASE = `http://localhost:${serverPort}`;
  serverProcess = Bun.spawn(["bun", "run", "server.js"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: String(serverPort) },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exited = serverProcess.exited.then((code) => ({
    type: "exited",
    code,
  }));
  const ready = (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(`${BASE}/api/auth/validate`);
        return { type: "ready" };
      } catch {
        await wait(100);
      }
    }
    return { type: "timeout" };
  })();

  const result = await Promise.race([ready, exited]);
  if (result.type !== "ready") {
    const stderr = serverProcess.stderr
      ? await new Response(serverProcess.stderr).text()
      : "";
    throw new Error(
      `Test server failed to start on port ${serverPort}: ${result.type} ${result.code ?? ""}\n${stderr}`,
    );
  }
});

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await serverProcess.exited;
  }
  await testPool.end();
});

// ── Helper ────────────────────────────────────────────────────────
async function api(method, path, body, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  return { status: res.status, json: await res.json() };
}

async function registerUser(username) {
  const { json } = await api("POST", "/api/register", { username });
  return json;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTrackedSocket() {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);
  const messages = [];
  const waiters = [];

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("WebSocket failed to open")),
      { once: true },
    );
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    messages.push(data);

    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (waiter.predicate(data)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(data);
      }
    }
  });

  function waitFor(predicate, label, timeoutMs = 5000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(
          new Error(
            `Timed out waiting for ${label}. Messages: ${JSON.stringify(messages)}`,
          ),
        );
      }, timeoutMs);

      waiters.push({ predicate, resolve, timeout });
    });
  }

  return { ws, opened, waitFor };
}

async function connectRoomSocket(token, roomCode) {
  const socket = createTrackedSocket();
  await socket.opened;
  socket.ws.send(JSON.stringify({ type: "auth", token }));
  await socket.waitFor((message) => message.type === "auth_ok", "auth_ok");
  socket.ws.send(JSON.stringify({ type: "join_room", roomCode, token }));
  await socket.waitFor(
    (message) => message.type === "room_joined" && message.roomCode === roomCode,
    "room_joined",
  );
  return socket;
}

function closeTrackedSocket(socket) {
  if (socket?.ws && socket.ws.readyState < 2) socket.ws.close();
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH TESTS
// ═══════════════════════════════════════════════════════════════════

describe("POST /api/register", () => {
  test("registers a new user and returns token", async () => {
    const json = await registerUser("testuser_" + Date.now());
    expect(json.success).toBe(true);
    expect(json.user).toBeDefined();
    expect(json.user.id).toBeDefined();
    expect(json.user.username).toBeDefined();
    expect(json.user.avatar).toBeDefined();
    expect(json.token).toBeDefined();
    expect(json.token.length).toBe(64);
  });

  test("returns token for existing user (login)", async () => {
    const name = "existing_" + Date.now();
    const first = await registerUser(name);
    expect(first.success).toBe(true);

    const second = await registerUser(name);
    expect(second.success).toBe(true);
    expect(second.user.id).toBe(first.user.id);
    expect(second.token).toBeDefined();
    expect(second.token).not.toBe(first.token);
  });

  test("rejects username shorter than 2 characters", async () => {
    const json = await registerUser("a");
    expect(json.success).toBe(false);
    expect(json.message).toContain("2 characters");
  });

  test("rejects empty username", async () => {
    const json = await registerUser("");
    expect(json.success).toBe(false);
  });

  test("rejects usernames with markup characters", async () => {
    const json = await registerUser("<img src=x onerror=alert(1)>");
    expect(json.success).toBe(false);
    expect(json.message).toContain("letters");
  });
});

describe("POST /api/logout", () => {
  test("invalidates session token", async () => {
    const reg = await registerUser("logout_test_" + Date.now());
    const { json } = await api("POST", "/api/logout", null, reg.token);
    expect(json.success).toBe(true);

    // Verify token is invalid
    const { json: valid } = await api(
      "GET",
      "/api/auth/validate",
      null,
      reg.token,
    );
    expect(valid.success).toBe(false);
  });
});

describe("GET /api/auth/validate", () => {
  test("validates active session", async () => {
    const reg = await registerUser("valid_test_" + Date.now());
    const { json } = await api("GET", "/api/auth/validate", null, reg.token);
    expect(json.success).toBe(true);
    expect(json.user.id).toBe(reg.user.id);
    expect(json.user.avatar).toBeDefined();
  });

  test("rejects invalid token", async () => {
    const { json } = await api(
      "GET",
      "/api/auth/validate",
      null,
      "invalidtoken123",
    );
    expect(json.success).toBe(false);
  });

  test("rejects missing token", async () => {
    const { json } = await api("GET", "/api/auth/validate");
    expect(json.success).toBe(false);
  });

  test("rejects a cached token after it expires in the database", async () => {
    const reg = await registerUser("expired_test_" + Date.now());

    const { json: validBeforeExpiry } = await api(
      "GET",
      "/api/auth/validate",
      null,
      reg.token,
    );
    expect(validBeforeExpiry.success).toBe(true);

    await testPool.query(
      "UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token = $1",
      [reg.token],
    );

    const { json: validAfterExpiry } = await api(
      "GET",
      "/api/auth/validate",
      null,
      reg.token,
    );
    expect(validAfterExpiry.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  QUESTION & ANSWER TESTS (with auth)
// ═══════════════════════════════════════════════════════════════════

describe("GET /api/questions/next", () => {
  test("returns a question for authenticated user", async () => {
    const reg = await registerUser("qtest_" + Date.now());
    const { status, json } = await api(
      "GET",
      "/api/questions/next",
      null,
      reg.token,
    );
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.question).toBeDefined();
    expect(json.question.id).toBeDefined();
    expect(json.question.text).toBeDefined();
    expect(Array.isArray(json.question.options)).toBe(true);
    expect(json.question.options.length).toBe(4);
  });

  test("rejects unauthenticated request", async () => {
    const { json } = await api("GET", "/api/questions/next");
    expect(json.success).toBe(false);
    expect(json.message).toContain("Unauthorized");
  });
});

describe("POST /api/answer", () => {
  test("accepts correct answer with auth", async () => {
    const reg = await registerUser("ans_test_" + Date.now());
    const { json: q } = await api(
      "GET",
      "/api/questions/next",
      null,
      reg.token,
    );

    const row = await testPool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [q.question.id],
    );

    const { json } = await api(
      "POST",
      "/api/answer",
      {
        questionId: q.question.id,
        userAnswer: row.rows[0].correct_answer,
      },
      reg.token,
    );

    expect(json.success).toBe(true);
    expect(json.isCorrect).toBe(true);
    expect(json.score).toBe(10);
  });

  test("rejects unauthenticated request", async () => {
    const { json } = await api("POST", "/api/answer", {
      questionId: 1,
      userAnswer: "test",
    });
    expect(json.success).toBe(false);
    expect(json.message).toContain("Unauthorized");
  });

  test("case-insensitive answer comparison", async () => {
    const reg = await registerUser("case_test_" + Date.now());
    const { json: q } = await api(
      "GET",
      "/api/questions/next",
      null,
      reg.token,
    );

    const row = await testPool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [q.question.id],
    );

    const { json } = await api(
      "POST",
      "/api/answer",
      {
        questionId: q.question.id,
        userAnswer: row.rows[0].correct_answer.toLowerCase(),
      },
      reg.token,
    );

    expect(json.success).toBe(true);
    expect(json.isCorrect).toBe(true);
  });

  test("does not award points twice for the same solo question", async () => {
    const reg = await registerUser("dupe_solo_" + Date.now());
    const { json: q } = await api(
      "GET",
      "/api/questions/next",
      null,
      reg.token,
    );

    const row = await testPool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [q.question.id],
    );

    const answerBody = {
      questionId: q.question.id,
      userAnswer: row.rows[0].correct_answer,
    };
    const first = await api("POST", "/api/answer", answerBody, reg.token);
    const second = await api("POST", "/api/answer", answerBody, reg.token);

    expect(first.json.success).toBe(true);
    expect(first.json.score).toBe(10);
    expect(second.json.success).toBe(true);
    expect(second.json.isDuplicate).toBe(true);
    expect(second.json.score).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SCORE & HISTORY TESTS
// ═══════════════════════════════════════════════════════════════════

describe("GET /api/score/:userId", () => {
  test("returns user score with avatar", async () => {
    const reg = await registerUser("score_test_" + Date.now());
    const { json } = await api("GET", `/api/score/${reg.user.id}`, null, reg.token);
    expect(json.success).toBe(true);
    expect(json.user.id).toBe(reg.user.id);
    expect(json.user.avatar).toBeDefined();
  });

  test("fails for non-existent user", async () => {
    const { json } = await api(
      "GET",
      "/api/score/00000000-0000-0000-0000-000000000000",
      null,
      "invalidtoken123",
    );
    expect(json.success).toBe(false);
  });

  test("rejects requests for another user's score", async () => {
    const owner = await registerUser("score_owner_" + Date.now());
    const other = await registerUser("score_other_" + Date.now());

    const { json } = await api(
      "GET",
      `/api/score/${owner.user.id}`,
      null,
      other.token,
    );
    expect(json.success).toBe(false);
    expect(json.message).toContain("Forbidden");
  });
});

describe("GET /api/history/:userId", () => {
  test("returns game history", async () => {
    const reg = await registerUser("hist_test_" + Date.now());
    // Play a round to generate history
    const { json: q } = await api(
      "GET",
      "/api/questions/next",
      null,
      reg.token,
    );
    await api(
      "POST",
      "/api/answer",
      { questionId: q.question.id, userAnswer: "WRONG" },
      reg.token,
    );

    const { json } = await api("GET", `/api/history/${reg.user.id}`, null, reg.token);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.history)).toBe(true);
    expect(json.history.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  ROOM TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Room Management", () => {
  let master, player1, player2;

  beforeAll(async () => {
    master = await registerUser("master_" + Date.now());
    player1 = await registerUser("player1_" + Date.now());
    player2 = await registerUser("player2_" + Date.now());
  });

  test("creates a room", async () => {
    const { json } = await api(
      "POST",
      "/api/rooms",
      { maxPlayers: 4, questionCount: 3 },
      master.token,
    );
    expect(json.success).toBe(true);
    expect(json.room.code).toBeDefined();
    expect(json.room.code.length).toBe(6);
    expect(json.room.settings.max_players).toBe(4);
    expect(json.room.settings.question_delay_seconds).toBe(10);
  });

  test("joins a room", async () => {
    // Get room code first
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;

    const { json } = await api(
      "POST",
      `/api/rooms/${code}/join`,
      null,
      player1.token,
    );
    expect(json.success).toBe(true);
    expect(json.room.players.length).toBe(2);
  });

  test("rejects joining full room", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      { maxPlayers: 2 },
      master.token,
    );
    const code = created.room.code;

    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    // Third player should be rejected
    const { json } = await api(
      "POST",
      `/api/rooms/${code}/join`,
      null,
      player2.token,
    );
    expect(json.success).toBe(false);
    expect(json.message).toContain("full");
  });

  test("gets room info", async () => {
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    const { json } = await api("GET", `/api/rooms/${code}`, null, master.token);
    expect(json.success).toBe(true);
    expect(json.room.players.length).toBe(2);
    expect(json.room.masterId).toBe(master.user.id);
  });

  test("toggle ready", async () => {
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    const { json } = await api(
      "POST",
      `/api/rooms/${code}/ready`,
      null,
      player1.token,
    );
    expect(json.success).toBe(true);
    expect(json.isReady).toBe(true);
  });

  test("master can kick player", async () => {
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    const { json } = await api(
      "POST",
      `/api/rooms/${code}/kick`,
      { targetUserId: player1.user.id, code },
      master.token,
    );
    expect(json.success).toBe(true);
  });

  test("non-master cannot kick", async () => {
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    const { json } = await api(
      "POST",
      `/api/rooms/${code}/kick`,
      { targetUserId: master.user.id, code },
      player1.token,
    );
    expect(json.success).toBe(false);
    expect(json.message).toContain("master");
  });

  test("leave room", async () => {
    const { json: created } = await api("POST", "/api/rooms", {}, master.token);
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);

    const { json } = await api(
      "POST",
      `/api/rooms/${code}/leave`,
      null,
      player1.token,
    );
    expect(json.success).toBe(true);
  });

  test("finishes a custom-question multiplayer game after all players answer", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionCount: 1,
        questionSource: "custom",
        questionDelaySeconds: 0,
        customQuestions: [
          {
            text: "Pick the safe answer",
            options: ["safe", "unsafe", "maybe", "none"],
            correct_answer: "safe",
          },
        ],
      },
      master.token,
    );
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const started = await api("POST", `/api/rooms/${code}/start`, null, master.token);
    expect(started.json.success).toBe(true);

    const firstAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "safe", questionOrder: 1 },
      master.token,
    );
    expect(firstAnswer.json.success).toBe(true);
    expect(firstAnswer.json.gameOver).toBeUndefined();

    const secondAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "safe", questionOrder: 1 },
      player1.token,
    );
    expect(secondAnswer.json.success).toBe(true);
    expect(secondAnswer.json.gameOverScheduled).toBe(true);

    await wait(100);

    const restored = await api("GET", `/api/rooms/${code}/state`, null, master.token);
    expect(restored.json.success).toBe(true);
    expect(restored.json.finished).toBe(true);
    expect(restored.json.summary.length).toBe(2);
    expect(restored.json.summary[0].answers[0].questionText).toBe(
      "Pick the safe answer",
    );
  });

  test("advances everyone to the next question only after the configured delay", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionCount: 2,
        questionSource: "custom",
        questionDelaySeconds: 1,
        customQuestions: [
          {
            text: "First question",
            options: ["A", "B", "C", "D"],
            correct_answer: "A",
          },
          {
            text: "Second question",
            options: ["A", "B", "C", "D"],
            correct_answer: "B",
          },
        ],
      },
      master.token,
    );
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const started = await api("POST", `/api/rooms/${code}/start`, null, master.token);
    expect(started.json.success).toBe(true);

    await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "A", questionOrder: 1 },
      master.token,
    );
    const lastAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "A", questionOrder: 1 },
      player1.token,
    );
    expect(lastAnswer.json.success).toBe(true);
    expect(lastAnswer.json.nextQuestionScheduled).toBe(true);
    expect(lastAnswer.json.nextQuestion).toBeUndefined();

    const beforeDelay = await api(
      "GET",
      `/api/rooms/${code}/state`,
      null,
      master.token,
    );
    expect(beforeDelay.json.gameState.questionNumber).toBe(1);

    await wait(1200);

    const afterDelay = await api(
      "GET",
      `/api/rooms/${code}/state`,
      null,
      player1.token,
    );
    expect(afterDelay.json.gameState.questionNumber).toBe(2);
    expect(afterDelay.json.gameState.questions.all.text).toBe("Second question");
  });

  test("broadcasts transition and next question websocket messages to every player", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionCount: 2,
        questionSource: "custom",
        questionDelaySeconds: 1,
        customQuestions: [
          {
            text: "Socket first question",
            options: ["A", "B", "C", "D"],
            correct_answer: "A",
          },
          {
            text: "Socket second question",
            options: ["A", "B", "C", "D"],
            correct_answer: "B",
          },
        ],
      },
      master.token,
    );
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const masterSocket = await connectRoomSocket(master.token, code);
    const playerSocket = await connectRoomSocket(player1.token, code);

    try {
      const started = await api(
        "POST",
        `/api/rooms/${code}/start`,
        null,
        master.token,
      );
      expect(started.json.success).toBe(true);

      await Promise.all([
        masterSocket.waitFor(
          (message) => message.type === "game_started",
          "master game_started",
        ),
        playerSocket.waitFor(
          (message) => message.type === "game_started",
          "player game_started",
        ),
      ]);

      await api(
        "POST",
        `/api/rooms/${code}/answer`,
        { answer: "A", questionOrder: 1 },
        master.token,
      );
      const lastAnswer = await api(
        "POST",
        `/api/rooms/${code}/answer`,
        { answer: "A", questionOrder: 1 },
        player1.token,
      );
      expect(lastAnswer.json.success).toBe(true);
      expect(lastAnswer.json.nextQuestionScheduled).toBe(true);

      const transitions = await Promise.all([
        masterSocket.waitFor(
          (message) =>
            message.type === "question_transition_scheduled" &&
            message.questionNumber === 1 &&
            message.nextQuestionNumber === 2,
          "master transition",
        ),
        playerSocket.waitFor(
          (message) =>
            message.type === "question_transition_scheduled" &&
            message.questionNumber === 1 &&
            message.nextQuestionNumber === 2,
          "player transition",
        ),
      ]);
      expect(transitions.every((message) => message.gameOver === false)).toBe(true);

      const nextQuestions = await Promise.all([
        masterSocket.waitFor(
          (message) =>
            message.type === "next_question" && message.questionNumber === 2,
          "master next_question",
        ),
        playerSocket.waitFor(
          (message) =>
            message.type === "next_question" && message.questionNumber === 2,
          "player next_question",
        ),
      ]);
      expect(nextQuestions[0].questions.all.text).toBe("Socket second question");
      expect(nextQuestions[1].questions.all.text).toBe("Socket second question");
    } finally {
      closeTrackedSocket(masterSocket);
      closeTrackedSocket(playerSocket);
    }
  });

  test("starts timed custom questions with question metadata", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionSource: "custom",
        questionDelaySeconds: 0,
        timePerQuestion: 30,
        customQuestions: [
          {
            text: "The sky can be blue",
            type: "true_false",
            correct_answer: "True",
          },
          {
            text: "Type the word alpha",
            type: "fill_blank",
            correct_answer: "alpha",
          },
        ],
      },
      master.token,
    );
    expect(created.success).toBe(true);
    expect(created.room.settings.time_per_question_seconds).toBe(30);
    const code = created.room.code;

    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const started = await api("POST", `/api/rooms/${code}/start`, null, master.token);
    expect(started.json.success).toBe(true);
    expect(started.json.timePerQuestionSeconds).toBe(30);
    expect(Date.parse(started.json.questionStartedAt)).not.toBeNaN();
    expect(started.json.questions.all.type).toBe("true_false");
    expect(started.json.questions.all.options).toEqual(["True", "False"]);

    const state = await api("GET", `/api/rooms/${code}/state`, null, player1.token);
    expect(state.json.success).toBe(true);
    expect(state.json.gameState.timePerQuestionSeconds).toBe(30);
    expect(state.json.gameState.questionStartedAt).toBe(started.json.questionStartedAt);
    expect(state.json.gameState.questions.all.type).toBe("true_false");
  });

  test("tracks streak bonuses and returns a realtime leaderboard", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionSource: "custom",
        questionDelaySeconds: 0,
        customQuestions: [
          {
            text: "First streak question",
            options: ["A", "B", "C", "D"],
            correct_answer: "A",
          },
          {
            text: "Second streak question",
            type: "fill_blank",
            correct_answer: "alpha",
          },
          {
            text: "Third streak question",
            type: "true_false",
            correct_answer: "True",
          },
        ],
      },
      master.token,
    );
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const started = await api("POST", `/api/rooms/${code}/start`, null, master.token);
    expect(started.json.success).toBe(true);

    let masterAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "A", questionOrder: 1 },
      master.token,
    );
    expect(masterAnswer.json.score).toBe(10);
    expect(masterAnswer.json.streak).toBe(1);
    await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "B", questionOrder: 1 },
      player1.token,
    );
    await wait(100);

    masterAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: " Alpha ", questionOrder: 2 },
      master.token,
    );
    expect(masterAnswer.json.score).toBe(20);
    expect(masterAnswer.json.streak).toBe(2);
    await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "wrong", questionOrder: 2 },
      player1.token,
    );
    await wait(100);

    masterAnswer = await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "true", questionOrder: 3 },
      master.token,
    );
    expect(masterAnswer.json.score).toBe(35);
    expect(masterAnswer.json.streak).toBe(3);
    expect(masterAnswer.json.streakBonus).toBe(5);
    await api(
      "POST",
      `/api/rooms/${code}/answer`,
      { answer: "False", questionOrder: 3 },
      player1.token,
    );
    await wait(100);

    const leaderboard = await api(
      "GET",
      `/api/rooms/${code}/leaderboard`,
      null,
      master.token,
    );
    expect(leaderboard.json.success).toBe(true);
    expect(leaderboard.json.leaderboard[0]).toMatchObject({
      userId: master.user.id,
      rank: 1,
      score: 35,
      streak: 3,
      isCurrentUser: true,
    });
    expect(leaderboard.json.leaderboard[1]).toMatchObject({
      userId: player1.user.id,
      rank: 2,
      score: 0,
      streak: 0,
      isCurrentUser: false,
    });
  });

  test("auto-marks unanswered players wrong when the question timer expires", async () => {
    const { json: created } = await api(
      "POST",
      "/api/rooms",
      {
        maxPlayers: 2,
        questionSource: "custom",
        questionDelaySeconds: 0,
        timePerQuestion: 1,
        customQuestions: [
          {
            text: "Timed question",
            options: ["A", "B", "C", "D"],
            correct_answer: "A",
          },
        ],
      },
      master.token,
    );
    const code = created.room.code;
    await api("POST", `/api/rooms/${code}/join`, null, player1.token);
    await api("POST", `/api/rooms/${code}/ready`, null, player1.token);

    const started = await api("POST", `/api/rooms/${code}/start`, null, master.token);
    expect(started.json.success).toBe(true);

    await wait(1300);

    const restored = await api("GET", `/api/rooms/${code}/state`, null, master.token);
    expect(restored.json.success).toBe(true);
    expect(restored.json.finished).toBe(true);
    expect(restored.json.summary).toHaveLength(2);
    expect(restored.json.summary.every((player) => player.score === 0)).toBe(true);
    expect(
      restored.json.summary.every(
        (player) =>
          player.totalAnswered === 1 &&
          player.answers[0].userAnswer === "" &&
          player.answers[0].isCorrect === false,
      ),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  FULL GAME FLOW
// ═══════════════════════════════════════════════════════════════════

describe("Full Game Flow", () => {
  test("register → answer 5 questions → check final score", async () => {
    const reg = await registerUser("flow_" + Date.now());
    let totalScore = 0;

    for (let i = 0; i < 5; i++) {
      const { json: q } = await api(
        "GET",
        "/api/questions/next",
        null,
        reg.token,
      );
      expect(q.success).toBe(true);

      const row = await testPool.query(
        "SELECT correct_answer FROM questions WHERE id = $1",
        [q.question.id],
      );

      const { json: ans } = await api(
        "POST",
        "/api/answer",
        {
          questionId: q.question.id,
          userAnswer: row.rows[0].correct_answer,
        },
        reg.token,
      );
      expect(ans.success).toBe(true);
      totalScore += ans.isCorrect ? 10 : 0;
    }

    const { json: score } = await api("GET", `/api/score/${reg.user.id}`, null, reg.token);
    expect(score.success).toBe(true);
    expect(score.user.total_score).toBe(totalScore);
  });
});
