> **Note for English readers.** This is the internal product specification and
> it is written in Indonesian. It is kept as the record of what was decided and
> why, not as a submission document. For the English account of the project,
> read [`README.md`](../README.md); for the business and ecosystem case, read
> [`docs/ECOSYSTEM.md`](./ECOSYSTEM.md).

# Product Requirements Document (PRD)
# Forecast Arena

**Versi:** 1.0  
**Status:** Draft siap implementasi MVP  
**Tanggal:** 31 Agustus 2026  
**Pemilik Produk:** Forecast Arena Team  
**Target platform:** Web application, desktop-first dan responsive mobile  
**Blockchain:** Somnia testnet  
**Integrasi utama:** DreamDEX Event Contracts melalui `@somnia-chain/markets-sdk` versi 0.28.0 atau lebih baru  

> **Ringkasan produk:** Forecast Arena adalah platform kompetisi forecasting yang mengubah DreamDEX Event Contracts menjadi pengalaman berbasis skill, reputasi, dan kompetisi. Pengguna dapat memilih event market, menyampaikan keyakinan probabilistik, mengambil posisi Up atau Down di testnet, memantau hasil secara real-time, dan membangun rekam jejak prediksi yang terukur.

---

## 1. Executive Summary

Prediction market sering ditampilkan sebagai terminal trading yang sulit dipahami oleh pengguna baru. Pengguna dapat melihat harga probabilitas dan membeli kontrak, tetapi belum tentu memahami apakah performa mereka konsisten, apakah mereka terlalu percaya diri, atau apakah hasil positif hanya terjadi karena keberuntungan satu kali. Forecast Arena menyelesaikan masalah tersebut dengan menambahkan lapisan kompetisi, pembelajaran, dan reputasi di atas DreamDEX Event Contracts.

Produk ini memiliki dua mode. **Practice Arena** memungkinkan pengguna mengirimkan prediksi tanpa risiko modal untuk mempelajari probabilitas dan membangun calibration score. **Trade Arena** menghubungkan prediksi ke posisi Event Contract testnet, sehingga pengguna dapat membuktikan kemampuan mereka melalui keputusan trading yang dapat diverifikasi. Kedua mode menggunakan market dan settlement DreamDEX sebagai sumber kebenaran.

Forecast Arena tidak diposisikan sebagai penasihat investasi dan tidak menjanjikan keuntungan. Produk ini adalah aplikasi edukasi, kompetisi forecasting, dan antarmuka trading testnet. Seluruh nominal pada MVP harus dilabeli dengan jelas sebagai testnet atau simulasi.

### 1.1 Sasaran PRD

PRD ini mendefinisikan kebutuhan produk, user experience, arsitektur tingkat tinggi, integrasi DreamDEX, sistem scoring, ruang lingkup MVP, metrik keberhasilan, roadmap, dan acceptance criteria. Dokumen ini ditujukan untuk product manager, designer, frontend engineer, blockchain engineer, QA, dan anggota tim yang menyiapkan submission hackathon.

### 1.2 Sasaran hackathon

Forecast Arena harus memenuhi ekspektasi Event Contracts Hackathon: prototype testnet yang bekerja, integrasi bermakna dengan DreamDEX Event Contracts, repository publik, dan video demo 2–3 menit [1]. Event menilai inovasi dan orisinalitas 20%, implementasi teknis 25%, UX 20%, dampak bisnis dan ekosistem 20%, serta presentasi dan demo 15% [1].

---

## 2. Product Vision dan Positioning

### 2.1 Product vision

> **Membuat kemampuan memprediksi masa depan dapat dipelajari, dimainkan, dan dibuktikan secara transparan melalui Event Contracts.**

### 2.2 Positioning statement

> Forecast Arena adalah competitive forecasting platform yang memungkinkan pengguna berlatih, trading, dan membangun reputasi prediksi terverifikasi menggunakan DreamDEX Event Contracts—bukan sekadar menebak hasil satu kali.

### 2.3 Tagline

**From guessing to skill.**

### 2.4 Prinsip produk

| Prinsip | Implikasi produk |
|---|---|
| Skill over luck | Leaderboard tidak hanya memakai profit; akurasi, kalibrasi, konsistensi, dan risk-adjusted performance turut diperhitungkan. |
| Simple by default | Pengguna baru dapat memahami satu arena dan melakukan aksi utama tanpa membaca dokumentasi blockchain. |
| Verifiable by design | Entry price, timestamp, arah posisi, settlement, dan skor memiliki sumber data yang dapat diaudit. |
| Safe experimentation | Practice mode tersedia, seluruh fitur trading MVP berjalan di testnet, dan guardrail mencegah perilaku berisiko berlebihan. |
| Real integration | DreamDEX dipakai untuk market discovery, order book, order placement, live updates, settlement, dan redemption; bukan hanya ditempel sebagai logo. |
| Community as distribution | Pengguna dapat mengikuti arena dan leaderboard komunitas sehingga komunitas menjadi kanal akuisisi. |

---

## 3. Problem Statement

### 3.1 Masalah pengguna

Pengguna baru prediction market menghadapi tiga hambatan utama. Pertama, mereka tidak memahami arti probabilitas Up/Down, expiry, settlement, atau order book. Kedua, mereka tidak memiliki cara yang baik untuk mengukur kualitas prediksi selain melihat profit sesaat. Ketiga, aktivitas trading individual terasa tidak memiliki konteks sosial dan tidak memberi alasan kuat untuk kembali setiap hari.

Trader yang lebih berpengalaman menghadapi masalah yang berbeda. Mereka mungkin memiliki histori transaksi, tetapi histori tersebut tidak otomatis berubah menjadi profil kemampuan yang mudah dibandingkan. Profit absolut juga dapat menyesatkan karena tidak mempertimbangkan modal, tingkat keyakinan, jumlah prediksi, atau tingkat risiko.

### 3.2 Masalah ekosistem

