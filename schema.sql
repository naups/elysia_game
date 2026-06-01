-- Tabel Users (Penyimpanan Skor)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    total_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Game Data (Konten Permainan)
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    options JSONB NOT NULL -- Array jawaban pilihan
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
    master_id UUID REFERENCES users(id),
    settings JSONB NOT NULL DEFAULT '{
        "max_players": 6,
        "question_count": 5,
        "question_source": "database",
        "question_mode": "same_for_all",
        "result_mode": "instant",
        "custom_questions": []
    }',
    status VARCHAR(20) DEFAULT 'waiting',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Room Players
CREATE TABLE IF NOT EXISTS room_players (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    is_ready BOOLEAN DEFAULT FALSE,
    score INTEGER DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, user_id)
);

-- Tabel Room Questions (assigned per room)
CREATE TABLE IF NOT EXISTS room_questions (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id),
    custom_question JSONB,
    question_order INTEGER NOT NULL
);

-- Tabel Room Answers (per-player per-question)
CREATE TABLE IF NOT EXISTS room_answers (
    id SERIAL PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    question_id INTEGER,
    answer TEXT,
    is_correct BOOLEAN,
    answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel History (Opsional, untuk log permainan)
CREATE TABLE IF NOT EXISTS game_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    question_id INTEGER REFERENCES questions(id),
    is_correct BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
