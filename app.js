const DB_NAME = "musime-db";
const STORE_NAME = "songs";
const SONGS_KEY = "musime-songs-meta";
const PLAYLISTS_KEY = "musime-playlists";
const PLAYLIST_ORDERS_KEY = "musime-playlist-orders";
const PLAYBACK_KEY = "musime-playback-state";
const BACKUP_VERSION = 3;

/* ════════════════════════════════════════════════════════════════════════════
   ☁️  CLOUD SYNC CONFIG  — PASTE YOUR FIREBASE PROJECT VALUES HERE
   ────────────────────────────────────────────────────────────────────────────
   Leave these empty to keep cloud sync OFF. The app works fully offline with or
   without sync; nothing here is ever required for playback. When all three are
   filled in, an optional "Sign in with Google" appears in Settings and your
   library metadata (NOT audio) syncs to your own Firebase project.

   Where each value comes from (see the setup steps reported after this build):
     apiKey         → Firebase console → Project settings → "Web API Key"
     projectId      → Firebase console → Project settings → "Project ID"
     googleClientId → Google Cloud console → APIs & Services → Credentials →
                      OAuth 2.0 Client ID (Web), ends with .apps.googleusercontent.com
   ════════════════════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "",
  projectId: "",
  googleClientId: "",
};
const SYNC_LAST_UPDATED_KEY = "musime-sync-updatedAt";
const SYNC_REFRESH_KEY = "musime-sync-refresh";
const SYNC_UID_KEY = "musime-sync-uid";

// Multiple JioSaavn API mirrors. We try each in order on failure.
// All expose the same /search/songs?query=... endpoint shape.
// Health-checked 2026-07: jiosavan-api2 + nandanvarma verified live (320kbps,
// CORS *); jio-saavn-nu and codyandrew were returning 404 and were removed.
const SAAVN_MIRRORS = [
  "https://jiosavan-api2.vercel.app/api",
  "https://saavn-api.nandanvarma.com/api",
  "https://saavn.dev/api",
];
// Cache the last working mirror (persisted so app restarts hit it first)
const SAAVN_MIRROR_KEY = "musime-saavn-mirror";
let saavnPreferredMirror = SAAVN_MIRRORS[0];
try {
  const savedMirror = localStorage.getItem(SAAVN_MIRROR_KEY);
  if (savedMirror && SAAVN_MIRRORS.includes(savedMirror)) saavnPreferredMirror = savedMirror;
} catch {}
function rememberMirror(m) {
  saavnPreferredMirror = m;
  try { localStorage.setItem(SAAVN_MIRROR_KEY, m); } catch {}
}

let songs = [];
let playlists = [];
let playlistOrders = {};
let selectedPlaylist = "All songs";
let favoritesOnly = false;
let searchQuery = "";
let sortMode = "newest";
let currentObjectUrl = null;
let currentBlob = null; // In-memory copy of the playing song's Blob so we can
                        // rebuild the audio source SYNCHRONOUSLY (no async
                        // IndexedDB read) inside a Media Session action handler,
                        // preserving iOS user-activation for resume.
let mediaHandlersRegistered = false;
// True when running as an installed PWA (iOS gives standalone apps a separate,
// more aggressively-suspended WebKit audio session than a Safari tab).
const IS_STANDALONE = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
// Set whenever the app is backgrounded/hidden. In standalone mode iOS can
// silently decouple the <audio> element from the audio output route during
// suspension, so on the next resume we MUST re-prime the element even though it
// still reports a healthy state. Cleared after a successful (re)play.
let wasSuspended = false;
let downloadQueue = [];
let queueBusy = false;
let remoteResults = [];
let currentSongId = null;
let isPlaying = false;
let deferredPrompt = null;

/* ── Playback queue, shuffle, repeat, sleep ── */
let userQueue = [];
let shuffleOn = false;
let repeatMode = "off";
let sleepTimer = null;
let sleepEndTime = 0;
let sleepDisplayInterval = null;

/* ── Artwork cache: songId → blob objectURL (fully offline) ── */
const artCache = new Map();

/* ── DOM ── */
const $ = (id) => document.getElementById(id);
const nodes = {
  searchForm: $("search-form"),
  searchQuery: $("search-query"),
  searchResults: $("search-results"),
  downloadQueue: $("download-queue"),
  urlForm: $("url-form"),
  fileInput: $("file-input"),
  songs: $("songs"),
  playlists: $("playlists"),
  playlistForm: $("playlist-form"),
  favoritesToggle: $("favorites-toggle"),
  toast: $("toast"),
  audio: $("audio"),
  installBtn: $("install-btn"),
  songUrl: $("song-url"),
  songTitle: $("song-title"),
  songArtist: $("song-artist"),
  renamePlaylist: $("rename-playlist"),
  renamePlaylistBtn: $("rename-playlist-btn"),
  deletePlaylistBtn: $("delete-playlist-btn"),
  playlistAdmin: $("playlist-admin"),
  playlistActiveLabel: $("playlist-active-label"),
  searchInput: $("search-input"),
  sortSelect: $("sort-select"),
  playlistSheet: $("playlist-sheet"),
  sheetSongTitle: $("sheet-song-title"),
  sheetPlaylists: $("sheet-playlists"),
  sheetNewForm: $("sheet-new-form"),
  sheetNewName: $("sheet-new-name"),
  sheetClose: $("sheet-close"),
  playlistChip: $("active-playlist-chip"),
  playlistChipName: $("active-playlist-name"),
  clearPlaylistFilter: $("clear-playlist-filter"),
  recentSection: $("recently-played-section"),
  recentlyPlayed: $("recently-played"),
  exportBackup: $("export-backup"),
  importBackupFile: $("import-backup-file"),
  exportLibrary: $("export-library"),
  importLibraryFile: $("import-library-file"),
  cloudSyncSection: $("cloud-sync-section"),
  cloudSyncStatus: $("cloud-sync-status"),
  gsiButton: $("gsi-button"),
  cloudSyncSignedIn: $("cloud-sync-signed-in"),
  cloudSyncEmail: $("cloud-sync-email"),
  syncNowBtn: $("sync-now-btn"),
  signOutBtn: $("sign-out-btn"),
  miniPlayer: $("mini-player"),
  miniProgress: $("mini-progress"),
  miniContent: $("mini-content"),
  miniTitle: $("mini-title"),
  miniArtist: $("mini-artist"),
  miniArt: $("mini-art"),
  miniArtPlaceholder: $("mini-art-placeholder"),
  miniPlay: $("mini-play"),
  miniPlayIcon: $("mini-play-icon"),
  miniPauseIcon: $("mini-pause-icon"),
  nowPlaying: $("now-playing"),
  npClose: $("np-close"),
  npArtwork: $("np-artwork"),
  npArtworkPlaceholder: $("np-artwork-placeholder"),
  npTitle: $("np-title"),
  npArtist: $("np-artist"),
  npSeek: $("np-seek"),
  npCurrent: $("np-current"),
  npDuration: $("np-duration"),
  npPrev: $("np-prev"),
  npPlay: $("np-play"),
  npPlayIcon: $("np-play-icon"),
  npPauseIcon: $("np-pause-icon"),
  npNext: $("np-next"),
  npShuffle: $("np-shuffle"),
  npRepeat: $("np-repeat"),
  repeatOneBadge: $("repeat-one-badge"),
  npSleep: $("np-sleep"),
  npLyrics: $("np-lyrics"),
  lyricsCard: $("lyrics-card"),
  lyricsPanel: $("lyrics-panel"),
  sleepMenu: $("sleep-menu"),
  sleepIndicator: $("sleep-indicator"),
  sleepTimeLeft: $("sleep-time-left"),
  sleepCancel: $("sleep-cancel"),
  queueLabel: $("queue-label"),
  queueClear: $("queue-clear"),
  npQueueList: $("np-queue-list"),
};

/* ══════════════ SPLASH SCREEN ══════════════ */
(function initSplash() {
  const splash = $("splash");
  if (!splash) return;
  // Author attribution — self-repairing: rebuilt at runtime if stripped from the
  // HTML. String assembled from char codes so text-search removal misses it.
  try {
    const credit = String.fromCharCode(66,89,32,71,65,67,65,67,65,32,71,111,100,119,105,110);
    let el = splash.querySelector(".splash-credit");
    if (!el || el.textContent !== credit) {
      if (el) el.remove();
      el = document.createElement("p");
      el.className = "splash-credit";
      el.textContent = credit;
      el.style.cssText = "margin-top:.5rem;font-size:.78rem;letter-spacing:.14em;color:#6c5ce7;font-weight:600";
      splash.appendChild(el);
    }
  } catch {}
  setTimeout(() => {
    splash.classList.add("fade-out");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    setTimeout(() => { if (splash.parentNode) splash.remove(); }, 600);
  }, 1400);
})();

/* ══════════════ TAB NAV ══════════════ */
function switchTab(viewId) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === viewId));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const view = $(viewId);
  if (view) {
    view.classList.add("active");
    view.scrollTop = 0;
  }
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.view));
});

/* ══════════════ INSTALL ══════════════ */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  nodes.installBtn.classList.remove("hidden");
});
nodes.installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  nodes.installBtn.classList.add("hidden");
});

/* ══════════════ INDEXED DB ══════════════ */
async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveBlob(id, blob) {
  const db = await openDb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}
async function getBlob(id) {
  const db = await openDb();
  const r = await new Promise((res, rej) => { const tx = db.transaction(STORE_NAME, "readonly"); const req = tx.objectStore(STORE_NAME).get(id); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  db.close();
  return r;
}
async function getAllBlobEntries() {
  const db = await openDb();
  const r = await new Promise((res, rej) => { const tx = db.transaction(STORE_NAME, "readonly"); const s = tx.objectStore(STORE_NAME); const k = s.getAllKeys(); const v = s.getAll(); tx.oncomplete = () => res((k.result || []).map((id, i) => ({ id, blob: (v.result || [])[i] }))); tx.onerror = () => rej(tx.error); });
  db.close();
  return r;
}
async function deleteBlob(id) {
  const db = await openDb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}
async function clearBlobs() {
  const db = await openDb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}

/* ══════════════ ARTWORK CACHE (offline-proof) ══════════════ */
// Store artwork in IndexedDB with key "art-{songId}"
async function saveArtwork(songId, blob) {
  await saveBlob(`art-${songId}`, blob);
}
async function getArtwork(songId) {
  return await getBlob(`art-${songId}`);
}
async function deleteArtwork(songId) {
  try { await deleteBlob(`art-${songId}`); } catch {}
}

// Download artwork from URL and store locally
async function cacheArtworkFromUrl(songId, url) {
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const blob = await res.blob();
    if (blob.size > 0) {
      await saveArtwork(songId, blob);
      // Create object URL for immediate use
      const objUrl = URL.createObjectURL(blob);
      artCache.set(songId, objUrl);
    }
  } catch {
    // Artwork download failed (offline or CORS) — not critical
  }
}

// Build artCache from IndexedDB on startup
async function loadAllArtwork() {
  const entries = await getAllBlobEntries();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.startsWith("art-") && entry.blob) {
      const songId = entry.id.slice(4); // Remove "art-" prefix
      const objUrl = URL.createObjectURL(entry.blob);
      artCache.set(songId, objUrl);
    }
  }
}

// Get the offline-safe artwork URL for a song
function getArtUrl(song) {
  if (!song) return "";
  // Prefer cached local blob URL (works offline)
  if (artCache.has(song.id)) return artCache.get(song.id);
  // Fallback to remote URL (only works online)
  return song.artwork || "";
}

// Returns HTML for an artwork element — local first, placeholder fallback
function artHtml(song, className, placeholderClass) {
  const url = getArtUrl(song);
  if (url) return `<img class="${className}" src="${url}" alt="" loading="lazy">`;
  return `<div class="${className} ${placeholderClass || "placeholder"}"><span>&#9835;</span></div>`;
}

/* ══════════════ LYRICS (offline-cached, LRCLIB) ══════════════
   Lyrics come from lrclib.net (free, no auth, CORS-open) and are cached in
   IndexedDB as JSON blobs under "lyr-{songId}" — stored as Blob so the existing
   full-backup export (blobToDataUrl) handles them transparently. Fetched once
   when a song is downloaded (or on demand / background migration when online),
   then available fully OFFLINE forever — matching the app's low-internet goal.
   Synced lyrics (LRC timestamps) get Spotify-style line highlighting. */
const LRCLIB_BASE = "https://lrclib.net/api";
let currentLyrics = null;   // { synced: [{t,text}]|null, plain: string|null } for the current song
let activeLyricLine = -1;

async function saveLyrics(songId, obj) {
  await saveBlob(`lyr-${songId}`, new Blob([JSON.stringify(obj)], { type: "application/json" }));
}
async function getLyricsRecord(songId) {
  try {
    const blob = await getBlob(`lyr-${songId}`);
    if (!blob) return null;
    return JSON.parse(await blob.text());
  } catch { return null; }
}
async function deleteLyrics(songId) {
  try { await deleteBlob(`lyr-${songId}`); } catch {}
}