DreamDEX membutuhkan pengalaman yang dapat menarik pengguna di luar kelompok trader DeFi yang sudah terbiasa dengan order book. Produk yang hanya menampilkan dashboard atau bot baru mungkin membantu trader yang ada, tetapi belum tentu menciptakan loop adopsi baru. Forecast Arena menggunakan kompetisi dan komunitas sebagai mekanisme onboarding serta repeat engagement.

### 3.3 Opportunity statement

Jika pengguna dapat memulai dari practice mode, memahami satu market melalui penjelasan sederhana, melihat hasil mereka dibandingkan pengguna lain, lalu mengonversi prediksi menjadi posisi testnet yang dapat diverifikasi, maka Event Contracts dapat menjadi pengalaman yang lebih mudah diakses dan lebih sering digunakan.

---

## 4. Goals dan Non-Goals

### 4.1 Product goals

| ID | Goal | Target MVP |
|---|---|---|
| G1 | Menyediakan pengalaman onboarding forecasting yang dapat dipahami pengguna baru. | Pengguna baru dapat menyelesaikan prediksi pertama dalam kurang dari 3 menit. |
| G2 | Mendemonstrasikan integrasi end-to-end dengan DreamDEX Event Contracts. | Market discovery, order book, order, live position, settlement, dan redemption dapat ditunjukkan di testnet. |
| G3 | Mengukur skill forecasting dengan lebih baik daripada profit satu kali. | Tersedia accuracy score, calibration score, consistency score, dan risk-adjusted score. |
| G4 | Menciptakan repeat engagement. | Pengguna dapat mengikuti arena harian dan melihat perubahan ranking setelah settlement. |
| G5 | Menyediakan demo hackathon yang kuat. | Satu alur demo lengkap dapat selesai dalam 2–3 menit tanpa langkah manual yang membingungkan. |
| G6 | Membuka fondasi fitur komunitas. | Leaderboard publik dan arena dengan ID yang dapat dibagikan tersedia pada MVP. |

### 4.2 Non-goals MVP

Forecast Arena MVP tidak akan menjadi platform taruhan dengan uang nyata, exchange baru, market creator, oracle provider, atau layanan penasihat investasi. MVP juga tidak akan mengizinkan AI menempatkan order secara otonom, tidak akan mendukung strategi multi-leg yang kompleks, dan tidak akan mencoba membangun native mobile application sebelum alur web tervalidasi.

MVP tidak menjamin ketersediaan market untuk semua topik. Produk hanya menampilkan market DreamDEX yang live dan sesuai dengan filter yang didukung SDK. Jika pembuatan event contract baru belum tersedia melalui API/SDK, Forecast Arena tidak boleh mengklaim dapat membuat market baru.

---

## 5. Target Users dan Personas

### Persona A — Curious Newcomer

**Profil:** Pengguna Web3 yang memahami wallet dasar tetapi belum pernah trading prediction market.  
**Kebutuhan:** Penjelasan singkat, practice mode, nominal testnet, dan feedback yang tidak menghakimi.  
**Hambatan:** Takut salah memilih kontrak atau salah memahami probabilitas.  
**Success signal:** Berhasil menyelesaikan satu practice prediction dan memahami mengapa hasilnya menang atau kalah.

### Persona B — Competitive Forecaster

**Profil:** Pengguna yang senang leaderboard, kompetisi, dan membangun reputasi.  
**Kebutuhan:** Ranking yang adil, metrik skill, streak, arena tematik, dan profil yang dapat dibagikan.  
**Hambatan:** Leaderboard berbasis profit dapat didominasi pengguna dengan modal besar.  
**Success signal:** Mengikuti beberapa arena dan kembali untuk memperbaiki calibration score.

### Persona C — Testnet Trader

**Profil:** Trader DeFi yang ingin mencoba DreamDEX dan menguji strategi.  
**Kebutuhan:** Order book real-time, kontrol stake, entry price, posisi aktif, expiry, dan redemption.  
**Hambatan:** Tidak ingin melewati UX yang terlalu gamified atau kehilangan detail trading.  
**Success signal:** Menempatkan order, memantau fill, dan menyelesaikan settlement tanpa meninggalkan aplikasi.

### Persona D — Community Host

**Profil:** Admin komunitas trading, kampus, atau DAO.  
**Kebutuhan:** Arena yang dapat dibagikan, leaderboard komunitas, serta cara mengundang peserta.  
**Hambatan:** Belum ada alat sederhana untuk membuat kompetisi forecasting berbasis Event Contracts.  
**Success signal:** Membuat atau membagikan arena dan mendapatkan peserta aktif.

---

## 6. User Journeys

### 6.1 Journey pengguna baru

1. Pengguna membuka landing page dan memilih **Try Practice Arena**.
2. Aplikasi menjelaskan bahwa Up adalah probabilitas bahwa kondisi kontrak terpenuhi, sedangkan Down adalah sisi berlawanan.
3. Pengguna memilih satu market live dan membaca expiry serta ringkasan kondisi kontrak.
4. Pengguna memasukkan confidence, misalnya 65%, tanpa modal.
5. Aplikasi mencatat prediksi, menampilkan reasoning opsional, dan menjelaskan bahwa hasil akan dinilai setelah settlement.
6. Setelah market selesai, pengguna melihat outcome, calibration score, dan rekomendasi pembelajaran.
7. Pengguna diarahkan untuk mengikuti Trade Arena menggunakan testnet.

### 6.2 Journey trader testnet

1. Pengguna menghubungkan wallet.
2. Aplikasi memeriksa jaringan dan saldo token testnet.
3. Pengguna memilih Trade Arena.
4. Aplikasi menampilkan market, expiry, probability Up, best bid/ask, spread, dan depth ringkas.
5. Pengguna memilih Up atau Down, memasukkan stake, dan melihat estimasi risiko maksimum.
6. Pengguna meninjau ringkasan order lalu menandatangani transaksi.
7. Aplikasi menampilkan status submitted, partially filled, filled, atau rejected.
8. Posisi ditampilkan pada portfolio dengan entry price, current implied value, time-to-expiry, dan status settlement.
9. Setelah settlement, pengguna dapat redeem winning position jika tersedia.
10. Hasil transaksi masuk ke profil dan leaderboard.

