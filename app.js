const DB_NAME = "musime-db";
const STORE_NAME = "songs";
const SONGS_KEY = "musime-songs-meta";
const PLAYLISTS_KEY = "musime-playlists";
const PLAYLIST_ORDERS_KEY = "musime-playlist-orders";
const PLAYBACK_KEY = "musime-playback-state";
const BACKUP_VERSION = 3;
const SAAVN_API = "https://jiosavan-api2.vercel.app/api";
// Audius API: returns a list of working hosts (no auth needed)
const AUDIUS_DISCOVERY = "https://api.audius.co";
let audiusHost = null; // resolved on first search

let songs = [];
let playlists = [];
let playlistOrders = {};
let selectedPlaylist = "All songs";
let favoritesOnly = false;
let searchQuery = "";
let sortMode = "newest";
let currentObjectUrl = null;
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
  recentSection: $("recently-played-section"),
  recentlyPlayed: $("recently-played"),
  exportBackup: $("export-backup"),
  importBackupFile: $("import-backup-file"),
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
  setTimeout(() => {
    splash.classList.add("fade-out");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    setTimeout(() => { if (splash.parentNode) splash.remove(); }, 600);
  }, 1400);
})();

/* ══════════════ TAB NAV ══════════════ */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    const view = $(tab.dataset.view);
    if (view) {
      view.classList.add("active");
      view.scrollTop = 0;
    }
  });
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

/* ══════════════ METADATA ══════════════ */
function saveMeta() {
  localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
  localStorage.setItem(PLAYLIST_ORDERS_KEY, JSON.stringify(playlistOrders));
}
function loadMeta() {
  songs = JSON.parse(localStorage.getItem(SONGS_KEY) || "[]");
  playlists = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || "[]");
  playlistOrders = JSON.parse(localStorage.getItem(PLAYLIST_ORDERS_KEY) || "{}");
  if (!playlists.includes("All songs")) playlists.unshift("All songs");
  songs = songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0 }));
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

/* ══════════════ JIOSAAVN API ══════════════ */
async function fetchJioSaavnCandidates(query) {
  const res = await fetch(`${SAAVN_API}/search/songs?query=${encodeURIComponent(query)}&limit=20`);
  if (!res.ok) throw new Error("JioSaavn search failed");
  const data = await res.json();
  return (data?.data?.results || []).map((item) => {
    const dl = item.downloadUrl || [];
    const best = dl.length > 0 ? dl[dl.length - 1] : null;
    const art = (item.image || []).find((i) => i.quality === "500x500") || (item.image || [])[0];
    return {
      id: `saavn-${item.id}`, title: decodeHtml(item.name || "Untitled"),
      artist: decodeHtml((item.artists?.primary || []).map((a) => a.name).join(", ") || ""),
      album: decodeHtml(item.album?.name || ""), artwork: art?.url || "",
      source: "jiosaavn", isPreview: false, url: best?.url || "",
      qualityHint: best?.quality || "", duration: item.duration || 0,
    };
  }).filter((i) => i.url);
}

/* ══════════════ AUDIUS API ══════════════
   Decentralized music platform. Has independent global artists
   including African, gospel, and indie content. Free, no auth.
*/
async function getAudiusHost() {
  if (audiusHost) return audiusHost;
  try {
    const res = await fetch(AUDIUS_DISCOVERY);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const hosts = data?.data || [];
    if (hosts.length === 0) throw new Error();
    audiusHost = hosts[Math.floor(Math.random() * hosts.length)];
    return audiusHost;
  } catch {
    // Fallback to a known stable host
    audiusHost = "https://discoveryprovider.audius.co";
    return audiusHost;
  }
}