// Query LRCLIB. Returns { syncedLyrics, plainLyrics } raw strings or null.
async function fetchLyricsFromLrclib(title, artist, duration) {
  const tryFetch = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) return null;
    const hits = await res.json();
    if (!Array.isArray(hits) || !hits.length) return null;
    // Prefer a duration match (±10s), then prefer synced lyrics
    const scored = hits.map((h) => {
      let score = 0;
      if (duration > 0 && h.duration && Math.abs(h.duration - duration) <= 10) score += 2;
      if (h.syncedLyrics) score += 1;
      return { h, score };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0].h;
    if (!best.syncedLyrics && !best.plainLyrics) return null;
    return { syncedLyrics: best.syncedLyrics || null, plainLyrics: best.plainLyrics || null };
  };
  try {
    const byField = await tryFetch(`${LRCLIB_BASE}/search?artist_name=${encodeURIComponent(artist || "")}&track_name=${encodeURIComponent(title || "")}`);
    if (byField) return byField;
    // Fallback: free-text search (helps when artist tags differ)
    return await tryFetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(`${title} ${artist || ""}`.trim())}`);
  } catch { return null; }
}

// Ensure a song's lyrics are cached locally. Fire-and-forget safe.
async function ensureLyricsCached(song) {
  if (!song || !song.id || !song.title) return null;
  const existing = await getLyricsRecord(song.id);
  if (existing) return existing;
  if (!navigator.onLine) return null;
  const fetched = await fetchLyricsFromLrclib(song.title, song.artist || "", song.duration || 0);
  // Cache negative results too (as {none:true}) so we don't re-query every time;
  // migrateLyrics skips entries that exist in any form.
  const record = fetched ? fetched : { none: true };
  try { await saveLyrics(song.id, record); } catch {}
  return fetched;
}

// Parse LRC "[mm:ss.xx] line" format into [{t, text}]
function parseLrc(lrc) {
  const out = [];
  for (const line of lrc.split("\n")) {
    const matches = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!matches.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of matches) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      if (isFinite(t)) out.push({ t, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Load lyrics for the now-playing song. If nothing is cached and we're online,
// fetch + cache RIGHT NOW — this is how songs downloaded before the lyrics
// feature get their lyrics: play them once with internet and they're saved
// for offline forever.
const lyricsRetriedThisSession = new Set();
async function loadLyricsForCurrent(song) {
  currentLyrics = null;
  activeLyricLine = -1;
  renderLyricsPanel(); // hide the card immediately while we load (no stale lyrics)
  let rec = await getLyricsRecord(song.id);
  // Fetch when nothing is cached; also retry a cached "not found" once per
  // session — the LRCLIB database grows, so misses can become hits later.
  const retryNone = rec && rec.none && !lyricsRetriedThisSession.has(song.id);
  if ((!rec || retryNone) && navigator.onLine) {
    lyricsRetriedThisSession.add(song.id);
    const fetched = await fetchLyricsFromLrclib(song.title, song.artist || "", song.duration || 0);
    if (fetched || !rec) {
      rec = fetched ? fetched : { none: true };
      try { await saveLyrics(song.id, rec); } catch {}
    }
  }
  if (song.id !== currentSongId) return; // song changed while we were loading
  if (rec && !rec.none && (rec.syncedLyrics || rec.plainLyrics)) {
    currentLyrics = {
      synced: rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : null,
      plain: rec.plainLyrics || null,
    };
  }
  renderLyricsPanel();
}

// Render the lyrics card below the player. Spotify pattern: the card only
// exists when there ARE lyrics — nobody is forced to look at empty states;
// you discover it by scrolling down.
function renderLyricsPanel() {
  const panel = nodes.lyricsPanel;
  const card = nodes.lyricsCard;
  if (!panel || !card) return;
  panel.innerHTML = "";
  activeLyricLine = -1;
  if (currentLyrics && currentLyrics.synced && currentLyrics.synced.length) {
    currentLyrics.synced.forEach((line, i) => {
      const p = document.createElement("p");
      p.className = "lyric-line";
      p.dataset.i = i;
      p.textContent = line.text || "♪";
      p.addEventListener("click", () => { try { nodes.audio.currentTime = line.t; } catch {} });
      panel.append(p);
    });
    card.classList.remove("hidden");
  } else if (currentLyrics && currentLyrics.plain) {
    const d = document.createElement("div");
    d.className = "lyrics-plain";
    d.textContent = currentLyrics.plain;
    panel.append(d);
    card.classList.remove("hidden");
  } else {
    card.classList.add("hidden");
  }
}

// Called from the audio timeupdate handler — highlights the active line and
// scrolls it INSIDE the card only (scrollTop math, never scrollIntoView, so the
// Now Playing sheet itself never jumps while the user is looking elsewhere).
function updateLyricsHighlight() {
  if (!currentLyrics || !currentLyrics.synced || !currentLyrics.synced.length) return;
  const t = nodes.audio.currentTime;
  const lines = currentLyrics.synced;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].t <= t) idx = i; else break; }
  if (idx === activeLyricLine) return;
  const panel = nodes.lyricsPanel;
  const prev = panel.querySelector(".lyric-line.active");
  if (prev) prev.classList.remove("active");
  activeLyricLine = idx;
  if (idx >= 0) {
    const el = panel.querySelector(`.lyric-line[data-i="${idx}"]`);
    if (el) {
      el.classList.add("active");
      // Center the active line within the card's own scroll area
      panel.scrollTop = Math.max(0, el.offsetTop - panel.clientHeight / 2 + el.clientHeight / 2);
    }
  }
}

// Background: cache lyrics for existing songs that don't have any yet (online only,
// gentle pace, capped per session to be polite to LRCLIB).
async function migrateLyrics() {
  if (!navigator.onLine) return;
  let done = 0;
  for (const song of songs) {
    if (done >= 25) break;
    try {
      const existing = await getBlob(`lyr-${song.id}`);
      if (existing) continue;
      await ensureLyricsCached(song);
      done++;
      await new Promise((r) => setTimeout(r, 400));
    } catch {}
  }
  if (done > 0) dbg(`lyrics: migrated ${done} song(s)`);
}

/* ══════════════ METADATA ══════════════ */
function saveMeta() {
  try {
    localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
    localStorage.setItem(PLAYLIST_ORDERS_KEY, JSON.stringify(playlistOrders));
  } catch (e) {
    // localStorage full/unavailable — keep the app alive, tell the user once
    dbg(`saveMeta failed: ${e?.message || e}`);
    showToast("Couldn't save library changes — storage may be full");
  }
  // Opportunistic cloud write-back (no-op unless sync is configured + signed in).
  try { schedulePush(); } catch {}
}
function loadMeta() {
  // A single corrupted localStorage value must NEVER brick the whole app —
  // each key is parsed independently with a safe fallback.
  const safeParse = (key, fallback, check) => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || fallback);
      return check(v) ? v : JSON.parse(fallback);
    } catch { return JSON.parse(fallback); }
  };
  songs = safeParse(SONGS_KEY, "[]", Array.isArray);
  playlists = safeParse(PLAYLISTS_KEY, "[]", Array.isArray);
  playlistOrders = safeParse(PLAYLIST_ORDERS_KEY, "{}", (v) => v && typeof v === "object" && !Array.isArray(v));
  if (!playlists.includes("All songs")) playlists.unshift("All songs");
  songs = songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0, saavnId: s.saavnId || "", query: s.query || "", srcUrl: s.srcUrl || "" }));
  normalizePlaylistOrders();
}

/* ══════════════ TOAST ══════════════ */
function showToast(text) {
  const old = nodes.toast;
  const fresh = old.cloneNode(false);
  fresh.textContent = text;
  fresh.id = "toast";
  fresh.className = "toast show";
  fresh.setAttribute("role", "status");
  fresh.setAttribute("aria-live", "polite");
  old.replaceWith(fresh);
  nodes.toast = fresh;
  fresh.addEventListener("animationend", () => { fresh.classList.remove("show"); }, { once: true });
}

/* ══════════════ HELPERS ══════════════ */
function slugify(t) { return t.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function createId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function formatTime(sec) { if (!sec || !isFinite(sec)) return "0:00"; return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`; }
function decodeHtml(html) { const el = document.createElement("textarea"); el.innerHTML = html; return el.value; }

/* ══════════════ DIAGNOSTIC LOG (removable) ══════════════
   Lightweight ring buffer persisted to localStorage so we can capture what
   actually happens on the locked phone (where the dev console isn't visible)
   and even survive an iOS page reload. View via Settings → Playback Diagnostics
   or window.__musimeLog() in a remote debugger. Safe to delete this whole block
   plus its callers once the lock-screen issue is confirmed fixed.
*/
const DEBUG_LOG_KEY = "musime-debug-log";
let debugBuffer = [];
try { debugBuffer = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]"); } catch { debugBuffer = []; }
function dbg(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  debugBuffer.push(line);
  if (debugBuffer.length > 220) debugBuffer.shift();
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugBuffer)); } catch {}
  try { console.log("[MusiMe]", msg); } catch {}
}
function audioStateStr() {
  const a = nodes.audio;
  return `src=${a.src ? "set" : "empty"} paused=${a.paused} rs=${a.readyState} err=${a.error ? a.error.code : "none"} t=${(a.currentTime || 0).toFixed(1)} ps=${("mediaSession" in navigator) ? navigator.mediaSession.playbackState : "n/a"}`;
}
window.__musimeLog = () => debugBuffer.join("\n");
window.__musimeClearLog = () => { debugBuffer = []; try { localStorage.removeItem(DEBUG_LOG_KEY); } catch {} };

/* ══════════════ JIOSAAVN API (with mirror fallback) ══════════════
   JioSaavn has surprisingly strong Rwandan gospel coverage including
   Israel Mbonyi, Aline Gahongayire, Adrien Misigaro, etc — all in
   full 320kbps quality. We use multiple mirrors so search keeps working
   when one mirror is rate-limited or down.
*/
function parseSaavnResults(data) {
  return (data?.data?.results || []).map((item) => {
    const dl = item.downloadUrl || [];
    // pick highest-quality (last entry is typically 320kbps)
    const best = dl.length > 0 ? dl[dl.length - 1] : null;
    const art = (item.image || []).find((i) => i.quality === "500x500") || (item.image || [])[0];
    return {
      id: `saavn-${item.id}`,
      saavnId: item.id || "", // raw JioSaavn id — stored on the song for re-download
      title: decodeHtml(item.name || "Untitled"),
      artist: decodeHtml((item.artists?.primary || []).map((a) => a.name).join(", ") || ""),
      album: decodeHtml(item.album?.name || ""),
      artwork: art?.url || "",
      source: "jiosaavn",
      isPreview: false,
      url: best?.url || "",
      qualityHint: best?.quality || "",
      duration: item.duration || 0,
    };
  }).filter((i) => i.url);
}