### 6.3 Journey community host

1. Host memilih **Create Arena**.
2. Host memasukkan nama, deskripsi, aturan scoring, durasi, dan market yang diperbolehkan dari daftar live.
3. Sistem menghasilkan URL arena yang dapat dibagikan.
4. Peserta masuk melalui URL, menghubungkan wallet atau memakai practice mode, lalu mengikuti kompetisi.
5. Leaderboard menampilkan skor dengan identitas wallet yang dipendekkan.
6. Setelah event selesai, arena menampilkan pemenang, replay prediksi, dan ringkasan statistik.

---

## 7. Scope MVP

### 7.1 In-scope features

| Modul | Fitur MVP | Prioritas |
|---|---|---:|
| Landing dan onboarding | Penjelasan produk, practice vs trade, network status, dan wallet connect | P0 |
| Market discovery | Daftar market live, filter expiry/asset, probability Up, liquidity indicator | P0 |
| Market detail | Kontrak, expiry, Up/Down, order book ringkas, candles atau last fills jika tersedia | P0 |
| Practice Arena | Kirim confidence, simpan prediksi, lihat histori dan hasil | P0 |
| Trade Arena | Pilih sisi, stake, price limit, preview risiko, sign order | P0 |
| Portfolio | Posisi aktif, order status, expiry countdown, settlement state | P0 |
| Settlement | Deteksi settled market, hitung hasil, dan tombol redeem jika eligible | P0 |
| Scoring | Accuracy, calibration, consistency, risk-adjusted score | P0 |
| Leaderboard | Ranking global dan per arena, filter practice/trade | P0 |
| Arena sharing | Arena ID, URL sharing, aturan dan daftar market | P1 |
| Post-trade review | Ringkasan keputusan dan feedback dasar | P1 |
| AI coach | Penjelasan sederhana terhadap calibration error tanpa rekomendasi trading | P2 |

### 7.2 P0 definition

P0 adalah fitur yang harus ada agar prototype memenuhi alur utama. Prototype tidak dianggap siap jika pengguna hanya dapat melihat market tanpa menempatkan order, atau jika posisi tidak dapat dilacak hingga settlement. P0 juga mencakup error state untuk wallet salah jaringan, saldo tidak cukup, market sudah tidak aktif, order gagal, dan indexer belum sinkron.

### 7.3 P1 definition

P1 meningkatkan daya tarik demo dan repeat engagement, tetapi dapat dipangkas bila integrasi core memerlukan waktu lebih lama. Arena sharing dan post-trade review sebaiknya tetap dimasukkan jika tidak mengganggu reliabilitas trading flow.

### 7.4 P2 definition

P2 adalah diferensiasi lanjutan setelah core stabil. AI coach tidak boleh menggeser prioritas dari integrasi Event Contracts. Bila dimasukkan ke demo, AI hanya memberi edukasi berbasis histori pengguna dan tidak mengeksekusi order.

---

## 8. Detailed Functional Requirements

### 8.1 Wallet dan network

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-001 | Pengguna dapat menghubungkan wallet EVM. | Address terdeteksi dan ditampilkan dalam format pendek. |
| FR-002 | Aplikasi mendeteksi chain yang salah. | Pengguna melihat pesan jaringan yang jelas dan instruksi perpindahan jaringan. |
| FR-003 | Aplikasi menampilkan saldo token testnet yang diperlukan. | Saldo ditampilkan sebelum pengguna membuka order ticket. |
| FR-004 | Practice mode dapat digunakan tanpa wallet. | Pengguna dapat mengirim practice prediction dengan session identifier. |
| FR-005 | Wallet signature tidak boleh terjadi tanpa review. | Order preview tampil sebelum wallet request dipanggil. |

### 8.2 Market discovery

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-010 | Aplikasi mengambil daftar market live dari SDK. | Market aktif tampil dengan symbol, asset, expiry, dan status. |
| FR-011 | Aplikasi mengabaikan market yang tidak live atau on-chain status-nya bukan trading. | Market invalid tidak memiliki tombol order aktif. |
| FR-012 | Pengguna dapat memfilter market berdasarkan asset dan waktu expiry. | Hasil filter diperbarui tanpa reload penuh. |
| FR-013 | Market card menampilkan probability Up dan estimasi Down. | Down ditampilkan sebagai `1 - Up` jika sesuai mekanisme DreamDEX. |
| FR-014 | Aplikasi menangani market tanpa liquidity. | Tombol trade dinonaktifkan atau menampilkan pesan tidak ada quote. |
| FR-015 | Daftar market diperbarui melalui refresh atau live watch. | Perubahan status tidak mengharuskan pengguna memulai ulang sesi. |

### 8.3 Market detail dan order book

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-020 | Pengguna dapat membuka detail market. | Detail kontrak, expiry, status, dan outcome ditampilkan. |
| FR-021 | Aplikasi menampilkan bid/ask dan depth ringkas. | Harga dan ukuran quote memiliki timestamp atau indikator live. |
| FR-022 | Aplikasi menampilkan spread. | Spread dihitung dari best ask dan best bid bila keduanya tersedia. |
| FR-023 | Aplikasi menampilkan expiry countdown. | Countdown berhenti atau berubah menjadi settled/expired sesuai status. |
| FR-024 | Aplikasi memperbarui order book. | Update tidak menggandakan baris atau menampilkan data stale tanpa indikator. |

