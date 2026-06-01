import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const migrations = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(6) NOT NULL UNIQUE,
    master_id UUID REFERENCES users(id),
    settings JSONB NOT NULL DEFAULT '{"max_players":6,"question_count":5,"question_source":"database","question_mode":"same_for_all","result_mode":"instant","custom_questions":[]}',
    status VARCHAR(20) DEFAULT 'waiting',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS room_players (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    is_ready BOOLEAN DEFAULT FALSE,
    score INTEGER DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS room_questions (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id),
    custom_question JSONB,
    question_order INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_answers (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    question_id INTEGER,
    answer TEXT,
    is_correct BOOLEAN,
    answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
];

for (const sql of migrations) {
  try {
    await pool.query(sql);
    console.log("OK:", sql.substring(0, 60).replace(/\n/g, " "));
  } catch (e) {
    console.log("SKIP:", e.message);
  }
}

await pool.end();
console.log("Migration complete");