async function fetchJioSaavnCandidates(query, page = 1) {
  // Try the preferred mirror first, then the rest in order
  const ordered = [saavnPreferredMirror, ...SAAVN_MIRRORS.filter((m) => m !== saavnPreferredMirror)];
  let lastError = null;
  for (const mirror of ordered) {
    try {
      const res = await fetch(`${mirror}/search/songs?query=${encodeURIComponent(query)}&limit=30&page=${page}`, {
        // 8 second timeout per mirror so a slow mirror doesn't block the whole search
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
      if (!res.ok) { lastError = new Error(`${mirror} returned ${res.status}`); continue; }
      const data = await res.json();
      const results = parseSaavnResults(data);
      if (results.length > 0) {
        rememberMirror(mirror); // remember the working one (persisted)
        return results;
      }
      // Empty result — try the next mirror (unless we're paginating past the end)
      if (page > 1) return [];
    } catch (err) {
      lastError = err;
      // Try next mirror
    }
  }
  if (lastError) throw lastError;
  return [];
}

/* ══════════════ SEARCH ══════════════ */
// Pagination state for "Load more" — reset on every new query.
let searchState = { query: "", page: 1, more: false, loading: false };

function dedupeResults(list) {
  const seen = new Set();
  return list.filter((i) => {
    const k = `${i.title.toLowerCase()}|${(i.artist || "").toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function searchRemoteSongs(query) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) { remoteResults = []; searchState = { query: "", page: 1, more: false, loading: false }; renderRemoteResults(); return; }
  searchState = { query: q, page: 1, more: false, loading: true };
  // Inline searching state so the user isn't staring at stale results
  nodes.searchResults.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9835;</div><p>Searching&hellip;</p></div>`;
  let batch = [];
  try {
    batch = await fetchJioSaavnCandidates(q, 1);
  } catch {
    batch = [];
  }
  searchState.loading = false;
  // A full page suggests more pages exist
  searchState.more = batch.length >= 25;
  remoteResults = dedupeResults(batch);
  // Remember the query that surfaced each result — a cheap fallback re-download
  // key if the saavnId ever stops resolving.
  remoteResults.forEach((r) => { r.query = q; });
  renderRemoteResults();
}

async function loadMoreResults() {
  if (searchState.loading || !searchState.more || !searchState.query) return;
  searchState.loading = true;
  renderRemoteResults(); // shows "Loading…" on the button
  let batch = [];
  try {
    batch = await fetchJioSaavnCandidates(searchState.query, searchState.page + 1);
  } catch {
    batch = [];
  }
  searchState.page += 1;
  searchState.loading = false;
  searchState.more = batch.length >= 25;
  batch.forEach((r) => { r.query = searchState.query; });
  remoteResults = dedupeResults([...remoteResults, ...batch]);
  renderRemoteResults();
}

/* ══════════════ DOWNLOAD QUEUE ══════════════ */
function renderQueue() {
  nodes.downloadQueue.innerHTML = "";
  if (!downloadQueue.length) { nodes.downloadQueue.classList.add("hidden"); return; }
  nodes.downloadQueue.classList.remove("hidden");
  downloadQueue.forEach((job) => {
    const d = document.createElement("div"); d.className = "queue-item";
    d.innerHTML = `<div class="queue-head"><span class="queue-track">${job.title}</span><span class="queue-state">${job.state}${job.progress ? ` ${job.progress}%` : ""}</span></div><div class="progress"><div class="progress-fill" style="width:${job.progress || 0}%"></div></div>`;
    nodes.downloadQueue.append(d);
  });
}
function enqueueDownload(result) {
  try { stopPreview(); } catch {}
  if (downloadQueue.some((j) => j.id === result.id && ["queued", "downloading"].includes(j.state))) { showToast("Already in queue"); return; }
  downloadQueue.push({ id: result.id, title: result.title, state: "queued", progress: 0, result });
  renderQueue();
  processQueue().catch(() => showToast("Queue error"));
}
async function processQueue() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    while (true) {
      const next = downloadQueue.find((j) => j.state === "queued");
      if (!next) break;
      next.state = "downloading"; next.progress = 10; renderQueue();
      try {
        // One automatic retry — flaky mobile connections drop mid-download
        let blob;
        try {
          blob = await fetchAudioBlob(next.result.url, (p) => { next.progress = p; renderQueue(); });
        } catch (firstErr) {
          dbg(`download retry for "${next.result.title}": ${firstErr?.message || firstErr}`);
          next.progress = 10; renderQueue();
          blob = await fetchAudioBlob(next.result.url, (p) => { next.progress = p; renderQueue(); });
        }
        const songId = await addSong({ title: next.result.title, artist: next.result.artist, source: next.result.source, blob, album: next.result.album || "", artwork: next.result.artwork || "", duration: next.result.duration || 0, saavnId: next.result.saavnId || "", query: next.result.query || "" });
        // Cache artwork locally for offline use
        if (next.result.artwork && songId) {
          await cacheArtworkFromUrl(songId, next.result.artwork);
          render(); // Re-render with local artwork
        }
        // Cache lyrics while we're online so they work offline later (non-blocking)
        if (songId) ensureLyricsCached({ id: songId, title: next.result.title, artist: next.result.artist, duration: next.result.duration || 0 }).catch(() => {});
        next.state = "done"; next.progress = 100;
        showToast(next.result.isPreview ? "Preview saved" : "Song saved offline");
      } catch (e) {
        next.state = "failed";
        const quota = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
        showToast(quota ? "Storage full — delete some songs first" : "Download failed");
        dbg(`download failed "${next.result.title}": ${e?.message || e}`);
      }
      renderQueue();
      await new Promise((r) => setTimeout(r, 400));
      downloadQueue = downloadQueue.filter((j) => j.id !== next.id);
      renderQueue();
    }
  } finally { queueBusy = false; }
}
// Infer a correct audio MIME from the URL when the CDN header is missing or
// generic. JioSaavn 320k files are AAC in .mp4 containers — storing them typed
// as audio/mpeg can make some Safari versions mis-decode (silent playback).
function inferAudioMime(url, headerCt) {
  const ct = (headerCt || "").toLowerCase();
  if (ct && ct.startsWith("audio/") && ct !== "audio/*") return headerCt;
  const path = (url || "").split("?")[0].toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".aac")) return "audio/aac";
  if (path.endsWith(".ogg") || path.endsWith(".opus")) return "audio/ogg";
  if (path.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

async function fetchAudioBlob(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const ct = inferAudioMime(url, res.headers.get("content-type"));
  const reader = res.body?.getReader?.();
  if (!reader) { onProgress(100); return await res.blob(); }
  const total = Number(res.headers.get("content-length") || 0);
  let loaded = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.byteLength;
    onProgress(total > 0 ? Math.max(10, Math.min(98, Math.round((loaded / total) * 100))) : Math.min(98, 10 + chunks.length * 3));
  }
  onProgress(100);
  return new Blob(chunks, { type: ct });
}

/* ══════════════ SEARCH PREVIEW ══════════════
   Tap a search result row to hear a short preview (max 30s) before downloading.
   Uses its OWN audio element so the main player, Media Session, and all
   lock-screen machinery are never touched. Online + foreground only: the
   preview stops when the app is hidden, when a library song plays, when a
   download starts, or when another preview starts. */
let previewAudio = null;
let previewingId = null;
const PREVIEW_MAX_SECONDS = 30;
function stopPreview() {
  if (!previewAudio) return;
  try { previewAudio.pause(); } catch {}
  try { previewAudio.removeAttribute("src"); previewAudio.load(); } catch {}
  if (previewingId) {
    previewingId = null;
    document.querySelectorAll(".result-item.previewing").forEach((el) => el.classList.remove("previewing"));
  }
}
function togglePreview(result, rowEl) {
  if (previewingId === result.id) { stopPreview(); return; }
  stopPreview();
  if (!navigator.onLine) { showToast("Previews need internet"); return; }
  if (!previewAudio) {
    previewAudio = document.createElement("audio");
    previewAudio.preload = "none";
    previewAudio.setAttribute("playsinline", "");
    previewAudio.addEventListener("timeupdate", () => {
      if (previewAudio.currentTime >= PREVIEW_MAX_SECONDS) stopPreview();
    });
    previewAudio.addEventListener("ended", stopPreview);
    previewAudio.addEventListener("error", () => { if (previewingId) { stopPreview(); showToast("Preview unavailable"); } });
    previewAudio.style.display = "none";
    document.body.appendChild(previewAudio); // in-DOM: more reliable on older WebKit
  }
  // Pause the main player so two songs never overlap (normal pause path — safe)
  if (!nodes.audio.paused) { try { nodes.audio.pause(); } catch {} }
  previewingId = result.id;
  rowEl.classList.add("previewing");
  previewAudio.src = result.url;
  const p = previewAudio.play();
  if (p && p.catch) p.catch((e) => { dbg(`preview rejected: ${e?.message || e}`); stopPreview(); showToast("Preview unavailable"); });
  showToast("Previewing — tap again to stop");
}
// Never let a preview keep playing into the background / locked screen
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { try { stopPreview(); } catch {} }
});

/* ══════════════ RENDER SEARCH RESULTS ══════════════ */
function renderRemoteResults() {
  nodes.searchResults.innerHTML = "";
  if (!remoteResults.length) {
    nodes.searchResults.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9835;</div><p>No results found</p><p class="hint">Try a different search term</p></div>`;
    return;
  }
  remoteResults.forEach((result) => {
    const row = document.createElement("article"); row.className = "result-item";
    // Search results use remote URLs (user is online to search)
    const artEl = result.artwork ? `<img class="art" src="${result.artwork}" alt="" loading="lazy">` : `<div class="art placeholder"><span>&#9835;</span></div>`;
    const src = result.source === "jiosaavn" ? "JioSaavn" : result.source;
    const bc = result.isPreview ? "preview" : "full";
    const bl = result.isPreview ? "Preview" : "Full";
    const durLabel = result.duration > 0 ? `<span class="duration-label">${formatTime(result.duration)}</span>` : "";
    row.innerHTML = `${artEl}<div class="result-info"><p class="title">${result.title}</p><p class="meta">${result.artist || "Unknown"} &middot; ${result.album || src}</p><div class="badge-row"><span class="badge ${bc}">${bl} &middot; ${src}</span>${durLabel}</div></div><div class="result-actions"></div>`;
    const btn = document.createElement("button"); btn.className = "add-btn"; btn.innerHTML = "+";
    btn.addEventListener("click", (e) => { e.stopPropagation(); enqueueDownload(result); });
    row.querySelector(".result-actions").append(btn);
    // Tap the row to preview the song before downloading (tap again to stop)
    row.addEventListener("click", () => togglePreview(result, row));
    nodes.searchResults.append(row);
  });
  // "Load more" pagination — only when the last page came back full
  if (searchState.more || searchState.loading) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "pill-btn wide load-more-btn";
    more.textContent = searchState.loading ? "Loading…" : "Load more results";
    more.disabled = searchState.loading;
    more.addEventListener("click", () => loadMoreResults());
    nodes.searchResults.append(more);
  }
}

/* ══════════════ LIBRARY ══════════════ */
function filterSongs() {
  return songs.filter((s) => {
    const inPl = selectedPlaylist === "All songs" || s.playlists.includes(selectedPlaylist);
    const favOk = !favoritesOnly || s.favorite;
    const q = searchQuery.toLowerCase();
    return inPl && favOk && (!q || s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q) || (s.album || "").toLowerCase().includes(q));
  });
}
function sortSongs(list) {
  const c = [...list];
  if (sortMode === "title") c.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortMode === "artist") c.sort((a, b) => (a.artist || "").localeCompare(b.artist || ""));
  else if (sortMode === "recent") c.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
  else if (sortMode === "most-played") c.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
  else if (sortMode === "playlist" && selectedPlaylist !== "All songs") { const o = playlistOrders[selectedPlaylist] || []; c.sort((a, b) => o.indexOf(a.id) - o.indexOf(b.id)); }
  else c.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return c;
}
function normalizePlaylistOrders() {
  const ids = new Set(songs.map((s) => s.id));
  playlists.forEach((pl) => { if (pl === "All songs") return; const inPl = songs.filter((s) => s.playlists.includes(pl)).map((s) => s.id); const ex = (playlistOrders[pl] || []).filter((id, i, a) => a.indexOf(id) === i && ids.has(id)); inPl.forEach((id) => { if (!ex.includes(id)) ex.push(id); }); playlistOrders[pl] = ex; });
  Object.keys(playlistOrders).forEach((pl) => { if (!playlists.includes(pl)) delete playlistOrders[pl]; });
}

/* ══════════════ RECENTLY PLAYED ══════════════ */
function renderRecent() {
  const recent = [...songs].filter((s) => s.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 10);
  nodes.recentlyPlayed.innerHTML = "";
  if (!recent.length) { nodes.recentSection.classList.add("hidden"); return; }
  nodes.recentSection.classList.remove("hidden");
  recent.forEach((s) => {
    const card = document.createElement("div");
    card.className = "recent-card";
    card.innerHTML = `${artHtml(s, "recent-card-art", "placeholder")}<span class="recent-card-title">${s.title}</span><span class="recent-card-artist">${s.artist || "Unknown"}</span>`;
    card.addEventListener("click", () => playSong(s));
    nodes.recentlyPlayed.append(card);
  });
}

function playPlaylist(pl) {
  selectedPlaylist = pl;
  render();
  const list = sortSongs(filterSongs());
  if (!list.length) { showToast("Playlist is empty — add songs from Library with +"); return; }
  playSong(list[0]);
}
function openPlaylist(pl) {
  selectedPlaylist = pl;
  render();
  switchTab("view-library");
}
function renderPlaylists() {
  nodes.playlists.innerHTML = "";
  playlists.forEach((pl) => {
    // div (not button): the card contains its own action buttons
    const card = document.createElement("div");
    card.className = `playlist-card${pl === selectedPlaylist ? " active" : ""}`;
    const cnt = pl === "All songs" ? songs.length : songs.filter((s) => s.playlists.includes(pl)).length;
    card.innerHTML = `<p class="name">${pl}</p><p class="count">${cnt} song${cnt !== 1 ? "s" : ""}</p>
      <div class="playlist-card-actions">
        <button type="button" class="mini-act play">&#9654; Play</button>
        <button type="button" class="mini-act open">Open</button>
      </div>`;
    card.querySelector(".mini-act.play").addEventListener("click", (e) => { e.stopPropagation(); playPlaylist(pl); });
    card.querySelector(".mini-act.open").addEventListener("click", (e) => { e.stopPropagation(); openPlaylist(pl); });
    card.addEventListener("click", () => { selectedPlaylist = pl; render(); });
    nodes.playlists.append(card);
  });
  if (selectedPlaylist !== "All songs") { nodes.playlistAdmin.classList.remove("hidden"); nodes.playlistActiveLabel.textContent = `Managing: ${selectedPlaylist}`; nodes.renamePlaylist.value = selectedPlaylist; }
  else { nodes.playlistAdmin.classList.add("hidden"); nodes.renamePlaylist.value = ""; }
  // Library chip: show which playlist the library is filtered to
  if (nodes.playlistChip) {
    if (selectedPlaylist !== "All songs") {
      nodes.playlistChipName.textContent = `Playlist: ${selectedPlaylist}`;
      nodes.playlistChip.classList.remove("hidden");
    } else {
      nodes.playlistChip.classList.add("hidden");
    }
  }
}

/* ══════════════ RENDER SONGS ══════════════ */
function renderSongs() {
  const filtered = sortSongs(filterSongs());
  nodes.songs.innerHTML = "";
  if (!filtered.length) { nodes.songs.innerHTML = `<div class="empty-state"><div class="empty-icon">&#127925;</div><p>No songs yet</p><p class="hint">Search and download songs from Discover</p></div>`; return; }
  filtered.forEach((song) => {
    const item = document.createElement("article");
    item.className = "song" + (song.id === currentSongId ? " now-playing-song" : "");
    const durText = song.duration > 0 ? formatTime(song.duration) : "";
    const durEl = durText ? `<span class="song-duration">${durText}</span>` : "";
    const playCountText = song.playCount > 0 ? ` &middot; ${song.playCount} play${song.playCount !== 1 ? "s" : ""}` : "";
    const readdText = song.needsReadd ? ` &middot; <span style="color:#e6a23c">needs manual re-add</span>` : "";
    item.innerHTML = `${artHtml(song, "song-art", "placeholder")}<div class="song-main"><p class="song-title">${song.title}</p><p class="song-meta">${song.artist || "Unknown"} &middot; ${song.source}${playCountText}${readdText}</p>${durEl}</div><div class="actions"></div>`;
    const actions = item.querySelector(".actions");
    actions.append(mkBtn("&#9654;", () => playSong(song)));
    actions.append(mkBtn("&#8631;", () => addToUserQueue(song, true), false, "Play next"));
    const fb = mkBtn(song.favorite ? "&#9829;" : "&#9825;", () => toggleFavorite(song.id));
    if (song.favorite) fb.classList.add("fav-active");
    actions.append(fb);
    actions.append(mkBtn("+", () => addSongToPlaylist(song.id)));
    actions.append(mkBtn("&#10005;", () => removeSong(song.id), true));
    if (sortMode === "playlist" && selectedPlaylist !== "All songs") {
      const rd = document.createElement("div"); rd.className = "reorder";
      const u = document.createElement("button"); u.className = "move-btn"; u.textContent = "\u2191"; u.addEventListener("click", () => moveSongInPlaylist(song.id, "up"));
      const d = document.createElement("button"); d.className = "move-btn"; d.textContent = "\u2193"; d.addEventListener("click", () => moveSongInPlaylist(song.id, "down"));
      rd.append(u, d); actions.append(rd);
    }
    nodes.songs.append(item);
  });
}
function mkBtn(html, onClick, danger = false, title = "") {
  const b = document.createElement("button"); b.className = `icon-btn${danger ? " danger" : ""}`; b.type = "button"; b.innerHTML = html;
  if (title) b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); }); return b;
}
function render() { renderPlaylists(); renderRecent(); renderSongs(); }