### 8.4 Practice prediction

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-030 | Pengguna dapat memilih confidence antara 1% dan 99%. | Input menolak nilai di luar rentang dan menampilkan validasi. |
| FR-031 | Pengguna dapat memilih outcome Up atau Down. | Hanya satu sisi yang dapat dipilih pada satu prediksi. |
| FR-032 | Sistem menyimpan market snapshot saat prediksi dibuat. | Snapshot minimal mencakup market ID, timestamp, probability, outcome, dan confidence. |
| FR-033 | Pengguna dapat menambahkan reasoning opsional. | Reasoning tampil di histori pribadi dan dapat disembunyikan dari publik. |
| FR-034 | Practice prediction tidak mengirim transaksi on-chain. | Tidak ada wallet signature dan tidak ada token yang dipindahkan. |
| FR-035 | Prediksi terkunci setelah cutoff yang ditetapkan. | Pengguna tidak dapat mengubah prediksi setelah market settled atau cutoff tercapai. |

### 8.5 Trade order

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-040 | Pengguna dapat memilih Up atau Down. | Sisi yang dipilih konsisten pada ticket dan preview transaksi. |
| FR-041 | Pengguna dapat memasukkan stake dan limit price. | Nilai dinormalisasi ke unit manusia dan divalidasi terhadap tick grid. |
| FR-042 | Aplikasi menampilkan max loss sebelum sign. | Max loss ditampilkan dalam token testnet dan persentase stake. |
| FR-043 | Pengguna dapat memilih IOC untuk demo cepat. | Unfilled remainder tidak diam-diam menjadi resting order jika IOC dipilih. |
| FR-044 | Sistem membaca hasil transaksi dari receipt. | Status order diperbarui menjadi submitted, filled, partially filled, cancelled, atau failed. |
| FR-045 | Error revert ditampilkan dalam bahasa yang dapat dipahami. | Pengguna mendapatkan next step tanpa melihat stack trace mentah. |
| FR-046 | Sistem mencegah order pada market yang sudah tidak trading. | Validasi live on-chain dilakukan sebelum write. |

### 8.6 Portfolio dan settlement

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-050 | Pengguna dapat melihat semua posisi dari wallet yang terhubung. | Posisi dikelompokkan active, settled, dan redeemable. |
| FR-051 | Posisi menampilkan market ID, side, quantity, average price, dan timestamp. | Data cocok dengan transaksi atau event yang terdeteksi. |
| FR-052 | Sistem memantau successor market jika market window berakhir. | UI memberi tahu bahwa market lama selesai dan successor tersedia jika ditemukan. |
| FR-053 | Sistem mendeteksi posisi yang menang. | Status berubah menjadi redeemable setelah settlement terverifikasi. |
| FR-054 | Pengguna dapat memulai redemption. | Tombol redeem memanggil fungsi yang sesuai dan menampilkan receipt. |
| FR-055 | Sistem tidak menganggap indexer sebagai satu-satunya sumber status write. | Status on-chain diverifikasi sebelum order atau redeem. |

### 8.7 Scoring dan leaderboard

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-060 | Sistem menghitung outcome correctness. | Setiap prediksi memiliki outcome benar/salah atau void. |
| FR-061 | Sistem menghitung calibration score. | Prediksi confidence 70% diberi penalti bila outcome berulang kali tidak sesuai distribusi ekspektasi. |
| FR-062 | Sistem menghitung consistency score. | Skor tidak hanya ditentukan oleh satu prediksi atau satu trade berukuran besar. |
| FR-063 | Sistem menampilkan sample size. | Profil menunjukkan jumlah prediksi settled agar skor tidak menyesatkan. |
| FR-064 | Leaderboard memiliki mode skill dan mode PnL. | Pengguna dapat memahami perbedaan ranking skill dengan ranking hasil trading. |
| FR-065 | Wallet dapat menggunakan pseudonym. | Address tetap dapat diverifikasi, tetapi nama publik tidak harus berupa address penuh. |
| FR-066 | Prediksi void tidak dihitung sebagai loss. | Market void atau data tidak valid dikeluarkan dari scoring. |

### 8.8 Arena

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-070 | Pengguna dapat membuat arena dari market yang tersedia. | Arena hanya dapat memilih market yang live dan didukung. |
| FR-071 | Host dapat menentukan nama, deskripsi, durasi, dan scoring mode. | Konfigurasi tersimpan dan dapat dibuka melalui URL unik. |
| FR-072 | Peserta dapat bergabung melalui arena URL. | Peserta melihat aturan sebelum mengirim prediksi atau trade. |
| FR-073 | Leaderboard terisolasi per arena. | Peserta di satu arena tidak tercampur dengan arena lain. |
| FR-074 | Arena memiliki lifecycle. | Status draft, open, locked, settling, dan completed ditampilkan. |

---

## 9. Scoring Model

Scoring harus cukup sederhana untuk dijelaskan di UI, namun lebih bermakna daripada menang/kalah absolut. Model berikut adalah rancangan MVP dan dapat disesuaikan setelah pengujian.

### 9.1 Practice score

Untuk setiap prediksi biner, gunakan Brier score sebagai ukuran error probabilitas:

```text
Brier error = (p - o)^2
Calibration points = 100 × (1 - Brier error)
```

`p` adalah probabilitas yang dinyatakan pengguna untuk outcome yang dipilih, sedangkan `o` bernilai 1 jika outcome benar dan 0 jika salah. Untuk memudahkan pemahaman pengguna, produk dapat menampilkan “calibration points” sebagai nilai 0–100, sementara detail formula tersedia pada tooltip.

Contoh: pengguna menyatakan confidence 70% bahwa Up akan terjadi dan Up benar-benar terjadi. Brier error adalah `(0,70 - 1)^2 = 0,09`, sehingga calibration points adalah 91. Jika pengguna menyatakan 99% tetapi salah, penalty sangat besar. Ini mendorong keyakinan yang proporsional, bukan sekadar prediksi agresif.

### 9.2 Trade score

Trade score terdiri dari beberapa komponen:

| Komponen | Bobot | Penjelasan |
|---|---:|---|
| Calibration | 35% | Seberapa baik confidence sejalan dengan outcome. |
| Correctness | 25% | Proporsi prediksi atau posisi yang berakhir benar. |
| Risk-adjusted result | 25% | Hasil yang dinormalisasi terhadap stake dan risiko maksimum. |
| Consistency | 15% | Stabilitas performa dan kontribusi sample size. |

