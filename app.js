const DB_NAME = "musime-db";
const STORE_NAME = "songs";
const SONGS_KEY = "musime-songs-meta";
const PLAYLISTS_KEY = "musime-playlists";
const PLAYLIST_ORDERS_KEY = "musime-playlist-orders";
const BACKUP_VERSION = 2;
const SAAVN_API = "https://jiosavan-api2.vercel.app/api";

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

/* ── NEW: Playback queue, shuffle, repeat, sleep ── */
let userQueue = [];          // User-added "play next" / "add to queue" songs
let shuffleOn = false;
let repeatMode = "off";      // "off" | "all" | "one"
let sleepTimer = null;
let sleepEndTime = 0;
let sleepDisplayInterval = null;

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

/* ══════════════ ARCHIVE API ══════════════ */
function audioFileScore(file) {
  const fmt = String(file.format || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (!(name.endsWith(".mp3") || name.endsWith(".m4a") || name.endsWith(".ogg") || name.endsWith(".opus")))
    if (!fmt.includes("mp3") && !fmt.includes("ogg") && !fmt.includes("aac") && !fmt.includes("mpeg")) return -1;
  let s = 0;
  if (name.endsWith(".mp3") || fmt.includes("vbr mp3") || fmt.includes("128kbps")) s += 6;
  if (name.endsWith(".m4a") || fmt.includes("aac")) s += 4;
  if (fmt.includes("ogg") || name.endsWith(".ogg")) s += 3;
  if (Number(file.size || 0) > 0 && Number(file.size) < 50e6) s += 2;
  return s;
}
async function fetchArchiveCandidates(query) {
  const q = `(title:(${query}) OR subject:(${query})) AND mediatype:(audio)`;
  const res = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=8&page=1&output=json`);
  if (!res.ok) throw new Error("Archive search failed");
  const docs = (await res.json())?.response?.docs || [];
  const results = await Promise.all(docs.map(async (doc) => {
    try {
      const md = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`)).json();
      const scored = (md.files || []).map((f) => ({ f, s: audioFileScore(f) })).filter((e) => e.s >= 0).sort((a, b) => b.s - a.s);
      if (!scored.length) return null;
      const best = scored[0].f;
      const safePath = (best.name || "").split("/").map((s) => encodeURIComponent(s)).join("/");
      return { id: `archive-${doc.identifier}-${best.name}`, title: doc.title || "Untitled", artist: doc.creator || "", album: md?.metadata?.collection || "", artwork: md?.metadata?.identifier ? `https://archive.org/services/img/${encodeURIComponent(md.metadata.identifier)}` : "", source: "archive", isPreview: false, url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${safePath}`, duration: 0 };
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

/* ══════════════ ITUNES API ══════════════ */
async function fetchITunesCandidates(query) {
  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10`);
  if (!res.ok) throw new Error("iTunes failed");
  return ((await res.json()).results || []).filter((i) => i.previewUrl).map((i) => ({
    id: `itunes-${i.trackId}`, title: i.trackName || "Untitled", artist: i.artistName || "",
    album: i.collectionName || "", artwork: (i.artworkUrl100 || "").replace("100x100", "300x300"),
    source: "itunes", isPreview: true, url: i.previewUrl, duration: Math.round((i.trackTimeMillis || 0) / 1000),
  }));
}