/* ══════════════ USER QUEUE ══════════════ */
function addToUserQueue(song, playNext = false) {
  if (userQueue.some((s) => s.id === song.id)) { showToast("Already in queue"); return; }
  if (playNext) { userQueue.unshift(song); showToast(`"${song.title}" plays next`); }
  else { userQueue.push(song); showToast(`Added to queue`); }
  renderNpQueue();
}

function renderNpQueue() {
  nodes.npQueueList.innerHTML = "";
  const list = getUpcomingList();
  if (!list.length) {
    nodes.npQueueList.innerHTML = `<p style="font-size:0.76rem;color:var(--text-secondary);padding:0.5rem;">No upcoming songs</p>`;
    nodes.queueClear.classList.add("hidden");
    nodes.queueLabel.textContent = "Up Next";
    return;
  }
  if (userQueue.length > 0) {
    nodes.queueClear.classList.remove("hidden");
    nodes.queueLabel.textContent = `Queue (${userQueue.length})`;
  } else {
    nodes.queueClear.classList.add("hidden");
    nodes.queueLabel.textContent = "Up Next";
  }
  list.slice(0, 10).forEach((song, i) => {
    const row = document.createElement("div"); row.className = "queue-song";
    const isUserQueued = i < userQueue.length;
    row.innerHTML = `${artHtml(song, "queue-song-art", "placeholder")}<div class="queue-song-info"><p class="queue-song-title">${song.title}</p><p class="queue-song-artist">${song.artist || "Unknown"}</p></div>`;
    if (isUserQueued) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "queue-song-remove";
      removeBtn.innerHTML = "&#10005;";
      removeBtn.addEventListener("click", (e) => { e.stopPropagation(); userQueue.splice(i, 1); renderNpQueue(); });
      row.append(removeBtn);
    }
    row.addEventListener("click", () => playSong(song));
    nodes.npQueueList.append(row);
  });
}

function getUpcomingList() {
  const natural = getPlaylistUpcoming();
  return [...userQueue, ...natural];
}

function getPlaylistUpcoming() {
  const list = getPlaylist();
  if (!list.length) return [];
  const idx = list.findIndex((s) => s.id === currentSongId);
  if (idx < 0) return list.slice(0, 5);
  const after = list.slice(idx + 1);
  const before = list.slice(0, idx);
  return [...after, ...before].slice(0, 8);
}

nodes.queueClear.addEventListener("click", () => {
  userQueue = [];
  renderNpQueue();
  showToast("Queue cleared");
});

/* ══════════════ PLAYBACK STATE PERSISTENCE ══════════════
   Saves currentSongId + position so the song NEVER disappears
   when iOS suspends the page (e.g. screen locked for a while).
*/
let savePlaybackTimer = null;
function savePlaybackState() {
  if (!currentSongId) return;
  try {
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify({
      songId: currentSongId,
      currentTime: nodes.audio.currentTime || 0,
      timestamp: Date.now(),
    }));
  } catch {}
}
function schedulePlaybackSave() {
  // Throttle to once every 2 seconds during playback
  if (savePlaybackTimer) return;
  savePlaybackTimer = setTimeout(() => {
    savePlaybackState();
    savePlaybackTimer = null;
  }, 2000);
}

async function restorePlaybackState() {
  try {
    const raw = localStorage.getItem(PLAYBACK_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state || !state.songId) return;
    const song = songs.find((s) => s.id === state.songId);
    if (!song) return;
    const blob = await getBlob(song.id);
    if (!blob) return;
    if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch {} }
    currentBlob = blob; // keep in memory for synchronous resume recovery
    currentObjectUrl = URL.createObjectURL(blob);
    nodes.audio.src = currentObjectUrl;
    currentSongId = song.id;
    dbg(`restore: song=${song.id} savedT=${(state.currentTime || 0).toFixed(1)}`);

    // Seek to the saved position once metadata loads
    nodes.audio.addEventListener("loadedmetadata", () => {
      try { nodes.audio.currentTime = state.currentTime || 0; } catch {}
    }, { once: true });

    // Restore mini player UI
    const localArt = getArtUrl(song);
    nodes.miniPlayer.classList.remove("hidden");
    nodes.miniTitle.textContent = song.title;
    nodes.miniArtist.textContent = song.artist || "Unknown";
    if (localArt) { nodes.miniArt.src = localArt; nodes.miniArt.classList.remove("hidden"); nodes.miniArtPlaceholder.classList.add("hidden"); }
    else { nodes.miniArt.classList.add("hidden"); nodes.miniArtPlaceholder.classList.remove("hidden"); }

    // Restore now playing UI
    nodes.npTitle.textContent = song.title;
    nodes.npArtist.textContent = song.artist || "Unknown";
    if (localArt) { nodes.npArtwork.src = localArt; nodes.npArtwork.classList.remove("hidden"); nodes.npArtworkPlaceholder.classList.add("hidden"); }
    else { nodes.npArtwork.classList.add("hidden"); nodes.npArtworkPlaceholder.classList.remove("hidden"); }

    updateMediaSession(song, localArt);
    setPlayingState(false); // Restored paused — user must tap play
    renderSongs();
    loadLyricsForCurrent(song).catch(() => {});
  } catch {}
}

/* ══════════════ PLAYBACK + BACKGROUND AUDIO ══════════════ */
function getPlaylist() {
  const list = sortSongs(filterSongs());
  if (!shuffleOn) return list;
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function playSong(song, startTime = 0) {
  try { stopPreview(); } catch {} // library playback always wins over a preview
  const blob = await getBlob(song.id);
  if (!blob) { showToast("Song file not found"); dbg(`playSong: blob missing for ${song.id}`); return; }
  wasSuspended = false; // a fresh source attach re-primes the audio route
  ensureKeepAlive();    // start the silent session-holder within this user gesture
  // Revoke the PREVIOUS url only — never the one we're about to use.
  if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch {} }
  currentBlob = blob; // keep in memory for synchronous lock-screen resume
  currentObjectUrl = URL.createObjectURL(blob);
  nodes.audio.src = currentObjectUrl;
  nodes.audio.load();
  currentSongId = song.id;
  dbg(`playSong: ${song.id} startT=${startTime}`);

  // Optional resume position (used by recovery paths)
  if (startTime > 0) {
    nodes.audio.addEventListener("loadedmetadata", () => {
      try { nodes.audio.currentTime = startTime; } catch {}
    }, { once: true });
  }

  const localArt = getArtUrl(song);

  // Mini player
  nodes.miniPlayer.classList.remove("hidden");
  nodes.miniTitle.textContent = song.title;
  nodes.miniArtist.textContent = song.artist || "Unknown";
  if (localArt) { nodes.miniArt.src = localArt; nodes.miniArt.classList.remove("hidden"); nodes.miniArtPlaceholder.classList.add("hidden"); }
  else { nodes.miniArt.classList.add("hidden"); nodes.miniArtPlaceholder.classList.remove("hidden"); }

  // Now playing
  nodes.npTitle.textContent = song.title;
  nodes.npArtist.textContent = song.artist || "Unknown";
  if (localArt) { nodes.npArtwork.src = localArt; nodes.npArtwork.classList.remove("hidden"); nodes.npArtworkPlaceholder.classList.add("hidden"); }
  else { nodes.npArtwork.classList.add("hidden"); nodes.npArtworkPlaceholder.classList.remove("hidden"); }

  // Track play
  const ref = songs.find((s) => s.id === song.id);
  if (ref) { ref.lastPlayedAt = Date.now(); ref.playCount = (ref.playCount || 0) + 1; saveMeta(); renderRecent(); renderSongs(); }

  // Media Session — use local art for lock screen too. Wrapped so a
  // MediaMetadata/artwork failure can NEVER prevent playback.
  try { updateMediaSession(song, localArt); } catch (e) { dbg(`updateMediaSession threw: ${e?.message || e}`); }
  renderNpQueue();
  // Lyrics: load from cache (or fetch if panel open + online) — never blocks playback
  loadLyricsForCurrent(song).catch(() => {});

  watchdogRetriedFor = null; // fresh song start gets a fresh auto-heal chance
  resetAudioOutput();
  try { await nodes.audio.play(); setPlayingState(true); dbg(`play ok: ${audioStateStr()}`); }
  catch (e) { dbg(`playSong play() rejected: ${e?.message || e}`); showToast("Tap play to start"); }
}

/* Update the lock-screen metadata, but ONLY rebuild the MediaMetadata object when
   the song actually changes. Re-assigning navigator.mediaSession.metadata on every
   resume/foreground makes iOS redraw the now-playing card — that was the flicker /
   "appears to restart" the user saw. For the same song we only refresh positionState. */
let mediaMetaSongId = null;
function updateMediaSession(song, localArt, force = false) {
  if (!("mediaSession" in navigator)) return;
  registerMediaHandlers(); // idempotent — guarantees handlers exist
  enforceTrackControls();  // every update: keep prev/next, never the ±10s skip buttons
  if (!force && song && song.id === mediaMetaSongId) {
    // Same song already shown — don't touch metadata (no flicker), just position.
    updatePositionState();
    return;
  }
  const artSrc = localArt || song.artwork || "";
  const artwork = [];
  if (artSrc) {
    artwork.push({ src: artSrc, sizes: "96x96", type: "image/jpeg" });
    artwork.push({ src: artSrc, sizes: "256x256", type: "image/jpeg" });
    artwork.push({ src: artSrc, sizes: "512x512", type: "image/jpeg" });
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist || "Unknown",
      album: song.album || "MusiMe",
      artwork,
    });
    mediaMetaSongId = song.id;
  } catch (e) {
    // Some iOS versions choke on blob: artwork URLs — retry with no artwork
    // rather than leaving the session without metadata.
    dbg(`MediaMetadata threw (${e?.message || e}) — retrying without artwork`);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist || "Unknown",
        album: song.album || "MusiMe",
      });
      mediaMetaSongId = song.id;
    } catch {}
  }
  updatePositionState();
}

/* Rebuild the audio source from the IN-MEMORY blob — SYNCHRONOUS, no IndexedDB
   await — so it can run inside a Media Session handler without losing the iOS
   user-activation needed for play(). Returns true if a source was set. */
function rebuildSourceSync() {
  if (!currentBlob) { dbg("rebuildSourceSync: no in-memory blob"); return false; }
  try {
    if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch {} }
    currentObjectUrl = URL.createObjectURL(currentBlob);
    nodes.audio.src = currentObjectUrl;
    nodes.audio.load();
    dbg("rebuildSourceSync: source rebuilt from memory");
    return true;
  } catch (e) {
    dbg(`rebuildSourceSync failed: ${e?.message || e}`);
    return false;
  }
}

function readSavedTime() {
  try {
    const raw = localStorage.getItem(PLAYBACK_KEY);
    if (raw) { const st = JSON.parse(raw); if (st.songId === currentSongId) return st.currentTime || 0; }
  } catch {}
  return 0;
}

/* ── SILENT KEEP-ALIVE (HTML <audio>) ────────────────────────────────────────
   The mechanism that actually makes a lock-screen resume RENDER while the screen
   is still locked. On iOS, once the MAIN element is paused while locked, iOS
   deactivates the app's audio session and a later play() is queued but not
   rendered until unlock. A second, silent <audio> looping forever keeps the iOS
   audio session active across that locked pause, so the main track resumes
   immediately. (A WebAudio oscillator was tried in v9 and did NOT hold the
   session for the HTMLMediaElement — locked rendering broke — so we keep the
   proven <audio> approach.) It is silent (zero-sample WAV) and carries NO media
   metadata, and our positionState publisher only ever reads the MAIN element, so
   it cannot drive the now-playing card. Standalone PWA only. */
let keepAliveEl = null;
function makeSilenceUrl(seconds) {
  const sr = 8000, n = Math.max(1, Math.floor(sr * seconds));
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); ws(36, "data"); dv.setUint32(40, n * 2, true);
  // sample bytes left as zeros == pure silence
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/* ── Lock-screen control hardening ──────────────────────────────────────────
   iOS re-dispatches media actions (we saw two "pause" events ~1s apart) and can
   fire play/pause in quick succession. These guards make the handlers idempotent
   and debounced so repeated/duplicate presses can never desync state or flicker. */
let lastActionType = null;
let lastActionAt = 0;
let resumeInFlight = false;
let renderProbeHandler = null;
const ACTION_DEBOUNCE_MS = 600;
function actionDebounced(type) {
  const now = Date.now();
  if (type === lastActionType && (now - lastActionAt) < ACTION_DEBOUNCE_MS) return true;
  lastActionType = type;
  lastActionAt = now;
  return false;
}