Formula konseptual:

```text
Trade score = 0,35 × Calibration
            + 0,25 × Correctness
            + 0,25 × Risk-adjusted result
            + 0,15 × Consistency
```

Seluruh subscore dinormalisasi ke rentang 0–100. Skor yang belum memiliki minimum lima prediksi settled harus diberi label **provisional** dan tidak boleh dibandingkan secara setara dengan profil yang memiliki sample lebih besar.

### 9.3 Anti-gaming rules

Sistem harus menerapkan batas kontribusi maksimum dari satu market terhadap leaderboard. Pengguna tidak boleh menaikkan ranking hanya dengan mempertaruhkan stake ekstrem pada satu prediksi. Practice leaderboard juga harus memakai minimum sample size atau confidence interval sederhana.

Prediksi yang dikirim setelah market tidak lagi valid, transaksi yang gagal, dan market yang void tidak boleh memengaruhi loss. Duplicate event dari websocket atau indexer harus dideduplikasi dengan kombinasi wallet address, market ID, order ID, dan transaction hash.

### 9.4 Penjelasan score di UI

Jangan menampilkan formula sebagai angka yang tidak bermakna. UI harus menerjemahkan hasil menjadi insight seperti “Anda cukup akurat, tetapi terlalu sering memberi confidence 90%+” atau “Performa Anda stabil di 60–70% confidence.” Insight tersebut bersifat edukatif dan tidak boleh menjadi rekomendasi membeli atau menjual.

---

## 10. UX dan Information Architecture

### 10.1 Navigasi utama

| Menu | Tujuan |
|---|---|
| Explore | Menemukan market dan arena aktif. |
| Practice | Mengirim prediksi tanpa modal. |
| Trade | Menempatkan posisi testnet pada DreamDEX. |
| Portfolio | Melacak order, posisi, expiry, settlement, dan redemption. |
| Leaderboard | Membandingkan skill dan hasil. |
| Profile | Melihat histori, calibration, badge, dan wallet verification. |

### 10.2 Halaman utama

**Landing page** harus menjawab tiga pertanyaan: apa yang diprediksi, bagaimana cara bermain, dan mengapa skill pengguna dapat dibuktikan. Call-to-action utama adalah “Try Practice Arena”, sedangkan “Trade on Testnet” menjadi CTA sekunder.

**Explore page** menampilkan kartu market dengan asset, expiry, probability Up, spread, liquidity indicator, dan tombol “Practice” atau “Trade”. Jangan memenuhi kartu dengan istilah teknis yang tidak dijelaskan.

**Arena page** menjadi layar paling penting untuk demo. Bagian atas menampilkan nama arena dan countdown. Bagian tengah menampilkan market card, probabilitas Up/Down, order book ringkas, dan action panel. Bagian bawah menampilkan leaderboard serta aktivitas terbaru.

**Portfolio page** menampilkan lifecycle posisi secara horizontal: Order submitted → Filled → Active → Settled → Redeemable/Redeemed. Status ini harus tetap mudah dipahami meskipun data indexer terlambat.

### 10.3 Accessibility dan usability

Warna Up dan Down tidak boleh menjadi satu-satunya pembeda; gunakan label dan ikon teks. Semua tombol harus memiliki state loading, success, disabled, dan error. Countdown harus memiliki fallback teks untuk pengguna yang mematikan animasi. Kontras warna, fokus keyboard, dan ukuran target sentuh harus memenuhi praktik aksesibilitas web umum.

---

## 11. Technical Architecture

### 11.1 Komponen utama

```text
┌─────────────────────────────────────────────┐
│ Forecast Arena Web Client                   │
│ React/TypeScript                             │
│ Explore · Arena · Trade Ticket · Portfolio   │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Application Service Layer                   │
│ Market adapter · Scoring · Arena service    │
│ Position normalizer · Error translation     │
└───────────────┬─────────────────┬───────────┘
                │                 │
                ▼                 ▼
┌──────────────────────┐  ┌──────────────────┐
│ DreamDEX SDK         │  │ App database      │
│ Markets/order book   │  │ Arena, users,     │
│ Orders/settlement    │  │ predictions,      │
│ Live watches         │  │ score snapshots   │
└──────────────┬───────┘  └──────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Somnia Testnet                              │
│ Event Contracts · Order book · Settlement  │
└─────────────────────────────────────────────┘
```

### 11.2 DreamDEX integration requirements

Dokumentasi resmi menyebut bahwa Event Contracts diperdagangkan pada on-chain order book Somnia Markets dan developer surface utamanya adalah `@somnia-chain/markets-sdk`; HTTP API hanya mencakup spot dan tidak menyediakan endpoint event-contract [2]. SDK menyediakan discovery market, streaming order book/fills/candles, place/cancel order, mint/merge complete sets, serta redemption setelah settlement [2].

Engineering harus menggunakan versi SDK yang sesuai, memvalidasi status market secara on-chain sebelum write, dan tidak menganggap row indexer sebagai status final. Dokumentasi juga menjelaskan bahwa satu book mencakup dua sisi serta Down memiliki hubungan harga dengan Up; desain UI dan adapter internal harus mengikuti mekanisme tersebut [2].

### 11.3 Service modules

| Module | Responsibility |
|---|---|
| `marketAdapter` | Memanggil `loadMarkets`, menyaring market aktif, menormalisasi symbol, expiry, outcome, dan metadata. |
| `orderBookService` | Mengambil snapshot dan mengelola live watch untuk order book, fills, serta candles. |
| `orderService` | Membuat preview, validasi live status, mengirim order, membaca receipt, dan memetakan error. |
| `positionService` | Menggabungkan event order, fill, token position, dan wallet state menjadi portfolio view. |
| `settlementService` | Memantau market settled, menentukan status redeemable, dan menjalankan redemption. |
| `predictionService` | Menyimpan practice prediction serta immutable snapshot untuk scoring. |
| `scoringService` | Menghitung subscore, confidence, sample size, leaderboard, dan provisional flag. |
| `arenaService` | Mengelola konfigurasi arena, lifecycle, peserta, dan leaderboard terisolasi. |
| `telemetryService` | Mengukur funnel, error, latency, order success, dan retention event. |