/* ══════════════ SEARCH ══════════════ */
async function searchRemoteSongs(query) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) { remoteResults = []; renderRemoteResults(); return; }
  showToast("Searching...");
  const settled = await Promise.allSettled([
    fetchJioSaavnCandidates(q).catch(() => []),
    fetchArchiveCandidates(q).catch(() => []),
    fetchITunesCandidates(q).catch(() => []),
  ]);
  remoteResults = settled.filter((e) => e.status === "fulfilled").flatMap((e) => e.value);
  const seen = new Set();
  remoteResults = remoteResults.filter((i) => { const k = `${i.title.toLowerCase()}|${(i.artist || "").toLowerCase()}|${i.source}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const w = { jiosaavn: 30, archive: 15, itunes: 5 };
  remoteResults.sort((a, b) => (w[b.source] || 0) - (w[a.source] || 0));
  remoteResults = remoteResults.slice(0, 30);
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
        await addSong({ title: next.result.title, artist: next.result.artist, source: next.result.source, blob, album: next.result.album || "", artwork: next.result.artwork || "", duration: next.result.duration || 0 });
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

/* ══════════════ RENDER SEARCH RESULTS (with duration) ══════════════ */
function renderRemoteResults() {
  nodes.searchResults.innerHTML = "";
  if (!remoteResults.length) {
    nodes.searchResults.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9835;</div><p>No results found</p><p class="hint">Try a different search term</p></div>`;
    return;
  }
  remoteResults.forEach((result) => {
    const row = document.createElement("article"); row.className = "result-item";
    const artEl = result.artwork ? `<img class="art" src="${result.artwork}" alt="" loading="lazy">` : `<div class="art placeholder"><span>&#9835;</span></div>`;
    const src = result.source === "jiosaavn" ? "JioSaavn" : result.source === "archive" ? "Archive" : "iTunes";
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

/* ══════════════ RECENTLY PLAYED (enhanced with artwork) ══════════════ */
function renderRecent() {
  const recent = [...songs].filter((s) => s.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 10);
  nodes.recentlyPlayed.innerHTML = "";
  if (!recent.length) { nodes.recentSection.classList.add("hidden"); return; }
  nodes.recentSection.classList.remove("hidden");
  recent.forEach((s) => {
    const card = document.createElement("div");
    card.className = "recent-card";
    const artEl = s.artwork
      ? `<img class="recent-card-art" src="${s.artwork}" alt="" loading="lazy">`
      : `<div class="recent-card-art placeholder"><span>&#9835;</span></div>`;
    card.innerHTML = `${artEl}<span class="recent-card-title">${s.title}</span><span class="recent-card-artist">${s.artist || "Unknown"}</span>`;
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

/* ══════════════ RENDER SONGS (with duration + play-next + now-playing highlight) ══════════════ */
function renderSongs() {
  const filtered = sortSongs(filterSongs());
  nodes.songs.innerHTML = "";
  if (!filtered.length) { nodes.songs.innerHTML = `<div class="empty-state"><div class="empty-icon">&#127925;</div><p>No songs yet</p><p class="hint">Search and download songs from Discover</p></div>`; return; }
  filtered.forEach((song) => {
    const item = document.createElement("article");
    item.className = "song" + (song.id === currentSongId ? " now-playing-song" : "");
    const artEl = song.artwork ? `<img class="song-art" src="${song.artwork}" alt="" loading="lazy">` : `<div class="song-art placeholder"><span>&#9835;</span></div>`;
    const durText = song.duration > 0 ? formatTime(song.duration) : "";
    const durEl = durText ? `<span class="song-duration">${durText}</span>` : "";
    const playCountText = song.playCount > 0 ? ` &middot; ${song.playCount} play${song.playCount !== 1 ? "s" : ""}` : "";
    item.innerHTML = `${artEl}<div class="song-main"><p class="song-title">${song.title}</p><p class="song-meta">${song.artist || "Unknown"} &middot; ${song.source}${playCountText}</p>${durEl}</div><div class="actions"></div>`;
    const actions = item.querySelector(".actions");
    actions.append(mkBtn("&#9654;", () => playSong(song)));
    // Play Next button
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

/* ══════════════ USER QUEUE (Play Next / Add to Queue) ══════════════ */
function addToUserQueue(song, playNext = false) {
  // Avoid duplicates
  if (userQueue.some((s) => s.id === song.id)) {
    showToast("Already in queue");
    return;
  }
  if (playNext) {
    userQueue.unshift(song);
    showToast(`"${song.title}" plays next`);
  } else {
    userQueue.push(song);
    showToast(`Added to queue`);
  }
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
    const artEl = song.artwork
      ? `<img class="queue-song-art" src="${song.artwork}" alt="" loading="lazy">`
      : `<div class="queue-song-art placeholder"><span>&#9835;</span></div>`;
    const isUserQueued = i < userQueue.length;
    row.innerHTML = `${artEl}<div class="queue-song-info"><p class="queue-song-title">${song.title}</p><p class="queue-song-artist">${song.artist || "Unknown"}</p></div>`;
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
  // User queue first, then natural playlist order
  const natural = getPlaylistUpcoming();
  return [...userQueue, ...natural];
}

function getPlaylistUpcoming() {
  const list = getPlaylist();
  if (!list.length) return [];
  const idx = list.findIndex((s) => s.id === currentSongId);
  if (idx < 0) return list.slice(0, 5);
  // Songs after current
  const after = list.slice(idx + 1);
  const before = list.slice(0, idx);
  return [...after, ...before].slice(0, 8);
}

nodes.queueClear.addEventListener("click", () => {
  userQueue = [];
  renderNpQueue();
  showToast("Queue cleared");
});

/* ══════════════ PLAYBACK + BACKGROUND AUDIO ══════════════ */
function getPlaylist() {
  const list = sortSongs(filterSongs());
  if (!shuffleOn) return list;
  // Fisher-Yates shuffle, but keep current song at its position
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

  // Mini player
  nodes.miniPlayer.classList.remove("hidden");
  nodes.miniTitle.textContent = song.title;
  nodes.miniArtist.textContent = song.artist || "Unknown";
  if (song.artwork) { nodes.miniArt.src = song.artwork; nodes.miniArt.classList.remove("hidden"); nodes.miniArtPlaceholder.classList.add("hidden"); }
  else { nodes.miniArt.classList.add("hidden"); nodes.miniArtPlaceholder.classList.remove("hidden"); }

  // Now playing
  nodes.npTitle.textContent = song.title;
  nodes.npArtist.textContent = song.artist || "Unknown";
  if (song.artwork) { nodes.npArtwork.src = song.artwork; nodes.npArtwork.classList.remove("hidden"); nodes.npArtworkPlaceholder.classList.add("hidden"); }
  else { nodes.npArtwork.classList.add("hidden"); nodes.npArtworkPlaceholder.classList.remove("hidden"); }

  // Track play
  const ref = songs.find((s) => s.id === song.id);
  if (ref) { ref.lastPlayedAt = Date.now(); ref.playCount = (ref.playCount || 0) + 1; saveMeta(); renderRecent(); renderSongs(); }

  // Media Session
  updateMediaSession(song);
  // Update queue display
  renderNpQueue();

  try { await nodes.audio.play(); setPlayingState(true); }
  catch { showToast("Tap play to start"); }
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  const artwork = [];
  if (song.artwork) {
    artwork.push({ src: song.artwork, sizes: "96x96", type: "image/jpeg" });
    artwork.push({ src: song.artwork, sizes: "256x256", type: "image/jpeg" });
    artwork.push({ src: song.artwork, sizes: "512x512", type: "image/jpeg" });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist || "Unknown",
    album: song.album || "MusiMe",
    artwork,
  });
  navigator.mediaSession.setActionHandler("play", () => { nodes.audio.play(); setPlayingState(true); });
  navigator.mediaSession.setActionHandler("pause", () => { nodes.audio.pause(); setPlayingState(false); });
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
  // If user queue has songs and going forward, play from queue
  if (direction === 1 && userQueue.length > 0) {
    const next = userQueue.shift();
    renderNpQueue();
    if (next) { playSong(next); return; }
  }

  const list = getPlaylist();
  if (!list.length) return;

  if (shuffleOn && direction === 1) {
    // Pick a random song that isn't the current one
    const others = list.filter((s) => s.id !== currentSongId);
    if (others.length > 0) {
      const pick = others[Math.floor(Math.random() * others.length)];
      playSong(pick);
      return;
    }
  }

  const idx = list.findIndex((s) => s.id === currentSongId);
  const nextIdx = (idx + direction + list.length) % list.length;

  // If we've gone past the end and repeat is off, stop
  if (direction === 1 && nextIdx === 0 && repeatMode === "off" && !shuffleOn) {
    setPlayingState(false);
    return;
  }

  const next = list[nextIdx];
  if (next) playSong(next);
}

// Audio events
nodes.audio.addEventListener("play", () => setPlayingState(true));
nodes.audio.addEventListener("pause", () => setPlayingState(false));
nodes.audio.addEventListener("ended", () => {
  if (repeatMode === "one") {
    // Replay the same song
    nodes.audio.currentTime = 0;
    nodes.audio.play();
    return;
  }
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
});

// Save duration when audio loads metadata
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
  if (repeatMode === "off") {
    repeatMode = "all";
    nodes.npRepeat.classList.add("active");
    nodes.repeatOneBadge.classList.add("hidden");
    showToast("Repeat all");
  } else if (repeatMode === "all") {
    repeatMode = "one";
    nodes.npRepeat.classList.add("active");
    nodes.repeatOneBadge.classList.remove("hidden");
    showToast("Repeat one");
  } else {
    repeatMode = "off";
    nodes.npRepeat.classList.remove("active");
    nodes.repeatOneBadge.classList.add("hidden");
    showToast("Repeat off");
  }
});

/* ══════════════ SLEEP TIMER ══════════════ */
nodes.npSleep.addEventListener("click", () => {
  nodes.sleepMenu.classList.toggle("hidden");
});

document.querySelectorAll(".sleep-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    const minutes = parseInt(btn.dataset.minutes, 10);
    startSleepTimer(minutes);
    nodes.sleepMenu.classList.add("hidden");
  });
});

nodes.sleepCancel.addEventListener("click", () => {
  cancelSleepTimer();
});

function startSleepTimer(minutes) {
  cancelSleepTimer(); // Clear any existing
  sleepEndTime = Date.now() + minutes * 60 * 1000;
  nodes.npSleep.classList.add("active");
  nodes.sleepIndicator.classList.remove("hidden");
  updateSleepDisplay();
  sleepDisplayInterval = setInterval(updateSleepDisplay, 1000);
  sleepTimer = setTimeout(() => {
    nodes.audio.pause();
    setPlayingState(false);
    showToast("Sleep timer ended");
    cancelSleepTimer();
  }, minutes * 60 * 1000);
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
  // Remove from user queue too
  userQueue = userQueue.filter((s) => s.id !== id);
  await deleteBlob(id); saveMeta(); render(); showToast("Removed");
}
async function addSong({ title, artist, source, blob, album = "", artwork = "", duration = 0 }) {
  const id = createId();
  await saveBlob(id, blob);
  songs.unshift({ id, title, artist, source, favorite: false, playlists: [], createdAt: Date.now(), lastPlayedAt: 0, playCount: 0, album, artwork, duration });
  saveMeta(); render(); updateStorageInfo();
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
  const entries = await getAllBlobEntries(); const blobs = [];
  for (const e of entries) blobs.push({ id: e.id, dataUrl: await blobToDataUrl(e.blob) });
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: "MusiMe", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), songs, playlists, playlistOrders, blobs })], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `musime-backup-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); showToast("Backup exported");
}
async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || payload.app !== "MusiMe" || !Array.isArray(payload.songs)) throw new Error("Invalid");
  await clearBlobs();
  for (const e of payload.blobs || []) { if (!e.id || !e.dataUrl) continue; await saveBlob(e.id, await (await fetch(e.dataUrl)).blob()); }
  songs = payload.songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "", duration: s.duration || 0 }));
  playlists = payload.playlists?.includes("All songs") ? payload.playlists : ["All songs", ...(payload.playlists || [])];
  playlistOrders = payload.playlistOrders || {}; normalizePlaylistOrders();
  selectedPlaylist = "All songs"; favoritesOnly = false; searchQuery = ""; sortMode = "newest";
  nodes.searchInput.value = ""; nodes.sortSelect.value = "newest"; saveMeta(); render();
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

/* ══════════════ INIT ══════════════ */
loadMeta();
render();
updateStorageInfo();
checkPwaBanner();
