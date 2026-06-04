import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_question_order INTEGER DEFAULT 0",
  );
  console.log("OK: Added current_question_order column");
  await pool.query(
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_question_started_at TIMESTAMPTZ",
  );
  console.log("OK: Added current_question_started_at column");
  await pool.query(
    "ALTER TABLE rooms ALTER COLUMN current_question_started_at TYPE TIMESTAMPTZ USING current_question_started_at AT TIME ZONE 'UTC'",
  );
  console.log("OK: Normalized current_question_started_at timezone");
  await pool.query(
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_type VARCHAR(20) DEFAULT 'multiple_choice'",
  );
  console.log("OK: Added questions.question_type column");
  await pool.query(
    "ALTER TABLE room_players ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0",
  );
  console.log("OK: Added room_players.streak column");
  await pool.query(
    "ALTER TABLE room_questions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
  );
  console.log("OK: Added room_questions.user_id column");
  await pool.query(
    "ALTER TABLE room_answers ADD COLUMN IF NOT EXISTS question_order INTEGER",
  );
  console.log("OK: Added room_answers.question_order column");
  await pool.query(
    "UPDATE room_answers SET question_order = COALESCE(question_order, question_id, 0) WHERE question_order IS NULL",
  );
  await pool.query(
    "ALTER TABLE room_answers ALTER COLUMN question_order SET NOT NULL",
  );
  console.log("OK: Backfilled room_answers.question_order");
  await pool.query(
    `UPDATE rooms
     SET settings = settings || '{"question_delay_seconds": 10}'::jsonb
     WHERE NOT (settings ? 'question_delay_seconds')`,
  );
  console.log("OK: Backfilled rooms.settings.question_delay_seconds");
  await pool.query(
    `UPDATE rooms
     SET settings = settings || '{"time_per_question_seconds": 0}'::jsonb
     WHERE NOT (settings ? 'time_per_question_seconds')`,
  );
  console.log("OK: Backfilled rooms.settings.time_per_question_seconds");
} catch (e) {
  console.log("SKIP:", e.message);
}

await pool.end();
console.log("Migration complete");