### 11.4 Data model konseptual

```text
User
- id
- walletAddress
- pseudonym
- createdAt

MarketSnapshot
- id
- marketId
- symbol
- upProbability
- bestBid
- bestAsk
- expiry
- capturedAt
- onchainStatus

Prediction
- id
- userId
- arenaId
- marketId
- mode: practice | trade
- selectedOutcome: up | down
- confidence
- stake
- entryPrice
- snapshotId
- reasoning
- submittedAt
- cutoffAt
- status: open | correct | incorrect | void

Order
- id
- userId
- marketId
- symbol
- side
- direction
- quantity
- limitPrice
- timeInForce
- transactionHash
- status
- createdAt

Position
- id
- userId
- marketId
- tokenSymbol
- outcome
- quantity
- averagePrice
- settlementStatus
- redeemTransactionHash

Arena
- id
- slug
- hostUserId
- name
- description
- scoringMode
- status
- startsAt
- locksAt
- endsAt

ScoreSnapshot
- id
- userId
- arenaId
- calibrationScore
- correctnessScore
- riskAdjustedScore
- consistencyScore
- compositeScore
- sampleSize
- isProvisional
- calculatedAt
```

### 11.5 Source of truth

On-chain transaction receipt dan market state menjadi sumber kebenaran untuk order, fill, settlement, dan redemption. Database aplikasi digunakan untuk cache, indexing internal, practice predictions, arena configuration, scoring snapshot, dan UX. Jika ada perbedaan antara database dan chain, aplikasi harus menandai status sebagai “syncing” lalu melakukan reconciliation.

### 11.6 Security requirements

Private key tidak boleh disimpan oleh aplikasi pada MVP. Semua order dan redemption harus ditandatangani melalui wallet pengguna. RPC endpoint, indexer URL, dan contract addresses harus dikonfigurasi melalui environment variable. Server tidak boleh mempercayai nilai stake atau price dari client tanpa validasi ulang.

Aplikasi harus memvalidasi chain ID, market ID, status market, price tick, quantity, dan batas stake sebelum transaksi. Semua endpoint arena harus memiliki rate limiting dasar, validasi input, dan perlindungan terhadap duplicate submission. Data reasoning publik harus memiliki pilihan opt-out atau private-by-default.

---

## 12. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Performance | First meaningful market list tampil dalam 3 detik pada koneksi broadband biasa setelah cache tersedia. |
| Realtime | Perubahan order book dan status order tercermin dalam 5 detik pada kondisi normal. |
| Reliability | Demo core flow memiliki target success rate minimal 95% pada testnet selama rehearsal. |
| Observability | Semua order attempt, error category, transaction hash, dan latency dicatat tanpa menyimpan secret. |
| Scalability | Scoring dan leaderboard dapat menangani minimal 1.000 peserta dan 10.000 prediction records untuk MVP. |
| Accessibility | Navigasi keyboard, label form, fokus terlihat, kontras memadai, dan tidak bergantung pada warna saja. |
| Privacy | Wallet dapat disamarkan dengan pseudonym; reasoning tidak dipublikasikan tanpa pilihan pengguna. |
| Compatibility | Versi terbaru Chrome, Edge, Firefox, dan Safari desktop; mobile browser dengan layout responsive. |
| Maintainability | Adapter DreamDEX dipisahkan dari UI agar perubahan SDK tidak menyebar ke seluruh aplikasi. |
| Auditability | Semua score calculation menyimpan versi formula dan timestamp perhitungan. |

---

## 13. Metrics dan Analytics

### 13.1 North Star Metric

**Settled meaningful predictions per weekly active user (SMP/WAU).** Metrik ini menggabungkan aktivitas forecasting dengan penyelesaian event, bukan sekadar page view atau wallet connect.

### 13.2 Funnel metrics

| Funnel | Metric | Target awal MVP |
|---|---|---:|
| Acquisition | Landing page → Explore | ≥ 60% pada traffic demo |
| Activation | Explore → First practice prediction | ≥ 45% |
| Trading activation | Wallet connect → First testnet order | ≥ 30% |
| Technical success | Order attempt → Successful submission | ≥ 90% pada rehearsal |
| Completion | Prediction → Settled result viewed | ≥ 70% |
| Retention | User kembali dan membuat prediksi kedua | ≥ 35% dalam satu sesi berikutnya |
| Community | Arena created → arena with at least 3 participants | ≥ 25% pada pilot |

Target di atas adalah target operasional awal, bukan klaim performa yang sudah tercapai. Setelah pilot, target harus disesuaikan berdasarkan data aktual.

### 13.3 Event taxonomy

Gunakan event analytics berikut:

```text
landing_viewed
practice_started
market_viewed
prediction_submitted
wallet_connected
network_switch_requested
order_previewed
order_signed
order_filled
order_failed
portfolio_viewed
settlement_detected
redeem_started
redeem_completed
arena_created
arena_joined
leaderboard_viewed
score_explanation_opened
```

Jangan menyimpan private key, seed phrase, signature payload yang sensitif, atau data reasoning tanpa consent. Transaction hash dan wallet address boleh disimpan jika dibutuhkan untuk audit UX, dengan kebijakan privasi yang jelas.

---

## 14. Roadmap Implementasi

### Sprint 0 — Technical spike

**Tujuan:** Membuktikan koneksi SDK dan lifecycle dasar.  
**Output:** Market list testnet, order book snapshot, satu order berhasil, transaction receipt tersimpan, dan status market dapat diverifikasi on-chain.

### Sprint 1 — Core trading flow