async function fetchAudiusCandidates(query) {
  const host = await getAudiusHost();
  const res = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=MusiMe`);
  if (!res.ok) throw new Error("Audius search failed");
  const data = await res.json();
  return (data?.data || []).slice(0, 15).map((track) => {
    const artUrl = track.artwork?.["480x480"] || track.artwork?.["1000x1000"] || track.artwork?.["150x150"] || "";
    return {
      id: `audius-${track.id}`,
      title: track.title || "Untitled",
      artist: track.user?.name || track.user?.handle || "",
      album: "",
      artwork: artUrl,
      source: "audius",
      isPreview: false,
      url: `${host}/v1/tracks/${track.id}/stream?app_name=MusiMe`,
      duration: track.duration || 0,
    };
  });
}

/* ══════════════ SEARCH ══════════════ */
async function searchRemoteSongs(query) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) { remoteResults = []; renderRemoteResults(); return; }
  showToast("Searching...");
  const settled = await Promise.allSettled([
    fetchJioSaavnCandidates(q).catch(() => []),
    fetchAudiusCandidates(q).catch(() => []),
  ]);
  remoteResults = settled.filter((e) => e.status === "fulfilled").flatMap((e) => e.value);
  const seen = new Set();
  remoteResults = remoteResults.filter((i) => { const k = `${i.title.toLowerCase()}|${(i.artist || "").toLowerCase()}|${i.source}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const w = { jiosaavn: 30, audius: 20 };
  remoteResults.sort((a, b) => (w[b.source] || 0) - (w[a.source] || 0));
  remoteResults = remoteResults.slice(0, 40);
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
        const blob = await fetchAudioBlob(next.result.url, (p) => { next.progress = p; renderQueue(); });
        const songId = await addSong({ title: next.result.title, artist: next.result.artist, source: next.result.source, blob, album: next.result.album || "", artwork: next.result.artwork || "", duration: next.result.duration || 0 });
        // Cache artwork locally for offline use
        if (next.result.artwork && songId) {
          await cacheArtworkFromUrl(songId, next.result.artwork);
          render(); // Re-render with local artwork
        }
        next.state = "done"; next.progress = 100;
        showToast(next.result.isPreview ? "Preview saved" : "Song saved offline");
      } catch { next.state = "failed"; showToast("Download failed"); }
      renderQueue();
      await new Promise((r) => setTimeout(r, 400));
      downloadQueue = downloadQueue.filter((j) => j.id !== next.id);
      renderQueue();
    }
  } finally { queueBusy = false; }
}
async function fetchAudioBlob(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const ct = res.headers.get("content-type") || "";
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
  return new Blob(chunks, { type: ct || "audio/mpeg" });
}

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
    const src = result.source === "jiosaavn" ? "JioSaavn" : result.source === "audius" ? "Audius" : result.source;
    const bc = result.isPreview ? "preview" : "full";
    const bl = result.isPreview ? "Preview" : "Full";
    const durLabel = result.duration > 0 ? `<span class="duration-label">${formatTime(result.duration)}</span>` : "";
    row.innerHTML = `${artEl}<div class="result-info"><p class="title">${result.title}</p><p class="meta">${result.artist || "Unknown"} &middot; ${result.album || src}</p><div class="badge-row"><span class="badge ${bc}">${bl} &middot; ${src}</span>${durLabel}</div></div><div class="result-actions"></div>`;
    const btn = document.createElement("button"); btn.className = "add-btn"; btn.innerHTML = "+";
    btn.addEventListener("click", (e) => { e.stopPropagation(); enqueueDownload(result); });
    row.querySelector(".result-actions").append(btn);
    nodes.searchResults.append(row);
  });
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

