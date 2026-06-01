import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(
    "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_question_order INTEGER DEFAULT 0",
  );
  console.log("OK: Added current_question_order column");
} catch (e) {
  console.log("SKIP:", e.message);
}

await pool.end();
console.log("Migration complete");