**Tujuan:** Membuat experience dari market discovery sampai portfolio.  
**Output:** Wallet connect, network guard, market cards, market detail, order ticket, validation, order status, dan error states.

### Sprint 2 — Practice dan scoring

**Tujuan:** Membangun diferensiasi utama Forecast Arena.  
**Output:** Practice prediction, market snapshot, settled result, Brier/calibration calculation, profile, dan leaderboard dasar.

### Sprint 3 — Arena dan settlement

**Tujuan:** Mengubah prototype menjadi produk kompetisi.  
**Output:** Create/join arena, arena URL, lifecycle, settlement tracker, redeem flow, dan per-arena leaderboard.

### Sprint 4 — Polish dan submission

**Tujuan:** Memastikan demo stabil dan mudah dinilai.  
**Output:** Responsive polish, empty/error/loading states, README, test scripts, demo wallet, video 2–3 menit, dan submission narrative.

### Prioritas jika waktu terbatas

Urutan yang tidak boleh dibalik adalah: **order flow yang benar**, **portfolio dan settlement**, **practice scoring**, **leaderboard**, lalu **arena sharing dan AI coach**. Fitur visual tambahan tidak boleh mengorbankan bukti bahwa DreamDEX benar-benar digunakan.

---

## 15. Testing Strategy

### 15.1 Unit tests

Unit tests harus mencakup normalisasi probability Up/Down, validasi price tick, konversi quantity, Brier score, composite score, minimum sample size, status lifecycle, dan deduplikasi event.

### 15.2 Integration tests

Integration test harus memverifikasi load market, fetch order book, order preview, order submission testnet, receipt parsing, portfolio reconciliation, market settlement detection, dan redemption. Setiap test perlu menyimpan transaction hash atau fixture yang dapat ditelusuri.

### 15.3 End-to-end tests

Skenario minimum adalah: pengguna baru practice prediction; pengguna menghubungkan wallet pada network benar; pengguna menolak signature; order gagal karena market tidak live; order berhasil filled; posisi masuk portfolio; market settled; redemption berhasil; dan leaderboard diperbarui.

### 15.4 Demo rehearsal

Sebelum merekam video, siapkan wallet testnet dengan saldo yang cukup, market yang diketahui masih live, fallback market, dan screenshot atau recorded fallback untuk bagian settlement bila settlement testnet tidak terjadi tepat selama perekaman. Fallback tidak boleh memalsukan transaksi; transaction hash asli harus tersedia bila ditampilkan.

---

## 16. Acceptance Criteria MVP

MVP dinyatakan siap apabila seluruh kriteria berikut terpenuhi:

| ID | Acceptance criterion |
|---|---|
| AC-001 | Pengguna dapat membuka aplikasi dan memahami perbedaan Practice Arena dan Trade Arena tanpa membaca dokumentasi eksternal. |
| AC-002 | Market live DreamDEX dapat ditemukan dan menampilkan symbol, expiry, probability, serta status. |
| AC-003 | Pengguna dapat mengirim practice prediction dengan confidence dan outcome yang valid. |
| AC-004 | Practice prediction menyimpan market snapshot dan tidak memerlukan transaksi wallet. |
| AC-005 | Pengguna dapat menghubungkan wallet pada Somnia testnet dan melihat saldo testnet. |
| AC-006 | Pengguna dapat membuka order ticket, melihat max loss, dan meninjau price/quantity sebelum sign. |
| AC-007 | Minimal satu order Event Contract berhasil ditempatkan di testnet menggunakan SDK DreamDEX. |
| AC-008 | Aplikasi menampilkan transaction hash dan status order yang dapat diverifikasi. |
| AC-009 | Posisi filled tampil di portfolio dengan side, quantity, average price, dan expiry. |
| AC-010 | Aplikasi menangani status market expired/settled dan tidak mengizinkan order invalid. |
| AC-011 | Pengguna dapat melihat posisi yang redeemable dan memulai redemption jika eligible. |
| AC-012 | Settled practice/trade prediction memiliki outcome dan score. |
| AC-013 | Leaderboard menampilkan composite score, sample size, dan provisional label. |
| AC-014 | Skor satu pengguna tidak dapat berubah hanya karena refresh halaman atau duplicate event. |
| AC-015 | Minimal satu arena dapat dibuat, dibagikan, diikuti, dan menampilkan leaderboard terisolasi. |
| AC-016 | UI memiliki loading, empty, error, success, wrong-network, dan syncing states. |
| AC-017 | Repository berisi README setup, environment variables yang diperlukan, cara menjalankan test, dan penjelasan arsitektur. |
| AC-018 | Video demo 2–3 menit menunjukkan problem, practice flow, live DreamDEX integration, leaderboard, dan future vision. |

---

## 17. Risks dan Mitigations

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Market testnet tidak memiliki liquidity | Order tidak dapat diisi sehingga demo gagal. | Gunakan IOC, pilih market dengan quote tersedia, siapkan dua market fallback, dan tampilkan order-book state dengan jelas. |
| Indexer tertinggal dari chain | UI menunjukkan status lama atau salah. | Verifikasi status on-chain sebelum write dan tampilkan syncing state saat reconciliation. |
| Settlement belum terjadi saat demo | Fitur redemption sulit ditampilkan live. | Rekam settlement terpisah dengan transaction hash nyata atau gunakan market yang sudah settled untuk rehearsal. |
| SDK berubah atau dokumentasi tidak lengkap | Engineering terlambat. | Isolasi adapter, pin versi SDK, buat technical spike lebih awal, dan dokumentasikan feedback. |
| Skor disalahpahami sebagai return finansial | Risiko reputasi dan misleading UX. | Gunakan istilah skill score, tampilkan sample size, label testnet, dan hindari klaim profit. |
| Leaderboard digame oleh stake besar | Kompetisi tidak adil. | Gunakan risk-adjusted score, cap kontribusi market, minimum sample, dan pisahkan skill leaderboard dari PnL. |
| UX terlalu ramai | Juri tidak memahami value proposition. | Prioritaskan satu primary action per layar dan demo flow yang linear. |
| AI menghasilkan saran trading | Risiko misleading dan scope melebar. | AI hanya memberi post-trade education; tidak mengeksekusi order dan tidak memberi instruksi investasi. |
| Wallet/security error | Pengguna kehilangan kepercayaan. | Never custody private key, validasi chain dan input, gunakan testnet, dan tampilkan transaksi sebelum sign. |

