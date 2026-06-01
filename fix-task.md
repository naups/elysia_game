# Bug Fix Task List

## Bug 1: WS "not authenticated" di browser console

**Root Cause:** Di `connectWS()`, `join_room` dikirim langsung setelah `auth` tanpa menunggu response `auth_ok`. Server memproses `join_room` sebelum `ws.userId` ter-set, sehingga mengembalikan error "Not authenticated".

**Fix:**

- [x] 1.1 Buat queue untuk message yang perlu auth (seperti `join_room`)
- [x] 1.2 Tunggu `auth_ok` dari server sebelum kirim `join_room`
- [x] 1.3 Tambah flag `wsAuthenticated` dan kirim queued messages setelah auth sukses

---

## Bug 2: Refresh browser → room code hilang, kembali ke dashboard

**Root Cause:** Saat reconnect, `enterLobby()` dipanggil yang selalu ke lobby screen. `refreshRoomState()` dipanggil di handler `user_connected` tapi `currentUser` belum punya `avatar` (hanya `id` dan `username` dari localStorage). Juga, tidak ada navigasi otomatis ke room screen setelah reconnect sukses.

**Fix:**

- [x] 2.1 Setelah `validateSession()` sukses dan ada `savedRoomCode`, langsung fetch room state dan tampilkan room screen (bukan lobby)
- [x] 2.2 Simpan `avatar` di localStorage juga untuk restore lengkap
- [x] 2.3 Setelah WS reconnect dan `join_room` sukses, refresh room state dan navigasi ke room screen

---

## Bug 3: Loading screen tetap muncul terus di bawah

**Root Cause:** CSS `.loading` menggunakan `display: flex` tapi `.screen.active` menggunakan `display: block`. Saat `showScreen("loadingScreen")` dipanggil, class `active` ditambahkan tapi CSS `.screen.active { display: block }` menimpa `.loading { display: flex }`. Ketika screen lain di-show, loading screen kehilangan class `active` tapi mungkin masih visible karena CSS specificity issue.

**Fix:**

- [x] 3.1 Ubah `showScreen()` agar menggunakan `style.display` langsung bukan class toggle
- [x] 3.2 Handle loading screen secara khusus (flex vs block)

---

## Bug 4: Room master masuk sebagai peserta biasa

**Root Cause:** Di `renderPlayerList()`, tidak ada badge "Master" yang ditampilkan. Semua player terlihat sama. Juga, `isMaster` flag tidak di-set dengan benar saat pertama kali masuk room (race condition dengan `showRoomScreen`).

**Fix:**

- [x] 4.1 Tambah badge "👑 Master" untuk player yang `userId === room.masterId`
- [x] 4.2 Pastikan `isMaster` di-set SEBELUM render player list
- [x] 4.3 Tampilkan "(You)" dan badge master secara bersamaan
- [x] 4.4 Simpan `roomMasterId` di state untuk digunakan saat render dynamic

---

## Bug 5: Tombol Start Quiz tidak muncul

**Root Cause:** Start button visibility bergantung pada `isMaster`. Saat room master create room, `showRoomScreen()` dipanggil tapi `isMaster` di-set di dalam fungsi tersebut. Ada race condition: `renderPlayerList()` dipanggil sebelum `isMaster` di-set. Selain itu, master di-`is_ready = true` oleh server tapi frontend tidak meng-reflect ini, sehingga tombol ready menunjukkan state salah.

**Fix:**

- [x] 5.1 Pindah assignment `isMaster` ke sebelum `renderPlayerList()` dipanggil
- [x] 5.2 Set `isMaster` juga di `createRoom()` sebelum `showRoomScreen()`
- [x] 5.3 Reflect master's ready state (always true) di UI — auto-set tombol ready ke "Not Ready" state untuk master
- [x] 5.4 Add `masterId` dan `players` data ke room response saat create

---

## Verification

- [x] V1: Jalankan server, test WS auth flow (queue + flush)
- [x] V2: Refresh browser logic — fetch room state, show room screen
- [x] V3: Loading screen pakai flex, screen lain pakai block
- [x] V4: Badge "👑 Master" muncul di player list
- [x] V5: Tombol Start muncul untuk master
- [x] V6: `bun test` — 25 pass, 0 fail
