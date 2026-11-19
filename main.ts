// Entrypoint: nyalain forge di port ephemeral, daftar ke suite, lalu
// nunggu sampai suite bilang selesai. Ditulis ulang dari nol di sesi ini.
//
// Alurnya singkat:
//   1. Bikin server dari createApp() (semua routing tinggal di app.ts).
//   2. Listen di port 0 — kernel yang milih portnya, bukan kita.
//   3. POST {"port": n} ke $MAKEFUN_ENV_URL/register, retry kalau gagal.
//   4. GET $MAKEFUN_ENV_URL/done berulang sampai jawabannya done:true.
//   5. Tutup server, keluar 0.
//
// Satu-satunya yang dibutuhin dari luar: MAKEFUN_ENV_URL. Kalau variabel
// itu nggak ada, nggak ada yang bisa diajak ngomong, jadi keluar 1.

import { createApp } from "./app.ts";

// Jeda awal antar percobaan ulang, dan batas atasnya. Backoff naik dua
// kali lipat tiap gagal, tapi nggak pernah lebih dari batas atas —
// kegagalan transient (suite belum siap, jaringan goyang) pulih sendiri
// tanpa kita harus keluar.
const RETRY_AWAL_MS = 100;
const RETRY_MAKS_MS = 2_000;

// Jeda antar poll /done saat jawabannya masih false. Poll-nya pendek:
// tiap request selesai cepat, kita tidur sebentar, lalu tanya lagi.
const POLL_MS = 200;

// Tiap request ke suite dibatasi waktunya supaya tidak ada satu request
// pun yang menggantung selamanya kalau suite-nya macet.
const REQUEST_TIMEOUT_MS = 5_000;

function tidur(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function naikkanJeda(jeda: number): number {
  return Math.min(jeda * 2, RETRY_MAKS_MS);
}

// Nyalain server di port ephemeral dan kembalikan nomor portnya.
// Kalau listen gagal, lempar error — pemanggil yang mutusin keluar 1.
async function nyalakanServer(): Promise<{ port: number; tutup: () => Promise<void> }> {
  const server = createApp();

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const alamat = server.address();
      if (alamat === null || typeof alamat === "string") {
        reject(new Error("server tidak bind ke port TCP"));
        return;
      }
      resolve(alamat.port);
    });
  });

  const tutup = () =>
    new Promise<void>((resolve) => {
      // Putusin koneksi yang masih nyangkut dulu supaya close() tidak
      // nunggu keep-alive yang tidak akan ditutup sendiri.
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return { port, tutup };
}

// Daftarin port kita ke suite. Yang menang cuma pendaftar pertama, jadi
// sekali ada jawaban sukses kita berhenti. Gagal (error jaringan atau
// status bukan 2xx) = coba lagi dengan jeda yang makin panjang.
async function daftarKeSuite(registerUrl: string, port: number): Promise<void> {
  let jeda = RETRY_AWAL_MS;
  for (;;) {
    try {
      const jawaban = await fetch(registerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (jawaban.ok) return;
    } catch {
      // Jaringan / timeout: bukan akhir dunia, coba lagi di bawah.
    }
    await tidur(jeda);
    jeda = naikkanJeda(jeda);
  }
}

// Tanya terus ke /done sampai suite jawab {"done": true}.
// Jawaban false yang sehat = tidur sebentar lalu tanya lagi.
// Error / status aneh = backoff seperti register, jangan langsung mati.
async function tungguSuiteSelesai(doneUrl: string): Promise<void> {
  let jeda = RETRY_AWAL_MS;
  for (;;) {
    try {
      const jawaban = await fetch(doneUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (jawaban.ok) {
        const isi = (await jawaban.json()) as { done?: unknown };
        if (isi.done === true) return;
        await tidur(POLL_MS);
        jeda = RETRY_AWAL_MS;
        continue;
      }
    } catch {
      // Gagal ambil status: mundur sebentar, lalu coba lagi.
    }
    await tidur(jeda);
    jeda = naikkanJeda(jeda);
  }
}

async function jalan(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    console.error("MAKEFUN_ENV_URL tidak diset; tidak ada suite untuk dihubungi.");
    return 1;
  }

  const dasar = envUrl.endsWith("/") ? envUrl.slice(0, -1) : envUrl;
  const registerUrl = `${dasar}/register`;
  const doneUrl = `${dasar}/done`;

  let server: Awaited<ReturnType<typeof nyalakanServer>>;
  try {
    server = await nyalakanServer();
  } catch (err) {
    console.error("gagal bind server:", err instanceof Error ? err.message : err);
    return 1;
  }

  await daftarKeSuite(registerUrl, server.port);
  await tungguSuiteSelesai(doneUrl);

  await server.tutup();
  return 0;
}

process.exitCode = await jalan();
