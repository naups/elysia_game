/**
 * Unit Tests: Trivia Quiz Game API
 *
 * Tests cover:
 *  1. POST /api/register
 *  2. GET  /api/questions/next
 *  3. POST /api/answer (correct & wrong)
 *  4. GET  /api/score/:userId
 *  5. GET  /api/history/:userId
 *  6. Full game flow (register → answer 5 questions → final score)
 *  7. Edge cases (missing fields, invalid user, etc.)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import pg from "pg";
import "dotenv/config";

// ── Re-import app & pool from server modules ──────────────────────
// We need a clean pool for test assertions
const { Pool } = pg;
const testPool = new Pool({ connectionString: process.env.DATABASE_URL });

// We import the built app by re-executing the server module.
// However server.js calls app.listen() which starts the server.
// Instead we'll import the Elysia app and use app.handle().
// For that we need to refactor server.js to export `app` — but since
// we can't change the running server, we'll test via HTTP against the
// live server. Start it first, then run tests.

let BASE = "http://localhost:3456";
let serverProcess = null;

// ── Start server for testing ──────────────────────────────────────
beforeAll(async () => {
  // Start the server as a child process on port 3456
  serverProcess = Bun.spawn(["bun", "run", "server.js"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: "3456" },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for server to be ready
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
async function api(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  return { status: res.status, json: await res.json() };
}

// ═══════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════

describe("POST /api/register", () => {
  test("registers a new user successfully", async () => {
    const { status, json } = await api("POST", "/api/register", {
      username: "testuser_" + Date.now(),
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.user).toBeDefined();
    expect(json.user.id).toBeDefined();
    expect(json.user.username).toBeDefined();
    expect(json.user.total_score).toBe(0);
  });

  test("rejects username shorter than 2 characters", async () => {
    const { json } = await api("POST", "/api/register", { username: "a" });
    expect(json.success).toBe(false);
    expect(json.message).toContain("2 characters");
  });

  test("rejects empty username", async () => {
    const { json } = await api("POST", "/api/register", { username: "" });
    expect(json.success).toBe(false);
  });

  test("rejects missing body", async () => {
    const { json } = await api("POST", "/api/register", {});
    expect(json.success).toBe(false);
  });

  test("rejects duplicate username", async () => {
    const name = "dup_user_" + Date.now();
    await api("POST", "/api/register", { username: name });
    const { json } = await api("POST", "/api/register", { username: name });
    expect(json.success).toBe(false);
    expect(json.message).toContain("already exists");
  });
});

describe("GET /api/questions/next", () => {
  let userId;

  beforeAll(async () => {
    const { json } = await api("POST", "/api/register", {
      username: "qtest_" + Date.now(),
    });
    userId = json.user.id;
  });

  test("returns a question for valid user", async () => {
    const { status, json } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": userId,
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.question).toBeDefined();
    expect(json.question.id).toBeDefined();
    expect(json.question.text).toBeDefined();
    expect(Array.isArray(json.question.options)).toBe(true);
    expect(json.question.options.length).toBe(4);
    expect(typeof json.currentScore).toBe("number");
  });

  test("fails without X-User-Id header", async () => {
    const { json } = await api("GET", "/api/questions/next");
    expect(json.success).toBe(false);
    expect(json.message).toContain("User ID required");
  });

  test("fails with non-existent user", async () => {
    const { json } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": "00000000-0000-0000-0000-000000000000",
    });
    expect(json.success).toBe(false);
    expect(json.message).toContain("User not found");
  });
});

describe("POST /api/answer", () => {
  let userId;
  let questionId;

  beforeAll(async () => {
    const { json: reg } = await api("POST", "/api/register", {
      username: "ans_test_" + Date.now(),
    });
    userId = reg.user.id;

    const { json: q } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": userId,
    });
    questionId = q.question.id;
  });

  test("accepts a correct answer and awards 10 points", async () => {
    // Get the correct answer first
    const row = await testPool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [questionId]
    );
    const correctAnswer = row.rows[0].correct_answer;

    const { json } = await api("POST", "/api/answer", {
      questionId,
      userAnswer: correctAnswer,
      userId,
    });

    expect(json.success).toBe(true);
    expect(json.isCorrect).toBe(true);
    expect(json.score).toBe(10);
    expect(json.correctAnswer).toBe(correctAnswer);
  });

  test("accepts a wrong answer and awards 0 points", async () => {
    const { json: q } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": userId,
    });

    const wrongAnswer = "DEFINITELY_WRONG_ANSWER";
    const { json } = await api("POST", "/api/answer", {
      questionId: q.question.id,
      userAnswer: wrongAnswer,
      userId,
    });

    expect(json.success).toBe(true);
    expect(json.isCorrect).toBe(false);
    expect(json.score).toBe(10); // still 10 from previous correct
  });

  test("case-insensitive answer comparison", async () => {
    const { json: q } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": userId,
    });

    const row = await testPool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [q.question.id]
    );
    const correctAnswer = row.rows[0].correct_answer;

    const { json } = await api("POST", "/api/answer", {
      questionId: q.question.id,
      userAnswer: correctAnswer.toLowerCase(),
      userId,
    });

    expect(json.success).toBe(true);
    expect(json.isCorrect).toBe(true);
  });

  test("rejects missing required fields", async () => {
    const { json } = await api("POST", "/api/answer", {});
    expect(json.success).toBe(false);
    expect(json.message).toContain("Missing");
  });

  test("rejects non-existent questionId", async () => {
    const { json } = await api("POST", "/api/answer", {
      questionId: 99999,
      userAnswer: "A",
      userId,
    });
    expect(json.success).toBe(false);
    expect(json.message).toContain("Question not found");
  });
});

describe("GET /api/score/:userId", () => {
  let userId;

  beforeAll(async () => {
    const { json } = await api("POST", "/api/register", {
      username: "score_test_" + Date.now(),
    });
    userId = json.user.id;
  });

  test("returns user score", async () => {
    const { json } = await api("GET", `/api/score/${userId}`);
    expect(json.success).toBe(true);
    expect(json.user.id).toBe(userId);
    expect(typeof json.user.total_score).toBe("number");
  });

  test("fails for non-existent user", async () => {
    const { json } = await api(
      "GET",
      "/api/score/00000000-0000-0000-0000-000000000000"
    );
    expect(json.success).toBe(false);
  });
});

describe("GET /api/history/:userId", () => {
  let userId;

  beforeAll(async () => {
    const { json } = await api("POST", "/api/register", {
      username: "hist_test_" + Date.now(),
    });
    userId = json.user.id;

    // Play a round to generate history
    const { json: q } = await api("GET", "/api/questions/next", null, {
      "X-User-Id": userId,
    });
    await api("POST", "/api/answer", {
      questionId: q.question.id,
      userAnswer: "WRONG",
      userId,
    });
  });

  test("returns game history", async () => {
    const { json } = await api("GET", `/api/history/${userId}`);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.history)).toBe(true);
    expect(json.history.length).toBeGreaterThan(0);
    expect(json.history[0].question_text).toBeDefined();
    expect(json.history[0].is_correct).toBeDefined();
  });
});

describe("Full Game Flow", () => {
  test("register → answer 5 questions → check final score", async () => {
    // 1. Register
    const { json: reg } = await api("POST", "/api/register", {
      username: "flow_" + Date.now(),
    });
    expect(reg.success).toBe(true);
    const userId = reg.user.id;

    let totalScore = 0;

    // 2. Answer 5 questions
    for (let i = 0; i < 5; i++) {
      const { json: q } = await api("GET", "/api/questions/next", null, {
        "X-User-Id": userId,
      });
      expect(q.success).toBe(true);
      expect(q.question).toBeDefined();

      // Answer correctly
      const row = await testPool.query(
        "SELECT correct_answer FROM questions WHERE id = $1",
        [q.question.id]
      );
      const { json: ans } = await api("POST", "/api/answer", {
        questionId: q.question.id,
        userAnswer: row.rows[0].correct_answer,
        userId,
      });
      expect(ans.success).toBe(true);
      totalScore += ans.isCorrect ? 10 : 0;
    }

    // 3. Verify final score
    const { json: score } = await api("GET", `/api/score/${userId}`);
    expect(score.success).toBe(true);
    expect(score.user.total_score).toBe(totalScore);

    // 4. Verify history
    const { json: hist } = await api("GET", `/api/history/${userId}`);
    expect(hist.success).toBe(true);
    expect(hist.history.length).toBe(5);
  });
});