function renderPlaylists() {
  nodes.playlists.innerHTML = "";
  playlists.forEach((pl) => {
    const card = document.createElement("button"); card.type = "button";
    card.className = `playlist-card${pl === selectedPlaylist ? " active" : ""}`;
    const cnt = pl === "All songs" ? songs.length : songs.filter((s) => s.playlists.includes(pl)).length;
    card.innerHTML = `<p class="name">${pl}</p><p class="count">${cnt} song${cnt !== 1 ? "s" : ""}</p>`;
    card.addEventListener("click", () => { selectedPlaylist = pl; render(); });
    nodes.playlists.append(card);
  });
  if (selectedPlaylist !== "All songs") { nodes.playlistAdmin.classList.remove("hidden"); nodes.playlistActiveLabel.textContent = `Managing: ${selectedPlaylist}`; nodes.renamePlaylist.value = selectedPlaylist; }
  else { nodes.playlistAdmin.classList.add("hidden"); nodes.renamePlaylist.value = ""; }
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
    item.innerHTML = `${artHtml(song, "song-art", "placeholder")}<div class="song-main"><p class="song-title">${song.title}</p><p class="song-meta">${song.artist || "Unknown"} &middot; ${song.source}${playCountText}</p>${durEl}</div><div class="actions"></div>`;
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
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(blob);
    nodes.audio.src = currentObjectUrl;
    currentSongId = song.id;

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

async function playSong(song) {
  const blob = await getBlob(song.id);
  if (!blob) { showToast("Song file not found"); return; }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  nodes.audio.src = currentObjectUrl;
  currentSongId = song.id;

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

  // Media Session — use local art for lock screen too
  updateMediaSession(song, localArt);
  renderNpQueue();

  try { await nodes.audio.play(); setPlayingState(true); }
  catch { showToast("Tap play to start"); }
}

function updateMediaSession(song, localArt) {
  if (!("mediaSession" in navigator)) return;
  const artSrc = localArt || song.artwork || "";
  const artwork = [];
  if (artSrc) {
    artwork.push({ src: artSrc, sizes: "96x96", type: "image/jpeg" });
    artwork.push({ src: artSrc, sizes: "256x256", type: "image/jpeg" });
    artwork.push({ src: artSrc, sizes: "512x512", type: "image/jpeg" });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist || "Unknown",
    album: song.album || "MusiMe",
    artwork,
  });
  // Bulletproof play handler: if the audio element lost its src
  // (iOS Safari sometimes does this when the page is suspended),
  // reload the song from IndexedDB before playing.
  navigator.mediaSession.setActionHandler("play", async () => {
    try {
      if (!nodes.audio.src && currentSongId) {
        const s = songs.find((x) => x.id === currentSongId);
        if (s) { await playSong(s); return; }
      }
      await nodes.audio.play();
      setPlayingState(true);
    } catch {
      // Last-resort recovery: reload from current song id
      if (currentSongId) {
        const s = songs.find((x) => x.id === currentSongId);
        if (s) { try { await playSong(s); } catch {} }
      }
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    try { nodes.audio.pause(); } catch {}
    setPlayingState(false);
    savePlaybackState();
  });
  navigator.mediaSession.setActionHandler("previoustrack", () => playNext(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => playNext(1));
  try {
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) nodes.audio.currentTime = details.seekTime;
    });
  } catch {}
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !nodes.audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: nodes.audio.duration,
      playbackRate: nodes.audio.playbackRate,
      position: nodes.audio.currentTime,
    });
  } catch {}
}

function setPlayingState(playing) {
  isPlaying = playing;
  nodes.miniPlayIcon.classList.toggle("hidden", playing);
  nodes.miniPauseIcon.classList.toggle("hidden", !playing);
  nodes.npPlayIcon.classList.toggle("hidden", playing);
  nodes.npPauseIcon.classList.toggle("hidden", !playing);
}

function togglePlayPause() {
  if (!nodes.audio.src) return;
  if (nodes.audio.paused) { nodes.audio.play(); setPlayingState(true); }
  else { nodes.audio.pause(); setPlayingState(false); }
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
nodes.audio.addEventListener("play", () => setPlayingState(true));
nodes.audio.addEventListener("pause", () => { setPlayingState(false); savePlaybackState(); });
nodes.audio.addEventListener("ended", () => {
  if (repeatMode === "one") { nodes.audio.currentTime = 0; nodes.audio.play(); return; }
  playNext(1);
});
nodes.audio.addEventListener("timeupdate", () => {
  const { currentTime, duration } = nodes.audio;
  if (!duration) return;
  const pct = (currentTime / duration) * 100;
  nodes.miniProgress.style.width = `${pct}%`;
  nodes.npSeek.value = pct;
  nodes.npCurrent.textContent = formatTime(currentTime);
  nodes.npDuration.textContent = formatTime(duration);
  updatePositionState();
  schedulePlaybackSave();
});

// Save state when page is hidden/closed (handles iOS suspend & app close)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePlaybackState();
});
window.addEventListener("pagehide", savePlaybackState);
window.addEventListener("beforeunload", savePlaybackState);
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
function addSongToPlaylist(id) {
  const avail = playlists.filter((p) => p !== "All songs");
  if (!avail.length) { showToast("Create a playlist first"); return; }
  const pick = prompt(`Add to:\n${avail.join("\n")}`);
  if (!pick || !avail.includes(pick)) { showToast("Playlist not found"); return; }
  const s = songs.find((s) => s.id === id); if (!s) return;
  if (!s.playlists.includes(pick)) { s.playlists.push(pick); playlistOrders[pick] = [...(playlistOrders[pick] || []), s.id]; }
  saveMeta(); renderSongs(); showToast(`Added to ${pick}`);
}
async function removeSong(id) {
  songs = songs.filter((s) => s.id !== id);
  Object.keys(playlistOrders).forEach((pl) => { playlistOrders[pl] = (playlistOrders[pl] || []).filter((sid) => sid !== id); });
  userQueue = userQueue.filter((s) => s.id !== id);
  await deleteBlob(id);
  await deleteArtwork(id);
  if (artCache.has(id)) { URL.revokeObjectURL(artCache.get(id)); artCache.delete(id); }
  // If we deleted the currently-restored song, clear playback state
  if (currentSongId === id) {
    currentSongId = null;
    try { localStorage.removeItem(PLAYBACK_KEY); } catch {}
  }
  saveMeta(); render(); showToast("Removed");
}
async function addSong({ title, artist, source, blob, album = "", artwork = "", duration = 0 }) {
  const id = createId();
  await saveBlob(id, blob);
  songs.unshift({ id, title, artist, source, favorite: false, playlists: [], createdAt: Date.now(), lastPlayedAt: 0, playCount: 0, album, artwork, duration });
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
  songs = payload.songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0 }));
  playlists = payload.playlists?.includes("All songs") ? payload.playlists : ["All songs", ...(payload.playlists || [])];
  playlistOrders = payload.playlistOrders || {}; normalizePlaylistOrders();
  selectedPlaylist = "All songs"; favoritesOnly = false; searchQuery = ""; sortMode = "newest";
  nodes.searchInput.value = ""; nodes.sortSelect.value = "newest"; saveMeta();
  // Rebuild artwork cache from imported blobs
  await loadAllArtwork();
  render();
}