---

## 18. Demo Script 2–3 Menit

### 0:00–0:20 — Problem

“Prediction markets memiliki data probabilitas dan order book, tetapi pengguna baru sulit memahami apakah mereka benar-benar memiliki skill. Forecast Arena mengubah setiap Event Contract menjadi arena forecasting yang dapat dimainkan, diukur, dan diverifikasi.”

### 0:20–0:50 — Practice

Buka Practice Arena, pilih market live, jelaskan probability Up dan Down, pilih confidence, dan kirim prediksi. Tunjukkan bahwa practice prediction tidak memerlukan modal dan akan masuk ke histori pengguna.

### 0:50–1:35 — DreamDEX trade

Hubungkan wallet testnet, buka market yang sama pada Trade Arena, tampilkan order book dan expiry, masukkan stake kecil, lihat max loss, lalu sign order. Tunjukkan transaction hash dan perubahan status menjadi filled atau active.

### 1:35–2:05 — Portfolio dan score

Buka portfolio, tampilkan entry price, side, quantity, expiry, dan status. Buka profil atau leaderboard, tampilkan calibration score, sample size, composite score, dan penjelasan bahwa ranking tidak hanya berdasarkan profit.

### 2:05–2:30 — Vision

“Tahap berikutnya adalah community leagues, arena yang dapat di-embed ke komunitas, dan AI coach yang membantu pengguna memahami calibration error tanpa mengeksekusi trade. Forecast Arena membuat DreamDEX lebih mudah diakses sekaligus menciptakan alasan bagi pengguna untuk kembali.”

---

## 19. Submission Checklist

| Item | Wajib | Keterangan |
|---|---:|---|
| Prototype testnet | Ya | Pastikan URL dapat dibuka dan alur utama dapat diuji. |
| Repository | Ya | Sertakan setup, environment variables, architecture notes, dan known limitations. |
| Demo video 2–3 menit | Ya | Tampilkan satu alur utuh dengan transaction evidence. |
| Presentation deck | Opsional | Gunakan maksimal beberapa slide yang fokus pada problem, solution, demo, dan impact. |
| SDK feedback report | Opsional | Catat friction, missing types, docs gap, atau improvement request secara konstruktif. |
| Test wallet instructions | Disarankan | Jangan bagikan private key wallet pribadi; gunakan demo wallet dan instruksi testnet yang aman. |
| Risk disclaimer | Disarankan | Tegaskan bahwa MVP adalah testnet/edukasi dan bukan nasihat finansial. |

---

## 20. Future Vision

Setelah MVP tervalidasi, Forecast Arena dapat berkembang menjadi lapisan reputasi forecasting untuk ekosistem Somnia. Community leagues dapat dibuat oleh DAO, komunitas trader, universitas, atau event organizer. Profil pengguna dapat menampilkan calibration history yang dapat diverifikasi dan dibawa ke aplikasi lain melalui widget atau API.

Arena dapat memperkenalkan format yang lebih kaya tanpa mengubah core Event Contracts: head-to-head forecasting, team leagues, seasonal ranking, prediction replay, bounty dari sponsor, dan achievement berdasarkan konsistensi. AI coach dapat merangkum bias pengguna seperti overconfidence, underreaction, atau terlalu sering mengejar market yang sudah bergerak, tetapi tetap tidak boleh mengambil alih keputusan trading.

Dalam jangka panjang, Forecast Arena dapat menjadi distribution layer untuk DreamDEX: aplikasi yang mendatangkan pengguna baru melalui kompetisi dan edukasi, lalu memperkenalkan mereka secara bertahap kepada on-chain trading. Nilai strategisnya bukan sekadar menambah satu interface, melainkan mengubah Event Contracts menjadi aktivitas sosial yang memiliki loop belajar, bermain, membandingkan, dan kembali.

---

## 21. Open Questions

1. Market type dan asset apa yang paling stabil tersedia di Somnia testnet selama periode demo?
2. Apakah pembuatan arena harus permissionless atau hanya host terverifikasi pada MVP?
3. Apakah leaderboard practice dan trade perlu dipisahkan sepenuhnya pada tahap awal?
4. Data mana yang tersedia langsung dari SDK untuk settlement history dan redemption scanning?
5. Apakah arena dapat menggunakan market yang sama dengan expiry berbeda secara otomatis?
6. Apakah host dapat menetapkan stake cap atau seluruh risk policy dikelola aplikasi?
7. Apakah pseudonym disimpan secara lokal, ditandatangani wallet, atau disimpan pada database aplikasi?
8. Apakah DreamDEX memiliki batasan atau rekomendasi khusus untuk public RPC, websocket reconnect, dan event replay?

Open questions tersebut harus ditutup pada Sprint 0 melalui dokumentasi teknis dan pengujian testnet. Jangan menambahkan fitur yang bergantung pada jawaban belum pasti ke dalam acceptance criteria MVP.

---

## 22. References

[1]: https://dorahacks.io/hackathon/event-contracts/detail "Event Contracts Hackathon — DoraHacks"

[2]: https://docs.dreamdex.io/developers/event-contracts "DreamDEX Event Contracts Developer Documentation"

[3]: https://dorahacks.io/hackathon/event-contracts/buidl "Registered BUIDLs — Event Contracts Hackathon"

---

**Catatan implementasi:** Dokumen ini adalah PRD produk dan bukan nasihat investasi, hukum, atau keuangan. Seluruh implementasi trading untuk hackathon harus menggunakan testnet, nominal demo, wallet yang aman, serta disclosure yang jelas kepada pengguna.
