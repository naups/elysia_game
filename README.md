# 🎮 Elysia Game — Trivia Quiz

A web-based trivia quiz game built with **ElysiaJS** (Bun runtime) and **PostgreSQL**. Players register, answer 5 random questions per round, and accumulate scores across sessions.

![Elysia](https://img.shields.io/badge/Elysia-1.4-blue)
![Bun](https://img.shields.io/badge/Bun-1.3-orange)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-blue)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Game Flow](#game-flow)
- [Installation](#installation)
- [Running the App](#running-the-app)
- [Testing](#testing)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)

---

## Features

- **User Registration** — Username-based, no password required
- **Randomized Questions** — Pulled randomly from database, no repeats per session
- **Score Tracking** — Persistent scores stored in PostgreSQL
- **Session Persistence** — Login state saved in `localStorage`
- **Responsive UI** — Works on desktop and mobile
- **Progress Bar** — Visual indicator of quiz progress (1/5, 2/5, ...)
- **Instant Feedback** — Green/red highlight for correct/wrong answers
- **Game History** — Tracks every answer per user

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh/) |
| Backend | [ElysiaJS](https://elysiajs.com/) |
| Database | PostgreSQL 14+ |
| DB Client | `pg` (node-postgres) |
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Static Files | `@elysiajs/static` |
| CORS | `@elysiajs/cors` |

---

## Project Structure

```
elysia_game/
├── public/
│   └── index.html          # Frontend — single-page app
├── database.js             # PostgreSQL connection pool
├── server.js               # ElysiaJS server + all API endpoints
├── server.test.js          # Bun test suite (17 test cases)
├── schema.sql              # Database schema + sample questions
├── package.json            # Dependencies and scripts
├── .env.example            # Environment variable template
├── .gitignore
├── AGENT.md
└── issue.md
```

**Key files:**

- `server.js` — Main application file. Defines all routes, middleware (CORS, static files), error handling, and the database helper functions.
- `database.js` — Creates and exports a `pg.Pool` instance using the `DATABASE_URL` environment variable.
- `public/index.html` — Complete frontend in a single file (HTML + CSS + JS). Handles login, quiz rendering, answer submission, and result display.
- `schema.sql` — DDL for the 3 tables plus 10 sample trivia questions.

---

## Database Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    total_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Questions table
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    options JSONB NOT NULL      -- e.g. ["A", "B", "C", "D"]
);

-- Game history log
CREATE TABLE game_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    question_id INTEGER REFERENCES questions(id),
    is_correct BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Relationships:**
- `game_history.user_id` → `users.id` (FK)
- `game_history.question_id` → `questions.id` (FK)

---

## API Reference

### Register User

```
POST /api/register
Content-Type: application/json
```

**Request:**
```json
{ "username": "player1" }
```

**Response (200):**
```json
{
  "success": true,
  "user": {
    "id": "uuid-here",
    "username": "player1",
    "total_score": 0
  }
}
```

---

### Get Next Question

```
GET /api/questions/next
X-User-Id: <uuid>
```

**Response (200):**
```json
{
  "success": true,
  "question": {
    "id": 3,
    "text": "Which planet is known as the Red Planet?",
    "options": ["Venus", "Mars", "Jupiter", "Saturn"]
  },
  "currentScore": 20
}
```

> Questions already answered by the user are excluded automatically.

---

### Submit Answer

```
POST /api/answer
Content-Type: application/json
```

**Request:**
```json
{
  "questionId": 3,
  "userAnswer": "Mars",
  "userId": "uuid-here"
}
```

**Response (200):**
```json
{
  "success": true,
  "isNewScore": true,
  "isCorrect": true,
  "score": 30,
  "correctAnswer": "Mars"
}
```

- Correct answer → +10 points
- Wrong answer → +0 points
- Comparison is **case-insensitive**

---

### Get User Score

```
GET /api/score/:userId
```

**Response (200):**
```json
{
  "success": true,
  "user": {
    "id": "uuid-here",
    "username": "player1",
    "total_score": 50
  }
}
```

---

### Get Game History

```
GET /api/history/:userId
```

**Response (200):**
```json
{
  "success": true,
  "history": [
    {
      "id": 1,
      "user_id": "uuid",
      "question_id": 3,
      "is_correct": true,
      "question_text": "Which planet is known as the Red Planet?",
      "correct_answer": "Mars"
    }
  ]
}
```

Returns the last 20 entries, ordered by most recent.

---

## Game Flow

```
┌──────────────┐
│  Login Page  │──── Enter username ───┐
└──────────────┘                       │
                                       ▼
                            ┌──────────────────┐
                            │  POST /register  │
                            └──────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │ GET /questions   │
                            │     /next        │──┐
                            └──────────────────┘  │
                                       │          │
                                       ▼          │
                            ┌──────────────────┐  │
                            │  Show Question   │  │
                            └──────────────────┘  │
                                       │          │
                              User answers        │
                                       │          │
                                       ▼          │
                            ┌──────────────────┐  │
                            │  POST /answer    │  │
                            └──────────────────┘  │
                                       │          │
                              ┌────────┴────────┐ │
                              │  questions < 5? │ │
                              └────────┬────────┘ │
                                 Yes ──┘          │
                                      No          │
                                       ▼          │
                            ┌──────────────────┐  │
                            │  Result Screen   │  │
                            │  (Final Score)   │  │
                            └──────────────────┘  │
                                       │          │
                              Play Again?         │
                                  Yes ────────────┘
```

---

## Installation

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [PostgreSQL](https://www.postgresql.org/) v14+

### Steps

1. **Clone the repository**

```bash
git clone https://github.com/naups/elysia_game.git
cd elysia_game
```

2. **Install dependencies**

```bash
bun install
```

3. **Setup environment variables**

```bash
cp .env.example .env
```

Edit `.env` with your PostgreSQL credentials:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/elysia_game
```

4. **Create the database**

```bash
createdb elysia_game
```

5. **Run the schema**

```bash
psql -d elysia_game -f schema.sql
```

This creates the 3 tables and inserts 10 sample questions.

---

## Running the App

**Development (with hot reload):**
```bash
bun run dev
```

**Production:**
```bash
bun run start
```

The server starts at `http://localhost:3000`. Open it in your browser to play.

---

## Testing

The project includes 17 test cases covering all endpoints and edge cases.

```bash
bun test
```

**What's tested:**
- User registration (success, duplicate, validation)
- Question fetching (valid user, missing header, invalid user)
- Answer submission (correct, wrong, case-insensitive, missing fields)
- Score retrieval
- Game history
- Full game flow (register → 5 questions → final score)

---

## Deployment

### Option 1: Railway

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) and create a new project
3. Add a **PostgreSQL** service from the template
4. Add a **Bun** service pointing to your repo
5. Set environment variables:
   - `DATABASE_URL` — auto-provided by Railway's PostgreSQL service
   - `PORT` — Railway sets this automatically
6. Set the start command: `bun run start`

### Option 2: Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login and launch
fly auth login
fly launch

# Add PostgreSQL
fly postgres create --name elysia-db

# Set secrets
fly secrets set DATABASE_URL="postgresql://user:pass@host:5432/elysia_game"

# Deploy
fly deploy
```

### Option 3: Docker

Create a `Dockerfile`:

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
EXPOSE 3000
CMD ["bun", "run", "start"]
```

```bash
docker build -t elysia-game .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/elysia_game" \
  elysia-game
```

### Option 4: VPS / Bare Metal

```bash
# On your server
git clone https://github.com/naups/elysia_game.git
cd elysia_game
bun install
cp .env.example .env
# Edit .env with your database credentials
bun run start
```

Use **pm2** for process management:

```bash
bun add -g pm2
pm2 start server.js --name elysia-game
pm2 save
pm2 startup
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server listening port |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |

---

## License

ISC