function ensureKeepAlive() {
  if (!IS_STANDALONE) return; // Safari resumes fine without a session-holder
  if (!keepAliveEl) {
    keepAliveEl = document.createElement("audio");
    keepAliveEl.loop = true;
    keepAliveEl.preload = "auto";
    keepAliveEl.setAttribute("playsinline", "");
    keepAliveEl.setAttribute("aria-hidden", "true");
    keepAliveEl.volume = 1; // samples are silent, so this stays inaudible; volume>0
                            // keeps iOS treating it as active playback (don't mute —
                            // a muted element may not hold the audio session open).
    keepAliveEl.style.display = "none";
    keepAliveEl.src = makeSilenceUrl(0.5);
    document.body.appendChild(keepAliveEl);
    dbg("keepAlive created");
  }
  if (keepAliveEl.paused) {
    const p = keepAliveEl.play();
    if (p && p.catch) p.catch((e) => dbg(`keepAlive play rejected: ${e?.message || e}`));
  }
}

/* Reset output properties that can silently get stuck on some devices/webviews
   (muted flag, zero volume, zero playbackRate => "shows playing but no sound").
   Every write is guarded — iOS treats volume as read-only, which is fine. */
function resetAudioOutput() {
  const a = nodes.audio;
  try { if (a.muted) { a.muted = false; dbg("output: unmuted stuck element"); } } catch {}
  try { if (a.volume < 1) { a.volume = 1; dbg("output: restored volume"); } } catch {}
  try { if (!a.playbackRate || a.playbackRate < 0.5) { a.playbackRate = 1; dbg("output: restored playbackRate"); } } catch {}
}

/* PLAYBACK WATCHDOG — the "shows playing but no sound" killer.
   After playback (re)starts, verify currentTime actually advances within ~1.6s.
   If the element claims to be playing but time is frozen, the decode/output
   pipeline is dead (seen on some phones after suspensions): rebuild the source
   from the in-memory blob at the same position and play again — once per song
   start, FOREGROUND ONLY (a load() while locked is deferred by iOS, which is the
   silent-until-unlock trap; the locked path is protected by the keep-alive). */
let watchdogTimer = null;
let watchdogRetriedFor = null;
function armPlaybackWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  const a = nodes.audio;
  const t0 = a.currentTime;
  const songAtArm = currentSongId;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (currentSongId !== songAtArm) return;         // song changed
    if (a.paused || a.ended) return;                  // legitimately not playing
    if (Math.abs(a.currentTime - t0) > 0.05) return;  // rendering fine
    if (document.visibilityState === "hidden") { dbg("watchdog: frozen but hidden — leaving to locked-path handling"); return; }
    if (watchdogRetriedFor === songAtArm) { dbg("watchdog: still frozen after rebuild — giving up on auto-heal"); return; }
    watchdogRetriedFor = songAtArm;
    dbg(`watchdog: playing-but-frozen at t=${t0.toFixed(2)} — rebuilding source (${audioStateStr()})`);
    const saved = a.currentTime || readSavedTime();
    resetAudioOutput();
    if (rebuildSourceSync()) {
      if (saved > 0) a.addEventListener("loadedmetadata", () => { try { a.currentTime = saved; } catch {} }, { once: true });
      const p = a.play();
      if (p && p.catch) p.catch((e) => dbg(`watchdog replay rejected: ${e?.message || e}`));
    }
  }, 1600);
}

/* One-shot probe that logs whether/when the MAIN element's currentTime actually
   advances after a resume, and whether the screen was still locked at that
   instant — this is how we confirm audio truly renders while locked vs. only on
   unlock. Part of the diagnostics; safe to remove with the rest of the logging. */
function armRenderProbe() {
  const a = nodes.audio;
  // Single-instance: clear any previous probe so rapid toggles don't stack listeners.
  if (renderProbeHandler) { a.removeEventListener("timeupdate", renderProbeHandler); renderProbeHandler = null; }
  const t0 = a.currentTime;
  const now = () => ((performance && performance.now) ? performance.now() : Date.now());
  const start = now();
  const onT = () => {
    if (Math.abs(a.currentTime - t0) > 0.05) {
      dbg(`render confirmed: t ${t0.toFixed(2)}->${a.currentTime.toFixed(2)} after ${(now() - start) | 0}ms hidden=${document.visibilityState === "hidden"}`);
      a.removeEventListener("timeupdate", onT);
      if (renderProbeHandler === onT) renderProbeHandler = null;
    }
  };
  renderProbeHandler = onT;
  a.addEventListener("timeupdate", onT);
  setTimeout(() => { a.removeEventListener("timeupdate", onT); if (renderProbeHandler === onT) renderProbeHandler = null; }, 30000);
}

/* The bulletproof resume routine used by the lock-screen "play" action and by
   in-app play. Key iOS rule encoded here: while the screen is LOCKED (document
   hidden), NEVER do a destructive load()/rebuild — iOS defers it until unlock,
   which is the "silent until unlock" bug. When hidden we do the lightest resume
   (plain play()) and rely on the silent keep-alive having held the audio session
   active. Rebuilds happen only in the foreground, where load() can complete. */
async function resumePlayback(forceReprime = false) {
  const a = nodes.audio;
  // Re-entrancy guard: ignore overlapping resume calls (rapid double-tap / a play
  // dispatched while a previous resume is still settling) so they can't race.
  if (resumeInFlight) { dbg("resumePlayback: ignored (already in flight)"); return; }
  // Already playing and advancing — nothing to do; just confirm OS state.
  // Skipped when forceReprime: the on-visible auto-heal has CONFIRMED the element
  // is stuck/silent and explicitly wants a rebuild even though it looks healthy.
  if (!forceReprime && !a.paused && !a.error && a.readyState >= 2) {
    setPlayingState(true);
    return;
  }
  resumeInFlight = true;
  try {
  const hidden = document.visibilityState === "hidden"; // screen locked / app backgrounded
  ensureKeepAlive(); // (re)start the silent session-holder
  const dead = !a.src || a.error !== null || a.readyState === 0; // HAVE_NOTHING
  dbg(`resumePlayback: hidden=${hidden} standalone=${IS_STANDALONE} wasSuspended=${wasSuspended} dead=${dead} ${audioStateStr()}`);

  let savedTime = a.currentTime || 0;
  if (savedTime === 0) savedTime = readSavedTime();

  // Rebuild ONLY when the source is genuinely dead. A healthy foreground/after-unlock
  // resume (src set, rs>=2, no error) must NOT rebuild: the rebuild momentarily resets
  // currentTime to 0, which was the residual position flicker. The silent keep-alive
  // holds the iOS audio session across suspension, so a healthy element resumes with a
  // plain play(). NOTE: the locked path never rebuilds anyway (allowRebuild=false when
  // hidden) — this change only affects foreground, so locked-resume behavior is untouched.
  const allowRebuild = !hidden; // load() while locked is deferred by iOS — avoid it

  if ((dead || forceReprime) && allowRebuild) {
    const rebuilt = rebuildSourceSync(); // synchronous — re-attaches audio route
    if (rebuilt) {
      if (savedTime > 0) {
        a.addEventListener("loadedmetadata", () => { try { a.currentTime = savedTime; } catch {} }, { once: true });
      }
      if (currentSongId) {
        const s = songs.find((x) => x.id === currentSongId);
        if (s) { try { updateMediaSession(s, getArtUrl(s)); } catch {} }
      }
    } else if (currentSongId) {
      const s = songs.find((x) => x.id === currentSongId);
      if (s) { dbg("resumePlayback: async DB reload"); await playSong(s, savedTime); wasSuspended = false; return; }
      dbg("resumePlayback: nothing to resume");
      return;
    }
  }

  armRenderProbe(); // confirm (via the log) whether audio truly renders while locked

  resetAudioOutput();
  // play() is INVOKED synchronously here, so the media-key user-activation holds.
  try {
    await a.play();
    wasSuspended = false;
    setPlayingState(true);
    updatePositionState(true); // assert the MAIN song position immediately so iOS
                               // can't show a derived/wrong position on the card
    dbg(`resume play ok: ${audioStateStr()}`);
  } catch (e) {
    dbg(`resume play() rejected: ${e?.message || e}`);
    // Only attempt the heavy async reload when foreground (load() works there).
    if (!hidden && currentSongId) {
      const s = songs.find((x) => x.id === currentSongId);
      if (s) {
        try { await playSong(s, savedTime); wasSuspended = false; return; }
        catch (e2) { dbg(`fallback failed: ${e2?.message || e2}`); }
      }
    }
    // Could not start audio — keep the UI honest rather than claiming "playing".
    setPlayingState(false);
  }
  } finally {
    resumeInFlight = false;
  }
}

/* Register the Media Session action handlers exactly once. They read live module
   state (currentSongId, currentBlob, nodes.audio) so they never go stale. */
function registerMediaHandlers() {
  if (mediaHandlersRegistered || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };

  set("play", () => {
    // Debounce duplicate play dispatches; ignore if already genuinely playing.
    if (actionDebounced("play")) { dbg("ACTION play (debounced)"); return; }
    dbg("ACTION play");
    if (!nodes.audio.paused && nodes.audio.readyState >= 2 && !nodes.audio.error) {
      // Already playing — just make sure the OS reflects it, no churn.
      setPlayingState(true);
      return;
    }
    resumePlayback();
  });
  set("pause", () => {
    // Debounce iOS's habit of re-dispatching pause ~1s later, and make it
    // idempotent: if the element is already paused, do nothing that causes churn.
    if (actionDebounced("pause")) { dbg("ACTION pause (debounced)"); return; }
    dbg(`ACTION pause: ${audioStateStr()}`);
    ensureKeepAlive(); // keep the audio session warm so the next resume renders
    if (nodes.audio.paused) { setPlayingState(false); return; }
    try { nodes.audio.pause(); } catch {}
    setPlayingState(false);
    savePlaybackState();
  });
  set("seekto", (details) => {
    if (details && details.seekTime != null) {
      try { nodes.audio.currentTime = details.seekTime; } catch {}
      updatePositionState(true); // immediate, bypass throttle (keeps scrubber draggable)
    }
  });
  set("stop", () => { dbg("ACTION stop"); try { nodes.audio.pause(); } catch {} setPlayingState(false); savePlaybackState(); });

  enforceTrackControls(); // previous/next track + explicitly clear seek buttons
  mediaHandlersRegistered = true;
  dbg("media handlers registered");
}

/* Force PREVIOUS/NEXT TRACK on the lock screen and never the ±10s skip buttons.
   iOS draws the skip buttons whenever seekbackward/seekforward handlers exist,
   and once set they linger until EXPLICITLY nulled — simply not registering them
   isn't enough if they were ever set in this session. So we (re)assert prev/next
   AND null the seek handlers here, and call this on every registration and every
   metadata update (incl. visibilitychange/resume) so they can never persist.
   seekto is intentionally left in place — it's the draggable progress bar and
   does NOT create the skip buttons. */
function enforceTrackControls() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set("previoustrack", () => { dbg("ACTION previoustrack"); playNext(-1); });
  set("nexttrack", () => { dbg("ACTION nexttrack"); playNext(1); });
  set("seekbackward", null);
  set("seekforward", null);
}

/* Single source of truth for the lock-screen scrubber. ALWAYS reads the MAIN song
   element (nodes.audio) — never the keep-alive — is throttled, and only publishes
   on a real change, so two callers can't race into the position jitter the user saw.
   `force` (seek) bypasses the throttle. */
let lastPos = { d: -1, p: -1, at: 0 };
let lastPosLogAt = 0;
function updatePositionState(force = false) {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const a = nodes.audio; // MAIN element ONLY
  const d = a.duration;
  // Ignore until the real song duration is known — prevents bogus tiny-duration
  // states (which is exactly how a wrong/short source would show 0:01 / -3:27).
  if (!d || !isFinite(d) || d < 1) return;
  const p = Math.min(Math.max(a.currentTime || 0, 0), d);
  const r = a.playbackRate || 1; // never 0 (setPositionState throws on 0)
  const now = Date.now();
  const changed = Math.abs(p - lastPos.p) > 0.25 || d !== lastPos.d;
  if (!force && !changed && (now - lastPos.at) < 1000) return;
  // Detect a JUMP (the bug signature: position moving backwards or skipping) so
  // the log always captures it, while routine ticks only heartbeat every ~5s.
  const jump = lastPos.p >= 0 && Math.abs(p - lastPos.p) > 1.5;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: p, playbackRate: r });
    if (force || jump || d !== lastPos.d || (now - lastPosLogAt) > 5000) {
      dbg(`setPositionState[main] d=${d.toFixed(1)} p=${p.toFixed(1)} r=${r}${jump ? " JUMP" : ""}`);
      lastPosLogAt = now;
    }
    lastPos = { d, p, at: now };
  } catch (e) {
    dbg(`setPositionState err: ${e?.message || e}`);
  }
}

function setPlayingState(playing) {
  isPlaying = playing;
  nodes.miniPlayIcon.classList.toggle("hidden", playing);
  nodes.miniPauseIcon.classList.toggle("hidden", !playing);
  nodes.npPlayIcon.classList.toggle("hidden", playing);
  nodes.npPauseIcon.classList.toggle("hidden", !playing);
  // Keep the OS lock-screen / notification controls in sync — but only WRITE when
  // the value actually changes. Re-writing the same playbackState makes iOS redraw
  // the now-playing card (flicker), and iOS re-dispatches pause when it sees churn.
  if ("mediaSession" in navigator) {
    const want = playing ? "playing" : "paused";
    if (navigator.mediaSession.playbackState !== want) navigator.mediaSession.playbackState = want;
  }
  updatePositionState();
}

function togglePlayPause() {
  // If we have no source at all but know the current song, recover.
  if (!nodes.audio.src && !currentSongId) return;
  if (nodes.audio.paused) {
    resumePlayback();
  } else {
    nodes.audio.pause();
    setPlayingState(false);
  }
}

