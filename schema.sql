CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tabel Users (Penyimpanan Skor)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT,
    auth_provider VARCHAR(50) DEFAULT 'local',
    total_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Tabel Game Data (Konten Permainan)
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 2),
    question_type VARCHAR(20) DEFAULT 'multiple_choice',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Sessions (Token-based auth)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

-- Tabel Rooms (Multiplayer rooms)
CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(6) NOT NULL UNIQUE,
    master_id UUID REFERENCES users(id) ON DELETE SET NULL,
    settings JSONB NOT NULL DEFAULT '{
        "max_players": 6,
        "question_count": 5,
        "question_source": "database",
        "question_mode": "same_for_all",
        "result_mode": "instant",
        "question_delay_seconds": 10,
        "time_per_question_seconds": 0,
        "room_idle_timeout_seconds": 1800,
        "custom_questions": []
    }',
    status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')),
    current_question_order INTEGER DEFAULT 0,
    current_question_started_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Room Players
CREATE TABLE IF NOT EXISTS room_players (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    is_ready BOOLEAN DEFAULT FALSE,
    score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
    streak INTEGER DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, user_id)
);

-- Tabel Room Questions (assigned per room)
CREATE TABLE IF NOT EXISTS room_questions (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
    custom_question JSONB CHECK (custom_question IS NULL OR (custom_question ? 'text' AND custom_question ? 'correct_answer')),
    question_order INTEGER NOT NULL
);

-- Tabel Room Answers (per-player per-question)
CREATE TABLE IF NOT EXISTS room_answers (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
    question_order INTEGER NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    is_correct BOOLEAN NOT NULL DEFAULT false,
    answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel History (Opsional, untuk log permainan)
CREATE TABLE IF NOT EXISTS game_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
    is_correct BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS game_history_one_answer_per_question
    ON game_history(user_id, question_id);

CREATE UNIQUE INDEX IF NOT EXISTS room_answers_one_answer_per_question
    ON room_answers(room_id, user_id, question_order);

CREATE UNIQUE INDEX IF NOT EXISTS room_questions_same_for_all_order
    ON room_questions(room_id, question_order)
    WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS room_questions_per_player_order
    ON room_questions(room_id, user_id, question_order)
    WHERE user_id IS NOT NULL;

-- Indexes for cleanup and frequent queries
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_rooms_status_activity ON rooms(last_activity_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id);
CREATE INDEX IF NOT EXISTS idx_room_answers_room_order ON room_answers(room_id, question_order);

-- Insert sample questions
INSERT INTO questions (question_text, correct_answer, options) VALUES
('What is the capital of France?', 'Paris', '["Paris", "London", "Berlin", "Madrid"]'),
('What is 2 + 2?', '4', '["3", "4", "5", "6"]'),
('Which planet is known as the Red Planet?', 'Mars', '["Venus", "Mars", "Jupiter", "Saturn"]'),
('What is the largest ocean on Earth?', 'Pacific Ocean', '["Atlantic Ocean", "Indian Ocean", "Pacific Ocean", "Arctic Ocean"]'),
('Who painted the Mona Lisa?', 'Leonardo da Vinci', '["Michelangelo", "Leonardo da Vinci", "Raphael", "Donatello"]'),
('What is the chemical symbol for water?', 'H2O', '["CO2", "H2O", "NaCl", "O2"]'),
('How many continents are there?', '7', '["5", "6", "7", "8"]'),
('What is the speed of light?', '299792458 m/s', '["150000000 m/s", "299792458 m/s", "400000000 m/s", "100000000 m/s"]'),
('Which language is used for web development?', 'JavaScript', '["Python", "JavaScript", "C++", "Java"]'),
('What does CPU stand for?', 'Central Processing Unit', '["Central Processing Unit", "Computer Personal Unit", "Central Program Utility", "Computer Processing Unit"]')
ON CONFLICT DO NOTHING;
