# Task Checklist — Multiplayer Trivia Quiz

## Phase 1: Auth & Session Security

- [x] 1.1 Add `sessions` table to schema (token, user_id, expires_at)
- [x] 1.2 Create `POST /api/register` — returns session token (or register+login combo)
- [x] 1.3 Create `POST /api/logout` — invalidates session token
- [x] 1.4 Create middleware to validate session token on all protected endpoints
- [x] 1.5 Update frontend: store token in localStorage, send via `Authorization` header
- [x] 1.6 Add logout button to frontend UI
- [x] 1.7 Anti-tampering: server validates token ownership before any action

## Phase 2: Database & Schema for Multiplayer

- [x] 2.1 Add `rooms` table (id, code, master_id, settings JSONB, status, max_players, question_count, question_source, question_mode, result_mode)
- [x] 2.2 Add `room_players` table (room_id, user_id, is_ready, score, avatar_url, joined_at)
- [x] 2.3 Add `room_questions` table (room_id, question_id, custom_question JSONB, question_order)
- [x] 2.4 Add `room_answers` table (room_id, user_id, question_id, answer, is_correct, answered_at)
- [x] 2.5 Run schema migration

## Phase 3: Real-time WebSocket

- [x] 3.1 ~~Install `@elysiajs/websocket`~~ — Using Elysia built-in WebSocket
- [x] 3.2 Setup WebSocket endpoint `/ws`
- [x] 3.3 Implement message protocol (join_room, leave_room, ready, start_game, answer, kick, chat)
- [x] 3.4 Implement room state broadcasting to all connected clients
- [x] 3.5 Handle reconnection: client sends last known state, server restores session

## Phase 4: Room Management

- [x] 4.1 `POST /api/rooms` — create room (returns room code)
- [x] 4.2 `POST /api/rooms/:code/join` — join room by code
- [x] 4.3 `POST /api/rooms/:code/leave` — leave room
- [x] 4.4 `POST /api/rooms/:code/kick` — master kicks a player
- [x] 4.5 `POST /api/rooms/:code/ready` — toggle ready status
- [x] 4.6 `POST /api/rooms/:code/start` — master starts the game
- [x] 4.7 `GET /api/rooms/:code` — get room info + players

## Phase 5: Room Settings & Customization

- [x] 5.1 Room settings: max_players (2-10), question_count (3-20)
- [x] 5.2 Question source: `database` (from questions table) or `custom` (room master writes)
- [x] 5.3 Question mode: `random_per_player` (each gets different) or `same_for_all` (everyone sees same)
- [x] 5.4 Result mode: `instant` (show after each answer) or `end` (show summary at finish)
- [x] 5.5 Store settings in room creation + validate on game start
- [x] 5.6 Custom question editor UI for room master

## Phase 6: Avatars

- [x] 6.1 Generate deterministic avatar URL from username (DiceBear API)
- [x] 6.2 Store avatar_url in users table or compute on-the-fly
- [x] 6.3 Display avatars in lobby, room, and results

## Phase 7: Multiplayer Game Flow

- [x] 7.1 Lobby screen: create/join room
- [x] 7.2 Room screen: player list with avatars, ready status, room code display
- [x] 7.3 Master controls: kick, settings, start button
- [x] 7.4 Quiz screen: adapted for multiplayer (timer, real-time answer feedback)
- [x] 7.5 Handle `same_for_all` mode: server sends same question to all
- [x] 7.6 Handle `random_per_player` mode: server sends different question per player
- [x] 7.7 Handle `instant` result mode: show correct/wrong immediately
- [x] 7.8 Handle `end` result mode: skip feedback, go to next question

## Phase 8: Quiz Summary

- [x] 8.1 Summary screen: accuracy percentage per player
- [x] 8.2 Summary screen: detailed answer breakdown (each question, user answer, correct answer)
- [x] 8.3 Summary screen: ranking by score (1st, 2nd, 3rd...)
- [x] 8.4 Summary screen: highlight winner with trophy icon
- [x] 8.5 "Play Again" option to return to room with same settings

## Phase 9: Reconnection

- [x] 9.1 Store session token + room code in localStorage
- [x] 9.2 On page load: validate token, check if user is in active room
- [x] 9.3 If room is still active: reconnect to WebSocket, restore state
- [x] 9.4 If room ended: go to lobby
- [x] 9.5 Handle edge case: user disconnected mid-quiz, reconnect with same progress

## Phase 10: Testing & Polish

- [x] 10.1 Update test suite for new endpoints
- [ ] 10.2 Test multiplayer flow with 2+ simulated clients
- [ ] 10.3 Test reconnection scenarios
- [ ] 10.4 Test edge cases: master leaves, all players leave, room timeout
- [ ] 10.5 Update README.md with multiplayer documentation
- [ ] 10.6 Update issue.md checklist

---

**Status:** In Progress
**Current Phase:** Phase 10 — Testing & Polish