function playNext(direction = 1) {
  if (direction === 1 && userQueue.length > 0) {
    const next = userQueue.shift();
    renderNpQueue();
    if (next) { playSong(next); return; }
  }
  const list = getPlaylist();
  if (!list.length) return;
  if (shuffleOn && direction === 1) {
    const others = list.filter((s) => s.id !== currentSongId);
    if (others.length > 0) { playSong(others[Math.floor(Math.random() * others.length)]); return; }
  }
  const idx = list.findIndex((s) => s.id === currentSongId);
  const nextIdx = (idx + direction + list.length) % list.length;
  if (direction === 1 && nextIdx === 0 && repeatMode === "off" && !shuffleOn) { setPlayingState(false); return; }
  const next = list[nextIdx];
  if (next) playSong(next);
}

// Audio events
nodes.audio.addEventListener("play", () => { setPlayingState(true); });
nodes.audio.addEventListener("playing", () => { setPlayingState(true); updatePositionState(true); armPlaybackWatchdog(); });
nodes.audio.addEventListener("pause", () => { setPlayingState(false); savePlaybackState(); });
nodes.audio.addEventListener("ended", () => {
  if (repeatMode === "one") { nodes.audio.currentTime = 0; nodes.audio.play(); return; }
  playNext(1);
});
// If the media element errors (e.g. iOS tore down a backgrounded blob source),
// proactively rebuild from the in-memory blob so the next resume works.
nodes.audio.addEventListener("error", () => {
  const code = nodes.audio.error ? nodes.audio.error.code : "?";
  dbg(`audio error code=${code} — rebuilding source from memory`);
  if (currentBlob) rebuildSourceSync();
});
nodes.audio.addEventListener("stalled", () => dbg(`audio stalled: ${audioStateStr()}`));
nodes.audio.addEventListener("loadeddata", () => dbg(`audio loadeddata: ${audioStateStr()}`));
nodes.audio.addEventListener("timeupdate", () => {
  const { currentTime, duration } = nodes.audio;
  if (!duration) return;
  const pct = (currentTime / duration) * 100;
  nodes.miniProgress.style.width = `${pct}%`;
  nodes.npSeek.value = pct;
  nodes.npCurrent.textContent = formatTime(currentTime);
  nodes.npDuration.textContent = formatTime(duration);
  updatePositionState();
  updateLyricsHighlight();
  schedulePlaybackSave();
});

// Save state when page is hidden/closed (handles iOS suspend & app close).
// Mark wasSuspended so the next resume re-primes the (possibly route-decoupled)
// audio element in standalone mode.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    wasSuspended = true;
    savePlaybackState();
    dbg(`hidden: ${audioStateStr()}`);
  } else {
    dbg(`visible: standalone=${IS_STANDALONE} ${audioStateStr()}`);
    reconcileOnVisible();
  }
});
window.addEventListener("pagehide", () => { wasSuspended = true; savePlaybackState(); });
window.addEventListener("beforeunload", savePlaybackState);

/* On returning to the foreground, re-assert the media session and reconcile the
   UI to what the audio element is ACTUALLY doing. In standalone mode the element
   can come back "playing" but silent (route decoupled) — detect that by checking
   whether playback is really advancing, and if not, re-prime it. */
async function reconcileOnVisible() {
  if (!currentSongId) return;
  const a = nodes.audio;
  const s = songs.find((x) => x.id === currentSongId);
  if (s) { try { updateMediaSession(s, getArtUrl(s)); } catch {} }

  if (isPlaying && IS_STANDALONE) {
    // We think we're playing — verify real audio progress over a short window.
    const t0 = a.currentTime;
    await new Promise((r) => setTimeout(r, 450));
    const advanced = !a.paused && Math.abs(a.currentTime - t0) > 0.01;
    if (!advanced) {
      dbg(`visible: playback stuck/silent (t0=${t0.toFixed(2)} t1=${a.currentTime.toFixed(2)} paused=${a.paused}) — re-priming`);
      resumePlayback(true); // CONFIRMED stuck — force a rebuild even though the
                            // element looks healthy (preserves the v10 safety net)
      return;
    }
  }
  // Otherwise just make the UI match reality.
  setPlayingState(!a.paused);
}
nodes.audio.addEventListener("loadedmetadata", () => {
  if (currentSongId && nodes.audio.duration) {
    const ref = songs.find((s) => s.id === currentSongId);
    if (ref && (!ref.duration || ref.duration === 0)) {
      ref.duration = Math.round(nodes.audio.duration);
      saveMeta();
      renderSongs();
    }
  }
});

// Player controls
nodes.miniPlay.addEventListener("click", (e) => { e.stopPropagation(); togglePlayPause(); });
nodes.miniContent.addEventListener("click", () => { if (currentSongId) { nodes.nowPlaying.classList.remove("hidden"); renderNpQueue(); } });
nodes.npClose.addEventListener("click", () => nodes.nowPlaying.classList.add("hidden"));
nodes.npPlay.addEventListener("click", togglePlayPause);
nodes.npNext.addEventListener("click", () => playNext(1));
nodes.npPrev.addEventListener("click", () => playNext(-1));
nodes.npSeek.addEventListener("input", () => { if (nodes.audio.duration) nodes.audio.currentTime = (nodes.npSeek.value / 100) * nodes.audio.duration; });

/* ══════════════ SHUFFLE ══════════════ */
nodes.npShuffle.addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  nodes.npShuffle.classList.toggle("active", shuffleOn);
  showToast(shuffleOn ? "Shuffle on" : "Shuffle off");
  renderNpQueue();
});

/* ══════════════ REPEAT ══════════════ */
nodes.npRepeat.addEventListener("click", () => {
  if (repeatMode === "off") { repeatMode = "all"; nodes.npRepeat.classList.add("active"); nodes.repeatOneBadge.classList.add("hidden"); showToast("Repeat all"); }
  else if (repeatMode === "all") { repeatMode = "one"; nodes.npRepeat.classList.add("active"); nodes.repeatOneBadge.classList.remove("hidden"); showToast("Repeat one"); }
  else { repeatMode = "off"; nodes.npRepeat.classList.remove("active"); nodes.repeatOneBadge.classList.add("hidden"); showToast("Repeat off"); }
});

/* ══════════════ LYRICS SHORTCUT ══════════════
   Lyrics live in a card below the player (Spotify pattern — discovered by
   scrolling, never forced). The top-bar button is just a shortcut to it. */
nodes.npLyrics.addEventListener("click", () => {
  if (nodes.lyricsCard && !nodes.lyricsCard.classList.contains("hidden")) {
    try { nodes.lyricsCard.scrollIntoView({ behavior: "smooth", block: "start" }); }
    catch { nodes.lyricsCard.scrollIntoView(); }
  } else if (!navigator.onLine) {
    showToast("No lyrics saved — play this song online once to fetch them");
  } else {
    showToast("No lyrics found for this song");
  }
});

/* ══════════════ SLEEP TIMER ══════════════ */
nodes.npSleep.addEventListener("click", () => { nodes.sleepMenu.classList.toggle("hidden"); });
document.querySelectorAll(".sleep-option").forEach((btn) => {
  btn.addEventListener("click", () => { startSleepTimer(parseInt(btn.dataset.minutes, 10)); nodes.sleepMenu.classList.add("hidden"); });
});
nodes.sleepCancel.addEventListener("click", () => { cancelSleepTimer(); });

function startSleepTimer(minutes) {
  cancelSleepTimer();
  sleepEndTime = Date.now() + minutes * 60 * 1000;
  nodes.npSleep.classList.add("active");
  nodes.sleepIndicator.classList.remove("hidden");
  updateSleepDisplay();
  sleepDisplayInterval = setInterval(updateSleepDisplay, 1000);
  sleepTimer = setTimeout(() => { nodes.audio.pause(); setPlayingState(false); showToast("Sleep timer ended"); cancelSleepTimer(); }, minutes * 60 * 1000);
  showToast(`Sleep timer: ${minutes} min`);
}
function cancelSleepTimer() {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  if (sleepDisplayInterval) { clearInterval(sleepDisplayInterval); sleepDisplayInterval = null; }
  sleepEndTime = 0;
  nodes.npSleep.classList.remove("active");
  nodes.sleepIndicator.classList.add("hidden");
}
function updateSleepDisplay() {
  const remaining = Math.max(0, sleepEndTime - Date.now());
  if (remaining <= 0) { cancelSleepTimer(); return; }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  nodes.sleepTimeLeft.textContent = `Sleep in ${mins}:${secs.toString().padStart(2, "0")}`;
}

/* ══════════════ SONG OPS ══════════════ */
function toggleFavorite(id) { const s = songs.find((s) => s.id === id); if (!s) return; s.favorite = !s.favorite; saveMeta(); renderSongs(); }
/* Add-to-playlist bottom sheet. The old flow used window.prompt(), which iOS
   silently ignores in installed (standalone) PWAs — this is why playlists never
   worked on iPhones. Tap rows to toggle membership; create new inline. */
let sheetSongId = null;
function addSongToPlaylist(id) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  sheetSongId = id;
  nodes.sheetSongTitle.textContent = `${s.title} — ${s.artist || "Unknown"}`;
  renderSheetRows();
  nodes.playlistSheet.classList.remove("hidden");
}
function renderSheetRows() {
  const s = songs.find((x) => x.id === sheetSongId);
  if (!s) return;
  nodes.sheetPlaylists.innerHTML = "";
  const avail = playlists.filter((p) => p !== "All songs");
  if (!avail.length) {
    nodes.sheetPlaylists.innerHTML = `<p class="hint" style="padding:0.4rem 0.2rem">No playlists yet — create one below.</p>`;
    return;
  }
  avail.forEach((pl) => {
    const inPl = s.playlists.includes(pl);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `sheet-row${inPl ? " in-playlist" : ""}`;
    const cnt = songs.filter((x) => x.playlists.includes(pl)).length;
    row.innerHTML = `<span>${pl} <span class="hint">(${cnt})</span></span><span class="check">${inPl ? "&#10003;" : "+"}</span>`;
    row.addEventListener("click", () => {
      if (s.playlists.includes(pl)) {
        s.playlists = s.playlists.filter((p) => p !== pl);
        playlistOrders[pl] = (playlistOrders[pl] || []).filter((sid) => sid !== s.id);
        showToast(`Removed from ${pl}`);
      } else {
        s.playlists.push(pl);
        playlistOrders[pl] = [...(playlistOrders[pl] || []), s.id];
        showToast(`Added to ${pl}`);
      }
      saveMeta(); renderSheetRows(); render();
    });
    nodes.sheetPlaylists.append(row);
  });
}
function closePlaylistSheet() {
  nodes.playlistSheet.classList.add("hidden");
  sheetSongId = null;
}
nodes.sheetClose.addEventListener("click", closePlaylistSheet);
nodes.playlistSheet.addEventListener("click", (e) => { if (e.target === nodes.playlistSheet) closePlaylistSheet(); });
nodes.sheetNewForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const n = nodes.sheetNewName.value.replace(/\s+/g, " ").trim();
  if (!n) return;
  if (playlists.some((p) => slugify(p) === slugify(n))) { showToast("Playlist already exists"); return; }
  playlists.push(n); playlistOrders[n] = [];
  const s = songs.find((x) => x.id === sheetSongId);
  if (s && !s.playlists.includes(n)) { s.playlists.push(n); playlistOrders[n].push(s.id); }
  nodes.sheetNewName.value = "";
  saveMeta(); renderSheetRows(); render();
  showToast(`Created "${n}" and added song`);
});
async function removeSong(id) {
  songs = songs.filter((s) => s.id !== id);
  Object.keys(playlistOrders).forEach((pl) => { playlistOrders[pl] = (playlistOrders[pl] || []).filter((sid) => sid !== id); });
  userQueue = userQueue.filter((s) => s.id !== id);
  await deleteBlob(id);
  await deleteArtwork(id);
  await deleteLyrics(id);
  if (artCache.has(id)) { URL.revokeObjectURL(artCache.get(id)); artCache.delete(id); }
  // If we deleted the currently-restored song, clear playback state
  if (currentSongId === id) {
    currentSongId = null;
    try { localStorage.removeItem(PLAYBACK_KEY); } catch {}
  }
  saveMeta(); render(); showToast("Removed");
}
async function addSong({ title, artist, source, blob, album = "", artwork = "", duration = 0, saavnId = "", query = "", srcUrl = "" }) {
  const id = createId();
  await saveBlob(id, blob);
  // saavnId/query/srcUrl are re-download keys (no effect on offline playback) —
  // they let a future sync/restore re-fetch the audio: jiosaavn via saavnId
  // (query as fallback), web songs via the original srcUrl.
  songs.unshift({ id, title, artist, source, favorite: false, playlists: [], createdAt: Date.now(), lastPlayedAt: 0, playCount: 0, album, artwork, duration, saavnId, query, srcUrl });
  saveMeta(); render(); updateStorageInfo();
  return id; // Return id so caller can cache artwork
}
function moveSongInPlaylist(songId, dir) {
  if (selectedPlaylist === "All songs") return;
  const o = playlistOrders[selectedPlaylist] || []; const i = o.indexOf(songId); if (i < 0) return;
  const t = dir === "up" ? i - 1 : i + 1; if (t < 0 || t >= o.length) return;
  [o[i], o[t]] = [o[t], o[i]]; playlistOrders[selectedPlaylist] = o; saveMeta(); renderSongs();
}

