---

# Issue: Implementasi Game Web App (ElysiaJS + PostgreSQL)

**Status:** `To Do`  
**Priority:** `High`  
**Assignee:** `@JuniorDev` / `@AI_Assistant`  
**Label:** `backend`, `frontend`, `database`, `game-logic`

---

## 1. Deskripsi Singkat

Tujuan dari issue ini adalah membangun aplikasi berbasis web sederhana (Game) menggunakan **ElysiaJS** untuk backend dan **PostgreSQL** untuk menyimpan data. Fokus utama adalah pada alur logika permainan yang jelas dan interaksi database yang efisien.

## 2. Tech Stack

Pastikan menggunakan versi berikut agar kompatibel:

- **Runtime:** Node.js (v18+)
- **Backend Framework:** ElysiaJS (`npm install elysia`)
- **Database:** PostgreSQL (v14+)
- **Database Client:** `pg` atau `pg-promise` (untuk ElysiaJS)
- **Frontend:** HTML, CSS, Vanilla JavaScript (tanpa framework berat seperti React/Vue untuk efisiensi)

## 3. Desain Database (PostgreSQL)

Buat skema database sesuai spesifikasi berikut. Pastikan kolom `id` menggunakan `SERIAL` atau `UUID` (disarankan UUID v4 untuk keamanan).

```sql
-- Tabel Users (Penyimpanan Skor)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    total_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Game Data (Konten Permainan)
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    options JSONB NOT NULL -- Array jawaban pilihan
);

-- Tabel History (Opsional, untuk log permainan)
CREATE TABLE game_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    question_id INTEGER REFERENCES questions(id),
    is_correct BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 4. Logika Algoritma Permainan

Game yang akan dibuat adalah **"Trivia Quiz"**. Berikut adalah alur penyelesaian logika (Flowchart):

1.  **Inisialisasi:**
    - Backend memanggil database untuk mengambil 5 pertanyaan acak.
    - Frontend menampilkan pertanyaan 1.

2.  **Input Pengguna:**
    - Pengguna memilih salah satu opsi jawaban (A, B, C, atau D).
    - Frontend mengirim data ke Backend via API `POST /api/answer`.

3.  **Validasi (Backend):**
    - Backend menerima jawaban pengguna.
    - Backend membandingkan jawaban pengguna dengan `correct_answer` di database.
    - Hitung skor: Jika benar, `+10 poin`. Jika salah, `0 poin`.

4.  **Penyimpanan:**
    - Simpan hasil jawaban ke tabel `game_history`.
    - Update total skor pengguna di tabel `users`.

5.  **Transisi ke Selanjutnya:**
    - Jika soal habis: Menampilkan skor akhir dan tombol "Main Lagi".
    - Jika soal belum habis: Kirim pertanyaan berikutnya.

## 5. Spesifikasi API Endpoints (ElysiaJS)

Gunakan struktur RESTful sederhana. Pastikan validasi input menggunakan ElysiaJS built-in validators.

### A. Endpoint: Mendapatkan Pertanyaan

- **Method:** `GET`
- **Path:** `/api/questions/next`
- **Request:** `Authorization` (Bisa Token Sederhana atau Session).
- **Response:** JSON Object
  ```json
  {
    "question": {
      "id": 1,
      "text": "...",
      "options": ["A", "B", "C", "D"],
      "correct": "B"
    },
    "currentScore": 50
  }
  ```

### B. Endpoint: Menjawab Soal

- **Method:** `POST`
- **Path:** `/api/answer`
- **Request Body:**
  ```json
  {
    "questionId": 1,
    "userAnswer": "C",
    "userId": "uuid-tersebut"
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "isNewScore": false,
    "score": 50,
    "nextQuestionId": 2
  }
  ```

### C. Endpoint: Registrasi User

- **Method:** `POST`
- **Path:** `/api/register`
- **Response:** Return `userId` untuk sesi login.

## 6. Implementasi Frontend (Klien)

- Gunakan HTML5 + CSS Grid/Flexbox untuk layout.
- **UI:**
  - Tampilan Kartu (Card) untuk pertanyaan.
  - Tombol pilihan ganda yang interaktif (berubah warna saat diklik).
  - Progress Bar (Contoh: Soal 1/5).
- **Logika JS:**
  - Gunakan `async/await` saat memanggil API.
  - Tampilkan loading state saat menunggu response dari server.
  - Tampilkan pesan "Benar/Salah" dengan warna hijau/merah.

## 7. Langkah Kerja (To-Do List)

- [x] Setup project `npm init` dan install `elysia`, `pg`, `cors`.
- [x] Buat file `database.js` untuk koneksi ke PostgreSQL.
- [x] Implementasi Schema SQL di database instance.
- [x] Buat file `server.js` dan definisikan endpoint sesuai bagian 5.
- [x] Buat file `index.html` (Frontend) sesuai bagian 6.
- [x] Test alur permainan (Benar -> Salah -> Selesai).
- [x] Perbaiki bug UI (Result screen muncul di awal).
- [ ] Push ke Branch `feature/game-implementation`.

## 8. Catatan Penting (Best Practices)

1.  **Security:** Jangan pernah menyimpan password di database. Gunakan hash (bcrypt) jika ada login.
2.  **Error Handling:** Jika database down, server harus mengembalikan error 500, bukan crash total.
3.  **Environment Variables:** Simpan password database di file `.env`, jangan di-kode langsung.
4.  **Performance:** Gunakan `LIMIT` dan `OFFSET` saat mengambil data pertanyaan agar tidak mengambil terlalu banyak data sekaligus.

## 9. Kriteria Selesai (Acceptance Criteria)

- User bisa mendaftarkan akun.
- User bisa bermain kuis dan skor tersimpan di database.
- Jika halaman di-refresh, skor tersimpan kembali (Persistence).
- Aplikasi tidak error saat koneksi database terputus (handled gracefully).

---

_Jika ada pertanyaan mengenai struktur kode atau SQL, silakan buat komentar di bawah issue ini._
