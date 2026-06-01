import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import pool from "./database.js";
import "dotenv/config";

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

// Helper: Get random questions excluding those already answered by user
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

// Endpoint: Register User
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

    if (existingUser.rows.length > 0) {
      return { success: false, message: "Username already exists" };
    }

    const result = await pool.query(
      "INSERT INTO users (username) VALUES ($1) RETURNING id, username, total_score",
      [username.trim()],
    );

    return { success: true, user: result.rows[0] };
  } catch (error) {
    console.error("Register error:", error.message);
    return { success: false, message: "Failed to register user" };
  }
});

// Endpoint: Get Next Question
app.get("/api/questions/next", async ({ headers }) => {
  try {
    const userId = headers["x-user-id"];

    if (!userId || typeof userId !== "string") {
      return { success: false, message: "User ID required" };
    }

    const userResult = await pool.query(
      "SELECT total_score FROM users WHERE id = $1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return { success: false, message: "User not found" };
    }

    const currentScore = userResult.rows[0].total_score;

    const questions = await getRandomQuestions(userId, 1);
    if (questions.length === 0) {
      return { success: false, message: "No questions available" };
    }

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
        options: options,
      },
      currentScore,
    };
  } catch (error) {
    console.error("Get question error:", error.message);
    return { success: false, message: "Failed to get question" };
  }
});

// Endpoint: Submit Answer
app.post("/api/answer", async ({ body }) => {
  const questionId = body?.questionId;
  const userAnswer = body?.userAnswer;
  const userId = body?.userId;

  if (!questionId || !userAnswer || !userId) {
    return { success: false, message: "Missing required fields" };
  }

  try {
    const questionResult = await pool.query(
      "SELECT correct_answer FROM questions WHERE id = $1",
      [questionId],
    );

    if (questionResult.rows.length === 0) {
      return { success: false, message: "Question not found" };
    }

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

// Endpoint: Get User Score
app.get("/api/score/:userId", async ({ params }) => {
  const { userId } = params;

  try {
    const result = await pool.query(
      "SELECT id, username, total_score FROM users WHERE id = $1",
      [userId],
    );

    if (result.rows.length === 0) {
      return { success: false, message: "User not found" };
    }

    return { success: true, user: result.rows[0] };
  } catch (error) {
    console.error("Get score error:", error.message);
    return { success: false, message: "Failed to get score" };
  }
});

// Endpoint: Get Game History
app.get("/api/history/:userId", async ({ params }) => {
  const { userId } = params;

  try {
    const result = await pool.query(
      `SELECT gh.*, q.question_text, q.correct_answer
       FROM game_history gh
       JOIN questions q ON gh.question_id = q.id
       WHERE gh.user_id = $1
       ORDER BY gh.created_at DESC
       LIMIT 20`,
      [userId],
    );

    return { success: true, history: result.rows };
  } catch (error) {
    console.error("Get history error:", error.message);
    return { success: false, message: "Failed to get history" };
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🎮 Trivia Quiz Server running on http://localhost:${PORT}`);
  console.log(`📂 Frontend available at http://localhost:${PORT}/`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
});