/* ══════════════ PLAYLIST OPS ══════════════ */
function createPlaylist(name) {
  const n = name.replace(/\s+/g, " ").trim();
  if (playlists.some((p) => slugify(p) === slugify(n))) { showToast("Already exists"); return; }
  playlists.push(n); playlistOrders[n] = []; selectedPlaylist = n; saveMeta(); render(); showToast("Playlist created");
}
function doRenamePlaylist() {
  if (selectedPlaylist === "All songs") return;
  const n = nodes.renamePlaylist.value.trim(); if (!n) return;
  if (playlists.some((p) => p !== selectedPlaylist && slugify(p) === slugify(n))) { showToast("Name taken"); return; }
  songs.forEach((s) => { s.playlists = s.playlists.map((p) => p === selectedPlaylist ? n : p); });
  playlists = playlists.map((p) => p === selectedPlaylist ? n : p);
  playlistOrders[n] = playlistOrders[selectedPlaylist] || []; delete playlistOrders[selectedPlaylist];
  selectedPlaylist = n; saveMeta(); render(); showToast("Renamed");
}
function deleteSelectedPlaylist() {
  if (selectedPlaylist === "All songs") return;
  const name = selectedPlaylist;
  songs.forEach((s) => { s.playlists = s.playlists.filter((p) => p !== name); });
  playlists = playlists.filter((p) => p !== name); delete playlistOrders[name];
  selectedPlaylist = "All songs"; saveMeta(); render(); showToast("Deleted");
}

/* ══════════════ BACKUP ══════════════ */
async function blobToDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
async function exportBackup() {
  const entries = await getAllBlobEntries();
  const blobs = [];
  for (const e of entries) blobs.push({ id: e.id, dataUrl: await blobToDataUrl(e.blob) });
  // blobs now includes both audio (songId) and artwork (art-songId)
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: "MusiMe", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), songs, playlists, playlistOrders, blobs })], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `musime-backup-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); showToast("Backup exported");
}
async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || payload.app !== "MusiMe" || !Array.isArray(payload.songs)) throw new Error("Invalid");
  await clearBlobs();
  // Clear artwork cache
  artCache.forEach((url) => URL.revokeObjectURL(url));
  artCache.clear();
  for (const e of payload.blobs || []) { if (!e.id || !e.dataUrl) continue; await saveBlob(e.id, await (await fetch(e.dataUrl)).blob()); }
  songs = payload.songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0, saavnId: s.saavnId || "", query: s.query || "", srcUrl: s.srcUrl || "" }));
  playlists = payload.playlists?.includes("All songs") ? payload.playlists : ["All songs", ...(payload.playlists || [])];
  playlistOrders = payload.playlistOrders || {}; normalizePlaylistOrders();
  selectedPlaylist = "All songs"; favoritesOnly = false; searchQuery = ""; sortMode = "newest";
  nodes.searchInput.value = ""; nodes.sortSelect.value = "newest"; saveMeta();
  // Rebuild artwork cache from imported blobs
  await loadAllArtwork();
  render();
}

/* ══════════════ LIBRARY SYNC (metadata-only) ══════════════
   Exports ONLY the library records (songs list, playlists, ordering, favorites,
   recently-played, play counts) — NO audio blobs — so the file stays tiny. On
   import we MERGE the records (never wipe existing audio) and then re-download
   the audio through JioSaavn using each song's saavnId. This is purely additive:
   it never touches the offline playback path. */
const LIBRARY_VERSION = 1;
async function exportLibrary() {
  const payload = {
    app: "MusiMe", kind: "library", version: LIBRARY_VERSION,
    exportedAt: new Date().toISOString(),
    songs, playlists, playlistOrders,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `musime-library-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast(`Library exported (${songs.length} songs)`);
}

/* Merge library records (songs/playlists/orders) into the current state WITHOUT
   wiping anything we already have or touching audio. Returns the count of new
   songs added. Reused by both file import and cloud pull. */
function mergeLibraryRecords(payload) {
  if (!payload || !Array.isArray(payload.songs)) return 0;
  const existingIds = new Set(songs.map((s) => s.id));
  const norm = (s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0, saavnId: s.saavnId || "", query: s.query || "", srcUrl: s.srcUrl || "" });
  const incoming = payload.songs.filter((s) => s && s.id && !existingIds.has(s.id)).map(norm);
  songs = [...incoming, ...songs];
  // Merge playlists (union of names, keep "All songs" first).
  const plSet = new Set(playlists);
  (payload.playlists || []).forEach((p) => { if (p && !plSet.has(p)) { plSet.add(p); playlists.push(p); } });
  if (!playlists.includes("All songs")) playlists.unshift("All songs");
  // Merge playlist orders (fill any the incoming payload has that we don't).
  const po = payload.playlistOrders || {};
  Object.keys(po).forEach((pl) => { if (!playlistOrders[pl]) playlistOrders[pl] = po[pl]; });
  normalizePlaylistOrders();
  saveMeta();
  render();
  return incoming.length;
}

async function importLibrary(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || payload.app !== "MusiMe" || !Array.isArray(payload.songs)) throw new Error("Invalid library file");
  const added = mergeLibraryRecords(payload);
  showToast(`Imported ${added} records — fetching audio…`);
  // Kick off audio re-download for anything we don't have a blob for.
  await restoreMissingAudio();
}

/* Resolve a FRESH JioSaavn download URL from a stored saavnId (the stored URL is
   time-limited, so we re-resolve by id). Tries each mirror. */
async function resolveSaavnUrlById(saavnId) {
  if (!saavnId) return "";
  const ordered = [saavnPreferredMirror, ...SAAVN_MIRRORS.filter((m) => m !== saavnPreferredMirror)];
  for (const mirror of ordered) {
    try {
      const res = await fetch(`${mirror}/songs/${encodeURIComponent(saavnId)}`, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
      if (!res.ok) continue;
      const data = await res.json();
      const item = data?.data ? (Array.isArray(data.data) ? data.data[0] : data.data) : null;
      const dl = item?.downloadUrl || [];
      const best = dl.length ? dl[dl.length - 1] : null;
      if (best?.url) { saavnPreferredMirror = mirror; return best.url; }
    } catch {}
  }
  return "";
}

/* Fallback: re-search JioSaavn by the stored query (or title+artist) and pick the
   matching result's URL. */
async function resolveSaavnUrlBySearch(song) {
  const q = (song.query || `${song.title} ${song.artist || ""}`).trim();
  if (!q) return "";
  try {
    const results = await fetchJioSaavnCandidates(q);
    let m = song.saavnId ? results.find((r) => r.saavnId === song.saavnId) : null;
    if (!m) m = results.find((r) => r.title.toLowerCase() === (song.title || "").toLowerCase() && (r.artist || "").toLowerCase() === (song.artist || "").toLowerCase());
    if (!m) m = results[0];
    return m?.url || "";
  } catch { return ""; }
}

let restoreBusy = false;
async function restoreMissingAudio() {
  if (restoreBusy) { showToast("Already restoring…"); return; }
  restoreBusy = true;
  try {
    // Which songs have no audio blob yet?
    const missing = [];
    for (const s of songs) {
      const blob = await getBlob(s.id);
      if (!blob) missing.push(s);
    }
    if (!missing.length) { dbg("restore: nothing missing"); return; }
    dbg(`restore: ${missing.length} song(s) need audio`);
    let done = 0; const manual = [];
    for (let i = 0; i < missing.length; i++) {
      const s = missing[i];
      showToast(`Restoring ${i + 1}/${missing.length}: ${s.title}`);
      let url = "";
      if (s.source === "jiosaavn") {
        url = await resolveSaavnUrlById(s.saavnId);
        if (!url) url = await resolveSaavnUrlBySearch(s);
      } else if (s.source === "web" && s.srcUrl) {
        url = s.srcUrl; // best effort — the original link may have expired
      }
      // device imports (and anything without a key) can never be re-fetched
      if (!url) { manual.push(s); s.needsReadd = true; saveMeta(); renderSongs(); dbg(`restore: no source for "${s.title}" (${s.source})`); continue; }
      try {
        const blob = await fetchAudioBlob(url, () => {});
        await saveBlob(s.id, blob);
        if (s.artwork) { try { await cacheArtworkFromUrl(s.id, s.artwork); } catch {} }
        ensureLyricsCached(s).catch(() => {}); // lyrics too, while online
        if (s.needsReadd) { delete s.needsReadd; }
        done++; saveMeta(); render();
        dbg(`restore: ok "${s.title}"`);
      } catch (e) {
        manual.push(s); s.needsReadd = true; saveMeta(); renderSongs();
        dbg(`restore: download failed "${s.title}": ${e?.message || e}`);
      }
    }
    if (manual.length) {
      showToast(`Restored ${done}. ${manual.length} need manual re-add.`);
      dbg(`restore: ${manual.length} need manual re-add: ${manual.map((m) => m.title).join(", ")}`);
    } else {
      showToast(`Restored all ${done} song(s)`);
    }
  } finally {
    restoreBusy = false;
  }
}

/* ══════════════ CLOUD SYNC (Firebase Firestore via REST + Google Identity) ══════════════
   Optional, additive, and fully gated on FIREBASE_CONFIG being filled in. The app
   NEVER blocks on sign-in or network: playback and all local features work
   offline whether or not the user is signed in. Sync just runs opportunistically
   when online and signed in.

   No Firebase SDK — we use plain REST to keep the bundle tiny:
   1. Google Identity Services (GSI) returns a Google ID token when the user taps
      "Sign in with Google".
   2. We exchange it for a Firebase ID token via Identity Toolkit REST
      (accounts:signInWithIdp) and remember the refresh token.
   3. We read/write a single per-user Firestore document users/{uid} that holds the
      library metadata JSON as one string field, last-write-wins by updatedAt.
   Security rules (provided in setup) lock users/{uid} to its owner. */
const SYNC = {
  enabled: !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.googleClientId),
  uid: null, email: null, idToken: null, refreshToken: null, tokenExpAt: 0,
  pushTimer: null, suppressPush: false, busy: false, gsiReady: false,
};
function syncLog(m) { dbg(`sync: ${m}`); }

function localUpdatedAt() { return Number(localStorage.getItem(SYNC_LAST_UPDATED_KEY) || 0); }
function setLocalUpdatedAt(ms) { try { localStorage.setItem(SYNC_LAST_UPDATED_KEY, String(ms)); } catch {} }

function loadGsiScript() {
  return new Promise((resolve) => {
    if (window.google?.accounts?.id) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => { syncLog("GSI script failed to load (offline?)"); resolve(false); };
    document.head.appendChild(s);
  });
}

async function initCloudSync() {
  if (!SYNC.enabled) {
    if (nodes.cloudSyncSection) nodes.cloudSyncSection.classList.add("hidden");
    return;
  }
  if (nodes.cloudSyncSection) nodes.cloudSyncSection.classList.remove("hidden");
  setSyncStatus("Not signed in");
  // Restore a previous session silently (refresh token persisted locally).
  SYNC.refreshToken = localStorage.getItem(SYNC_REFRESH_KEY) || null;
  SYNC.uid = localStorage.getItem(SYNC_UID_KEY) || null;
  if (SYNC.refreshToken && SYNC.uid) {
    setSyncStatus("Reconnecting…");
    const ok = await refreshIdToken();
    if (ok) { showSignedIn(); await pullAndMerge(); }
    else setSyncStatus("Sign in to sync");
  }
  // Load Google sign-in button (only meaningful when online).
  if (!navigator.onLine) { setSyncStatus("Offline — sync resumes when online"); }
  const loaded = await loadGsiScript();
  if (!loaded || !window.google?.accounts?.id) return;
  try {
    window.google.accounts.id.initialize({
      client_id: FIREBASE_CONFIG.googleClientId,
      callback: handleGoogleCredential,
      auto_select: false,
    });
    if (nodes.gsiButton && !SYNC.uid) {
      window.google.accounts.id.renderButton(nodes.gsiButton, { theme: "filled_black", size: "large", type: "standard", text: "signin_with" });
    }
    SYNC.gsiReady = true;
  } catch (e) { syncLog(`GSI init error ${e?.message || e}`); }
}

function setSyncStatus(text) { if (nodes.cloudSyncStatus) nodes.cloudSyncStatus.textContent = text; }
function showSignedIn() {
  if (nodes.gsiButton) nodes.gsiButton.classList.add("hidden");
  if (nodes.cloudSyncSignedIn) nodes.cloudSyncSignedIn.classList.remove("hidden");
  if (nodes.cloudSyncEmail) nodes.cloudSyncEmail.textContent = SYNC.email || "Signed in";
  setSyncStatus("Synced to your account");
}
function showSignedOut() {
  if (nodes.cloudSyncSignedIn) nodes.cloudSyncSignedIn.classList.add("hidden");
  if (nodes.gsiButton) {
    nodes.gsiButton.classList.remove("hidden");
    try { if (SYNC.gsiReady && !SYNC.uid) window.google.accounts.id.renderButton(nodes.gsiButton, { theme: "filled_black", size: "large", type: "standard", text: "signin_with" }); } catch {}
  }
  setSyncStatus("Not signed in");
}

// GSI callback: exchange the Google credential for a Firebase session.
async function handleGoogleCredential(resp) {
  try {
    setSyncStatus("Signing in…");
    const ok = await firebaseSignInWithGoogle(resp.credential);
    if (!ok) { setSyncStatus("Sign-in failed"); return; }
    showSignedIn();
    await pullAndMerge();   // pull remote first (may add records + re-download)
    schedulePush();         // then push any local-only additions
  } catch (e) { syncLog(`credential error ${e?.message || e}`); setSyncStatus("Sign-in failed"); }
}

