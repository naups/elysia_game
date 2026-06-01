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

// ── Start server for testing ──────────────────────────────────────
beforeAll(async () => {
  serverProcess = Bun.spawn(["bun", "run", "server.js"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: "3456" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Promise((r) => setTimeout(r, 2000));
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
});

// ═══════════════════════════════════════════════════════════════════
//  SCORE & HISTORY TESTS
// ═══════════════════════════════════════════════════════════════════

describe("GET /api/score/:userId", () => {
  test("returns user score with avatar", async () => {
    const reg = await registerUser("score_test_" + Date.now());
    const { json } = await api("GET", `/api/score/${reg.user.id}`);
    expect(json.success).toBe(true);
    expect(json.user.id).toBe(reg.user.id);
    expect(json.user.avatar).toBeDefined();
  });

  test("fails for non-existent user", async () => {
    const { json } = await api(
      "GET",
      "/api/score/00000000-0000-0000-0000-000000000000",
    );
    expect(json.success).toBe(false);
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

    const { json } = await api("GET", `/api/history/${reg.user.id}`);
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

    const { json: score } = await api("GET", `/api/score/${reg.user.id}`);
    expect(score.success).toBe(true);
    expect(score.user.total_score).toBe(totalScore);
  });
});