/* ══════════════ EVENT LISTENERS ══════════════ */
nodes.searchForm.addEventListener("submit", async (e) => { e.preventDefault(); try { await searchRemoteSongs(nodes.searchQuery.value); } catch { remoteResults = []; renderRemoteResults(); showToast("Search failed"); } });
nodes.urlForm.addEventListener("submit", async (e) => {
  e.preventDefault(); const url = nodes.songUrl.value.trim(); const title = nodes.songTitle.value.trim(); const artist = nodes.songArtist.value.trim();
  try { showToast("Downloading..."); const res = await fetch(url); if (!res.ok) throw 0; await addSong({ title, artist, source: "web", blob: await res.blob() }); nodes.urlForm.reset(); showToast("Saved offline"); } catch { showToast("Could not download"); }
});
nodes.fileInput.addEventListener("change", async (e) => { for (const f of [...(e.target.files || [])]) { if (!f.type.startsWith("audio/")) continue; await addSong({ title: f.name.replace(/\.[^/.]+$/, ""), artist: "", source: "device", blob: f }); } nodes.fileInput.value = ""; showToast("Imported"); });
nodes.playlistForm.addEventListener("submit", (e) => { e.preventDefault(); const n = nodes.playlistForm.querySelector("input").value.trim(); if (!n) return; nodes.playlistForm.reset(); createPlaylist(n); });
nodes.favoritesToggle.addEventListener("click", () => { favoritesOnly = !favoritesOnly; nodes.favoritesToggle.classList.toggle("active-fav", favoritesOnly); nodes.favoritesToggle.querySelector(".fav-icon").innerHTML = favoritesOnly ? "&#9829;" : "&#9825;"; renderSongs(); });
nodes.renamePlaylistBtn.addEventListener("click", doRenamePlaylist);
nodes.deletePlaylistBtn.addEventListener("click", deleteSelectedPlaylist);
nodes.searchInput.addEventListener("input", () => { searchQuery = nodes.searchInput.value.trim(); renderSongs(); });
nodes.sortSelect.addEventListener("change", () => { sortMode = nodes.sortSelect.value; renderSongs(); });
nodes.exportBackup.addEventListener("click", async () => { try { await exportBackup(); } catch { showToast("Export failed"); } });
nodes.importBackupFile.addEventListener("change", async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await importBackup(f); showToast("Imported"); } catch { showToast("Import failed"); } finally { nodes.importBackupFile.value = ""; } });

/* ══════════════ SERVICE WORKER ══════════════ */
if ("serviceWorker" in navigator) { window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); }); }

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

/* ══════════════ REQUEST PERSISTENT STORAGE ══════════════ */
async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    if (granted) {
      console.log("Persistent storage granted — songs will never be evicted");
    }
  }
}

/* ══════════════ INIT ══════════════ */
loadMeta();
render(); // Initial render with remote URLs (may show if online)

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
})();