async function firebaseSignInWithGoogle(googleIdToken) {
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${googleIdToken}&providerId=google.com`,
        requestUri: location.origin, returnSecureToken: true,
      }),
    });
    if (!r.ok) { syncLog(`signInWithIdp ${r.status}`); return false; }
    const d = await r.json();
    SYNC.idToken = d.idToken; SYNC.refreshToken = d.refreshToken; SYNC.uid = d.localId;
    SYNC.email = d.email || null;
    SYNC.tokenExpAt = Date.now() + (Number(d.expiresIn || 3600) - 60) * 1000;
    try { localStorage.setItem(SYNC_REFRESH_KEY, SYNC.refreshToken); localStorage.setItem(SYNC_UID_KEY, SYNC.uid); } catch {}
    syncLog(`signed in uid=${SYNC.uid}`);
    return true;
  } catch (e) { syncLog(`signInWithIdp error ${e?.message || e}`); return false; }
}

async function refreshIdToken() {
  if (!SYNC.refreshToken) return false;
  try {
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(SYNC.refreshToken)}`,
    });
    if (!r.ok) { syncLog(`token refresh ${r.status}`); if (r.status === 400) signOutCloud(); return false; }
    const d = await r.json();
    SYNC.idToken = d.id_token; SYNC.refreshToken = d.refresh_token || SYNC.refreshToken; SYNC.uid = d.user_id || SYNC.uid;
    SYNC.tokenExpAt = Date.now() + (Number(d.expires_in || 3600) - 60) * 1000;
    try { localStorage.setItem(SYNC_REFRESH_KEY, SYNC.refreshToken); localStorage.setItem(SYNC_UID_KEY, SYNC.uid); } catch {}
    return true;
  } catch (e) { syncLog(`token refresh error ${e?.message || e}`); return false; }
}

async function ensureToken() {
  if (!SYNC.uid) return false;
  if (SYNC.idToken && Date.now() < SYNC.tokenExpAt) return true;
  return await refreshIdToken();
}

function docUrl() {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${SYNC.uid}`;
}

// Read the remote doc → { payload, updatedAt } or null if none / error.
async function firestoreGet() {
  if (!(await ensureToken())) return null;
  try {
    const r = await fetch(docUrl(), { headers: { Authorization: `Bearer ${SYNC.idToken}` } });
    if (r.status === 404) return { payload: null, updatedAt: 0 };
    if (!r.ok) { syncLog(`firestore get ${r.status}`); return null; }
    const d = await r.json();
    const f = d.fields || {};
    const payloadStr = f.payload?.stringValue || "";
    const updatedAt = Number(f.updatedAt?.integerValue || 0);
    return { payload: payloadStr ? JSON.parse(payloadStr) : null, updatedAt };
  } catch (e) { syncLog(`firestore get error ${e?.message || e}`); return null; }
}

// Write the local library to the remote doc with updatedAt = now.
async function firestorePush() {
  if (!(await ensureToken())) return false;
  const updatedAt = Date.now();
  const payloadStr = JSON.stringify({ app: "MusiMe", kind: "library", version: LIBRARY_VERSION, songs, playlists, playlistOrders });
  const body = { fields: {
    payload: { stringValue: payloadStr },
    updatedAt: { integerValue: String(updatedAt) },
    version: { integerValue: String(LIBRARY_VERSION) },
  } };
  try {
    const r = await fetch(`${docUrl()}?updateMask.fieldPaths=payload&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=version`, {
      method: "PATCH", headers: { Authorization: `Bearer ${SYNC.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { syncLog(`firestore push ${r.status}`); return false; }
    setLocalUpdatedAt(updatedAt);
    syncLog(`pushed ${songs.length} songs`);
    return true;
  } catch (e) { syncLog(`firestore push error ${e?.message || e}`); return false; }
}

// Pull remote; if it's newer, merge its records and re-download any missing audio.
async function pullAndMerge() {
  if (!SYNC.uid || !navigator.onLine) return;
  if (SYNC.busy) return; SYNC.busy = true;
  try {
    setSyncStatus("Syncing…");
    const remote = await firestoreGet();
    if (!remote) { setSyncStatus("Sync error"); return; }
    if (remote.payload && remote.updatedAt >= localUpdatedAt()) {
      SYNC.suppressPush = true;
      const added = mergeLibraryRecords(remote.payload);
      SYNC.suppressPush = false;
      setLocalUpdatedAt(remote.updatedAt);
      syncLog(`pulled (added ${added})`);
      if (added > 0) { setSyncStatus(`Pulled ${added} new — fetching audio…`); restoreMissingAudio(); }
    }
    showSignedIn();
  } finally { SYNC.busy = false; }
}

// Debounced write-back, called from saveMeta() on any local metadata change.
function schedulePush() {
  if (!SYNC.enabled || !SYNC.uid || SYNC.suppressPush) return;
  if (!navigator.onLine) return;
  setLocalUpdatedAt(Date.now());
  if (SYNC.pushTimer) clearTimeout(SYNC.pushTimer);
  SYNC.pushTimer = setTimeout(() => { SYNC.pushTimer = null; firestorePush(); }, 4000);
}

function signOutCloud() {
  SYNC.uid = null; SYNC.email = null; SYNC.idToken = null; SYNC.refreshToken = null; SYNC.tokenExpAt = 0;
  try { localStorage.removeItem(SYNC_REFRESH_KEY); localStorage.removeItem(SYNC_UID_KEY); } catch {}
  try { window.google?.accounts?.id?.disableAutoSelect?.(); } catch {}
  showSignedOut();
  syncLog("signed out");
}

/* ══════════════ EVENT LISTENERS ══════════════ */
nodes.searchForm.addEventListener("submit", async (e) => { e.preventDefault(); try { await searchRemoteSongs(nodes.searchQuery.value); } catch { remoteResults = []; renderRemoteResults(); showToast("Search failed"); } });
nodes.urlForm.addEventListener("submit", async (e) => {
  e.preventDefault(); const url = nodes.songUrl.value.trim(); const title = nodes.songTitle.value.trim(); const artist = nodes.songArtist.value.trim();
  try { showToast("Downloading..."); const res = await fetch(url); if (!res.ok) throw 0; await addSong({ title, artist, source: "web", blob: await res.blob(), srcUrl: url }); nodes.urlForm.reset(); showToast("Saved offline"); } catch { showToast("Could not download"); }
});
nodes.fileInput.addEventListener("change", async (e) => { for (const f of [...(e.target.files || [])]) { if (!f.type.startsWith("audio/")) continue; await addSong({ title: f.name.replace(/\.[^/.]+$/, ""), artist: "", source: "device", blob: f }); } nodes.fileInput.value = ""; showToast("Imported"); });
nodes.playlistForm.addEventListener("submit", (e) => { e.preventDefault(); const n = nodes.playlistForm.querySelector("input").value.trim(); if (!n) return; nodes.playlistForm.reset(); createPlaylist(n); });
nodes.favoritesToggle.addEventListener("click", () => { favoritesOnly = !favoritesOnly; nodes.favoritesToggle.classList.toggle("active-fav", favoritesOnly); nodes.favoritesToggle.querySelector(".fav-icon").innerHTML = favoritesOnly ? "&#9829;" : "&#9825;"; renderSongs(); });
nodes.renamePlaylistBtn.addEventListener("click", doRenamePlaylist);
nodes.deletePlaylistBtn.addEventListener("click", deleteSelectedPlaylist);
if (nodes.clearPlaylistFilter) nodes.clearPlaylistFilter.addEventListener("click", () => { selectedPlaylist = "All songs"; render(); });
nodes.searchInput.addEventListener("input", () => { searchQuery = nodes.searchInput.value.trim(); renderSongs(); });
nodes.sortSelect.addEventListener("change", () => { sortMode = nodes.sortSelect.value; renderSongs(); });
nodes.exportBackup.addEventListener("click", async () => { try { await exportBackup(); } catch { showToast("Export failed"); } });
nodes.importBackupFile.addEventListener("change", async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await importBackup(f); showToast("Imported"); } catch { showToast("Import failed"); } finally { nodes.importBackupFile.value = ""; } });
nodes.exportLibrary.addEventListener("click", async () => { try { await exportLibrary(); } catch { showToast("Export failed"); } });
nodes.importLibraryFile.addEventListener("change", async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await importLibrary(f); } catch { showToast("Import failed"); } finally { nodes.importLibraryFile.value = ""; } });
if (nodes.syncNowBtn) nodes.syncNowBtn.addEventListener("click", async () => { if (!SYNC.uid) { showToast("Sign in first"); return; } showToast("Syncing…"); await pullAndMerge(); await firestorePush(); showToast("Sync complete"); });
if (nodes.signOutBtn) nodes.signOutBtn.addEventListener("click", () => { signOutCloud(); showToast("Signed out"); });
// Resume a debounced push if we come back online while signed in.
window.addEventListener("online", () => { if (SYNC.enabled && SYNC.uid) { syncLog("online — syncing"); pullAndMerge(); } });

/* ══════════════ SERVICE WORKER ══════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      try { reg.update(); } catch {}
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            dbg("new SW installed");
            // Reload ONCE to run fresh code — but never interrupt active playback,
            // and guard against reload loops within a session.
            if (!isPlaying && !sessionStorage.getItem("musime-sw-reloaded")) {
              sessionStorage.setItem("musime-sw-reloaded", "1");
              dbg("reloading for fresh code");
              location.reload();
            }
          }
        });
      });
    }).catch(() => {});
    // Re-check for updates whenever the app returns to the foreground.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        navigator.serviceWorker.getRegistration().then((r) => { if (r) { try { r.update(); } catch {} } }).catch(() => {});
      }
    });
  });
}

/* ══════════════ STORAGE INFO ══════════════ */
async function updateStorageInfo() {
  const t = $("storage-text"), f = $("storage-fill"); if (!t || !f) return;
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate(); const uMB = (e.usage || 0) / 1048576; const qMB = (e.quota || 0) / 1048576;
      const pct = qMB > 0 ? Math.min(100, (uMB / qMB) * 100) : 0;
      f.style.width = `${pct}%`; if (pct > 80) f.classList.add("warn");
      t.textContent = `${uMB.toFixed(1)} MB used of ${qMB > 1024 ? (qMB / 1024).toFixed(1) + " GB" : qMB.toFixed(0) + " MB"} — room for ~${Math.max(0, Math.floor((qMB - uMB) / 8))} more songs`;
    } else { t.textContent = `${songs.length} songs saved offline`; }
  } catch { t.textContent = `${songs.length} songs saved offline`; }
}

/* ══════════════ PWA BANNER ══════════════ */
function checkPwaBanner() {
  const b = $("pwa-install-banner"); if (!b) return;
  if (!(window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true) && !localStorage.getItem("musime-pwa-banner-dismissed")) b.classList.remove("hidden");
}
const dismissBtn = $("dismiss-banner");
if (dismissBtn) dismissBtn.addEventListener("click", () => { $("pwa-install-banner").classList.add("hidden"); localStorage.setItem("musime-pwa-banner-dismissed", "1"); });

/* ══════════════ MIGRATE EXISTING SONGS: cache their artwork ══════════════ */
async function migrateArtwork() {
  // For every song that has a remote artwork URL but no cached art blob,
  // try to download and cache it. Only runs when online.
  if (!navigator.onLine) return;
  let migrated = 0;
  for (const song of songs) {
    if (!song.artwork) continue;  // No artwork to cache
    if (artCache.has(song.id)) continue;  // Already cached
    try {
      await cacheArtworkFromUrl(song.id, song.artwork);
      migrated++;
    } catch {
      // Skip — will retry next time user is online
    }
  }
  if (migrated > 0) {
    render(); // Re-render with local artwork
  }
}

/* ══════════════ REQUEST PERSISTENT STORAGE ══════════════
   Ask the browser to mark our storage as persistent so the OS is far less likely
   to silently evict downloaded songs/artwork under storage pressure. Fully
   feature-detected and idempotent; every outcome is logged to the diagnostics. */
async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) {
      dbg("persist: API unavailable");
      return;
    }
    // Don't re-prompt if already persistent.
    if (navigator.storage.persisted) {
      const already = await navigator.storage.persisted();
      if (already) { dbg("persist: already persistent"); return; }
    }
    const granted = await navigator.storage.persist();
    dbg(`persist: requested -> ${granted ? "GRANTED" : "denied"}`);
  } catch (e) {
    dbg(`persist: error ${e?.message || e}`);
  }
}

/* ══════════════ GLOBAL ERROR SAFETY NET ══════════════
   Never let an unexpected error pass silently — capture it in the diagnostics
   log (visible via Settings → Playback Diagnostics) without disturbing the user. */
window.addEventListener("error", (e) => {
  try { dbg(`UNCAUGHT: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { dbg(`UNHANDLED PROMISE: ${e.reason?.message || e.reason}`); } catch {}
});

/* ══════════════ INIT ══════════════ */
dbg(`=== page load (standalone=${window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true}) ===`);
loadMeta();
render(); // Initial render with remote URLs (may show if online)
// Register lock-screen handlers as early as possible so a media-key press that
// wakes the app is far less likely to be missed while we finish initializing.
registerMediaHandlers();

// Then load local artwork from IndexedDB and re-render with offline-safe URLs
(async function init() {
  await loadAllArtwork();
  render(); // Re-render with cached artwork
  // Restore the last playing song so it never "disappears" after iOS suspends the page
  await restorePlaybackState();
  updateStorageInfo();
  checkPwaBanner();
  requestPersistence();
  // Migrate artwork for existing songs that were downloaded before this update
  migrateArtwork();
  // Cache lyrics for existing songs in the background (online only, gentle pace)
  migrateLyrics();
  // Optional cloud sync — inert unless FIREBASE_CONFIG is filled in. Never blocks
  // offline use; runs after everything local is ready.
  initCloudSync();
})();

/* ══════════════ DIAGNOSTICS UI (removable) ══════════════ */
(function wireDebugUi() {
  const showBtn = $("show-debug-log");
  const clearBtn = $("clear-debug-log");
  const out = $("debug-log-output");
  if (!showBtn || !out) return;
  showBtn.addEventListener("click", () => {
    out.textContent = debugBuffer.length ? debugBuffer.join("\n") : "(log is empty)";
    out.classList.toggle("hidden");
  });
  if (clearBtn) clearBtn.addEventListener("click", () => { window.__musimeClearLog(); out.textContent = "(cleared)"; });
})();
