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

/* ── DOM refs ── */
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
};

/* ── Tab Navigation ── */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.view).classList.add("active");
  });
});

/* ── Install ── */
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

/* ── IndexedDB ── */
async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBlob(id, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getBlob(id) {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const r = tx.objectStore(STORE_NAME).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return result;
}

async function getAllBlobEntries() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const keysReq = store.getAllKeys();
    const valuesReq = store.getAll();
    tx.oncomplete = () => {
      resolve((keysReq.result || []).map((id, i) => ({ id, blob: (valuesReq.result || [])[i] })));
    };
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return result;
}

async function deleteBlob(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function clearBlobs() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/* ── Metadata ── */
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
  songs = songs.map((s) => ({
    ...s,
    playlists: Array.isArray(s.playlists) ? s.playlists : [],
    createdAt: s.createdAt || Date.now(),
    lastPlayedAt: s.lastPlayedAt || 0,
    playCount: s.playCount || 0,
    album: s.album || "",
    artwork: s.artwork || "",
  }));
  normalizePlaylistOrders();
}

/* ── Helpers ── */
function showToast(text) {
  nodes.toast.textContent = text;
  nodes.toast.classList.add("show");
  setTimeout(() => nodes.toast.classList.remove("show"), 1800);
}

function slugify(t) {
  return t.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function decodeHtml(html) {
  const el = document.createElement("textarea");
  el.innerHTML = html;
  return el.value;
}

/* ── JioSaavn API ── */
async function fetchJioSaavnCandidates(query) {
  const url = `${SAAVN_API}/search/songs?query=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("JioSaavn search failed");
  const data = await res.json();
  const results = data?.data?.results || [];

  return results.map((item) => {
    const downloads = item.downloadUrl || [];
    const best = downloads.length > 0 ? downloads[downloads.length - 1] : null;
    const artwork = (item.image || []).find((img) => img.quality === "500x500")
      || (item.image || []).find((img) => img.quality === "150x150")
      || (item.image || [])[0];

    return {
      id: `saavn-${item.id}`,
      title: decodeHtml(item.name || "Untitled"),
      artist: decodeHtml((item.artists?.primary || []).map((a) => a.name).join(", ") || item.primaryArtists || ""),
      album: decodeHtml(item.album?.name || ""),
      artwork: artwork?.url || "",
      source: "jiosaavn",
      isPreview: false,
      url: best?.url || "",
      qualityHint: best?.quality || "",
      duration: item.duration || 0,
    };
  }).filter((item) => item.url);
}

/* ── Internet Archive API ── */
function audioFileScore(file) {
  const format = String(file.format || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (!(name.endsWith(".mp3") || name.endsWith(".m4a") || name.endsWith(".ogg") || name.endsWith(".opus"))) {
    if (!format.includes("mp3") && !format.includes("ogg") && !format.includes("aac") && !format.includes("mpeg")) return -1;
  }
  let score = 0;
  if (name.endsWith(".mp3") || format.includes("vbr mp3") || format.includes("128kbps")) score += 6;
  if (name.endsWith(".m4a") || format.includes("aac")) score += 4;
  if (format.includes("ogg") || name.endsWith(".ogg")) score += 3;
  const size = Number(file.size || 0);
  if (size > 0 && size < 50 * 1024 * 1024) score += 2;
  return score;
}

async function fetchArchiveCandidates(query) {
  const q = `(title:(${query}) OR subject:(${query})) AND mediatype:(audio)`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=8&page=1&output=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Archive search failed");
  const data = await res.json();
  const docs = data?.response?.docs || [];

  const results = await Promise.all(
    docs.map(async (doc) => {
      try {
        const mdRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
        if (!mdRes.ok) return null;
        const md = await mdRes.json();
        const files = Array.isArray(md.files) ? md.files : [];
        const scored = files.map((f) => ({ f, s: audioFileScore(f) })).filter((e) => e.s >= 0).sort((a, b) => b.s - a.s);
        if (!scored.length) return null;
        const best = scored[0].f;
        const safePath = (best.name || "").split("/").map((s) => encodeURIComponent(s)).join("/");
        return {
          id: `archive-${doc.identifier}-${best.name}`,
          title: doc.title || "Untitled",
          artist: doc.creator || "",
          album: md?.metadata?.collection || "",
          artwork: md?.metadata?.identifier ? `https://archive.org/services/img/${encodeURIComponent(md.metadata.identifier)}` : "",
          source: "archive",
          isPreview: false,
          url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${safePath}`,
          qualityHint: best.format || "",
        };
      } catch { return null; }
    })
  );
  return results.filter(Boolean);
}

/* ── iTunes previews ── */
async function fetchITunesCandidates(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("iTunes search failed");
  const data = await res.json();
  return (data.results || []).filter((i) => i.previewUrl).map((i) => ({
    id: `itunes-${i.trackId || i.previewUrl}`,
    title: i.trackName || "Untitled",
    artist: i.artistName || "",
    album: i.collectionName || "",
    artwork: (i.artworkUrl100 || "").replace("100x100", "300x300"),
    source: "itunes",
    isPreview: true,
    url: i.previewUrl,
    qualityHint: "preview",
  }));
}

/* ── Search Orchestrator ── */
async function searchRemoteSongs(query) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) { remoteResults = []; renderRemoteResults(); return; }

  showToast("Searching...");
  const tasks = [
    fetchJioSaavnCandidates(q).catch(() => []),
    fetchArchiveCandidates(q).catch(() => []),
    fetchITunesCandidates(q).catch(() => []),
  ];
  const settled = await Promise.allSettled(tasks);
  remoteResults = settled
    .filter((e) => e.status === "fulfilled")
    .flatMap((e) => e.value)
    .slice(0, 30);

  const seen = new Set();
  remoteResults = remoteResults.filter((item) => {
    const key = `${item.title.toLowerCase()}|${(item.artist || "").toLowerCase()}|${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Prioritize JioSaavn (full songs) > Archive > iTunes (previews)
  const sourceWeight = { jiosaavn: 30, archive: 15, itunes: 5 };
  remoteResults.sort((a, b) => (sourceWeight[b.source] || 0) - (sourceWeight[a.source] || 0));
  renderRemoteResults();
}

/* ── Download Queue ── */
function renderQueue() {
  nodes.downloadQueue.innerHTML = "";
  if (!downloadQueue.length) { nodes.downloadQueue.classList.add("hidden"); return; }
  nodes.downloadQueue.classList.remove("hidden");
  downloadQueue.forEach((job) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    item.innerHTML = `
      <div class="queue-head">
        <span class="queue-track">${job.title}</span>
        <span class="queue-state">${job.state}${job.progress ? ` ${job.progress}%` : ""}</span>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${job.progress || 0}%"></div></div>
    `;
    nodes.downloadQueue.append(item);
  });
}

function enqueueDownload(result) {
  if (downloadQueue.some((j) => j.id === result.id && ["queued", "downloading"].includes(j.state))) {
    showToast("Already in queue");
    return;
  }
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
      next.state = "downloading";
      next.progress = 10;
      renderQueue();
      try {
        const blob = await fetchAudioBlob(next.result.url, (p) => { next.progress = p; renderQueue(); });
        await addSong({
          title: next.result.title,
          artist: next.result.artist,
          source: next.result.source,
          blob,
          album: next.result.album || "",
          artwork: next.result.artwork || "",
        });
        next.state = "done";
        next.progress = 100;
        showToast(next.result.isPreview ? "Preview saved" : "Song saved offline");
      } catch {
        next.state = "failed";
        showToast("Download failed");
      }
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
  if (!reader) {
    const blob = await res.blob();
    onProgress(100);
    return blob;
  }
  const total = Number(res.headers.get("content-length") || 0);
  let loaded = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(total > 0 ? Math.max(10, Math.min(98, Math.round((loaded / total) * 100))) : Math.min(98, 10 + chunks.length * 3));
  }
  onProgress(100);
  return new Blob(chunks, { type: ct || "audio/mpeg" });
}

/* ── Render Search Results ── */
function renderRemoteResults() {
  nodes.searchResults.innerHTML = "";
  if (!remoteResults.length) {
    nodes.searchResults.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#9835;</div>
        <p>No results found</p>
        <p class="hint">Try a different search term</p>
      </div>`;
    return;
  }

  remoteResults.forEach((result) => {
    const row = document.createElement("article");
    row.className = "result-item";

    const artEl = result.artwork
      ? `<img class="art" src="${result.artwork}" alt="" loading="lazy">`
      : `<div class="art placeholder"><span>&#9835;</span></div>`;

    const sourceLabel = result.source === "jiosaavn" ? "JioSaavn" : result.source === "archive" ? "Archive" : "iTunes";
    const badgeClass = result.isPreview ? "preview" : "full";
    const badgeLabel = result.isPreview ? "Preview" : "Full";

    row.innerHTML = `
      ${artEl}
      <div class="result-info">
        <p class="title">${result.title}</p>
        <p class="meta">${result.artist || "Unknown"} &middot; ${result.album || sourceLabel}</p>
        <span class="badge ${badgeClass}">${badgeLabel} &middot; ${sourceLabel}</span>
      </div>
      <div class="result-actions"></div>
    `;

    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.innerHTML = "+";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      enqueueDownload(result);
    });
    row.querySelector(".result-actions").append(addBtn);

    nodes.searchResults.append(row);
  });
}

/* ── Library Rendering ── */
function filterSongs() {
  return songs.filter((s) => {
    const inPlaylist = selectedPlaylist === "All songs" || s.playlists.includes(selectedPlaylist);
    const favOk = !favoritesOnly || s.favorite;
    const q = searchQuery.toLowerCase();
    const match = !q || s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q);
    return inPlaylist && favOk && match;
  });
}

function sortSongs(list) {
  const c = [...list];
  if (sortMode === "title") c.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortMode === "artist") c.sort((a, b) => (a.artist || "").localeCompare(b.artist || ""));
  else if (sortMode === "recent") c.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
  else if (sortMode === "playlist" && selectedPlaylist !== "All songs") {
    const order = playlistOrders[selectedPlaylist] || [];
    c.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else c.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return c;
}

function normalizePlaylistOrders() {
  const ids = new Set(songs.map((s) => s.id));
  playlists.forEach((pl) => {
    if (pl === "All songs") return;
    const inPl = songs.filter((s) => s.playlists.includes(pl)).map((s) => s.id);
    const existing = (playlistOrders[pl] || []).filter((id, i, a) => a.indexOf(id) === i && ids.has(id));
    inPl.forEach((id) => { if (!existing.includes(id)) existing.push(id); });
    playlistOrders[pl] = existing;
  });
  Object.keys(playlistOrders).forEach((pl) => { if (!playlists.includes(pl)) delete playlistOrders[pl]; });
}

function renderRecent() {
  const recent = [...songs].filter((s) => s.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 5);
  nodes.recentlyPlayed.innerHTML = "";
  if (!recent.length) { nodes.recentlyPlayed.classList.add("hidden"); return; }
  nodes.recentlyPlayed.classList.remove("hidden");
  recent.forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-pill";
    btn.textContent = s.title;
    btn.addEventListener("click", () => playSong(s));
    nodes.recentlyPlayed.append(btn);
  });
}

function renderPlaylists() {
  nodes.playlists.innerHTML = "";
  playlists.forEach((pl) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `playlist-card${pl === selectedPlaylist ? " active" : ""}`;
    const count = pl === "All songs" ? songs.length : songs.filter((s) => s.playlists.includes(pl)).length;
    card.innerHTML = `<p class="name">${pl}</p><p class="count">${count} song${count !== 1 ? "s" : ""}</p>`;
    card.addEventListener("click", () => { selectedPlaylist = pl; render(); });
    nodes.playlists.append(card);
  });

  if (selectedPlaylist !== "All songs") {
    nodes.playlistAdmin.classList.remove("hidden");
    nodes.playlistActiveLabel.textContent = `Managing: ${selectedPlaylist}`;
    nodes.renamePlaylist.value = selectedPlaylist;
  } else {
    nodes.playlistAdmin.classList.add("hidden");
    nodes.renamePlaylist.value = "";
  }
}

function renderSongs() {
  const filtered = sortSongs(filterSongs());
  nodes.songs.innerHTML = "";

  if (!filtered.length) {
    nodes.songs.innerHTML = `<div class="empty-state"><div class="empty-icon">&#127925;</div><p>No songs yet</p><p class="hint">Search and download songs from Discover</p></div>`;
    return;
  }

  filtered.forEach((song) => {
    const item = document.createElement("article");
    item.className = "song";

    const artEl = song.artwork
      ? `<img class="song-art" src="${song.artwork}" alt="" loading="lazy">`
      : `<div class="song-art placeholder"><span>&#9835;</span></div>`;

    item.innerHTML = `
      ${artEl}
      <div class="song-main">
        <p class="song-title">${song.title}</p>
        <p class="song-meta">${song.artist || "Unknown"} &middot; ${song.source}</p>
      </div>
      <div class="actions"></div>
    `;

    const actions = item.querySelector(".actions");

    const playBtn = mkBtn("&#9654;", () => playSong(song));
    const favBtn = mkBtn(song.favorite ? "&#9829;" : "&#9825;", () => toggleFavorite(song.id));
    if (song.favorite) favBtn.classList.add("fav-active");
    const plBtn = mkBtn("+", () => addSongToPlaylist(song.id));
    const delBtn = mkBtn("&#10005;", () => removeSong(song.id), true);
    actions.append(playBtn, favBtn, plBtn, delBtn);

    if (sortMode === "playlist" && selectedPlaylist !== "All songs") {
      const reorder = document.createElement("div");
      reorder.className = "reorder";
      const up = document.createElement("button");
      up.className = "move-btn";
      up.textContent = "\u2191";
      up.addEventListener("click", () => moveSongInPlaylist(song.id, "up"));
      const down = document.createElement("button");
      down.className = "move-btn";
      down.textContent = "\u2193";
      down.addEventListener("click", () => moveSongInPlaylist(song.id, "down"));
      reorder.append(up, down);
      actions.append(reorder);
    }

    nodes.songs.append(item);
  });
}

function mkBtn(html, onClick, danger = false) {
  const btn = document.createElement("button");
  btn.className = `icon-btn${danger ? " danger" : ""}`;
  btn.type = "button";
  btn.innerHTML = html;
  btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function render() {
  renderPlaylists();
  renderRecent();
  renderSongs();
}

/* ── Playback ── */
function getPlaylist() {
  return sortSongs(filterSongs());
}

async function playSong(song) {
  const blob = await getBlob(song.id);
  if (!blob) { showToast("Song file not found"); return; }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  nodes.audio.src = currentObjectUrl;
  currentSongId = song.id;

  // Update mini player
  nodes.miniPlayer.classList.remove("hidden");
  nodes.miniTitle.textContent = song.title;
  nodes.miniArtist.textContent = song.artist || "Unknown";
  if (song.artwork) {
    nodes.miniArt.src = song.artwork;
    nodes.miniArt.classList.remove("hidden");
    nodes.miniArtPlaceholder.classList.add("hidden");
  } else {
    nodes.miniArt.classList.add("hidden");
    nodes.miniArtPlaceholder.classList.remove("hidden");
  }

  // Update now playing
  nodes.npTitle.textContent = song.title;
  nodes.npArtist.textContent = song.artist || "Unknown";
  if (song.artwork) {
    nodes.npArtwork.src = song.artwork;
    nodes.npArtwork.classList.remove("hidden");
    nodes.npArtworkPlaceholder.classList.add("hidden");
  } else {
    nodes.npArtwork.classList.add("hidden");
    nodes.npArtworkPlaceholder.classList.remove("hidden");
  }

  const ref = songs.find((s) => s.id === song.id);
  if (ref) {
    ref.lastPlayedAt = Date.now();
    ref.playCount = (ref.playCount || 0) + 1;
    saveMeta();
    renderRecent();
  }

  try {
    await nodes.audio.play();
    setPlayingState(true);
  } catch {
    showToast("Tap play to start");
  }
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
  if (nodes.audio.paused) {
    nodes.audio.play();
    setPlayingState(true);
  } else {
    nodes.audio.pause();
    setPlayingState(false);
  }
}

function playNext(direction = 1) {
  const list = getPlaylist();
  if (!list.length) return;
  const idx = list.findIndex((s) => s.id === currentSongId);
  const next = list[(idx + direction + list.length) % list.length];
  if (next) playSong(next);
}

// Audio events
nodes.audio.addEventListener("play", () => setPlayingState(true));
nodes.audio.addEventListener("pause", () => setPlayingState(false));
nodes.audio.addEventListener("ended", () => playNext(1));
nodes.audio.addEventListener("timeupdate", () => {
  const { currentTime, duration } = nodes.audio;
  if (!duration) return;
  const pct = (currentTime / duration) * 100;
  nodes.miniProgress.style.width = `${pct}%`;
  nodes.npSeek.value = pct;
  nodes.npCurrent.textContent = formatTime(currentTime);
  nodes.npDuration.textContent = formatTime(duration);
});

// Player controls
nodes.miniPlay.addEventListener("click", (e) => { e.stopPropagation(); togglePlayPause(); });
nodes.miniContent.addEventListener("click", () => { if (currentSongId) nodes.nowPlaying.classList.remove("hidden"); });
nodes.npClose.addEventListener("click", () => nodes.nowPlaying.classList.add("hidden"));
nodes.npPlay.addEventListener("click", togglePlayPause);
nodes.npNext.addEventListener("click", () => playNext(1));
nodes.npPrev.addEventListener("click", () => playNext(-1));
nodes.npSeek.addEventListener("input", () => {
  if (nodes.audio.duration) nodes.audio.currentTime = (nodes.npSeek.value / 100) * nodes.audio.duration;
});

/* ── Song Operations ── */
function toggleFavorite(id) {
  const s = songs.find((s) => s.id === id);
  if (!s) return;
  s.favorite = !s.favorite;
  saveMeta();
  renderSongs();
}

function addSongToPlaylist(id) {
  const available = playlists.filter((p) => p !== "All songs");
  if (!available.length) { showToast("Create a playlist first"); return; }
  const pick = prompt(`Add to:\n${available.join("\n")}`);
  if (!pick || !available.includes(pick)) { showToast("Playlist not found"); return; }
  const s = songs.find((s) => s.id === id);
  if (!s) return;
  if (!s.playlists.includes(pick)) {
    s.playlists.push(pick);
    playlistOrders[pick] = [...(playlistOrders[pick] || []), s.id];
  }
  saveMeta();
  renderSongs();
  showToast(`Added to ${pick}`);
}

async function removeSong(id) {
  songs = songs.filter((s) => s.id !== id);
  Object.keys(playlistOrders).forEach((pl) => {
    playlistOrders[pl] = (playlistOrders[pl] || []).filter((sid) => sid !== id);
  });
  await deleteBlob(id);
  saveMeta();
  render();
  showToast("Removed");
}

async function addSong({ title, artist, source, blob, album = "", artwork = "" }) {
  const id = createId();
  await saveBlob(id, blob);
  songs.unshift({ id, title, artist, source, favorite: false, playlists: [], createdAt: Date.now(), lastPlayedAt: 0, playCount: 0, album, artwork });
  saveMeta();
  render();
  updateStorageInfo();
}

function moveSongInPlaylist(songId, direction) {
  if (selectedPlaylist === "All songs") return;
  const order = playlistOrders[selectedPlaylist] || [];
  const idx = order.indexOf(songId);
  if (idx < 0) return;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= order.length) return;
  [order[idx], order[target]] = [order[target], order[idx]];
  playlistOrders[selectedPlaylist] = order;
  saveMeta();
  renderSongs();
}

/* ── Playlist Operations ── */
function createPlaylist(name) {
  const realName = name.replace(/\s+/g, " ").trim();
  if (playlists.some((p) => slugify(p) === slugify(realName))) { showToast("Already exists"); return; }
  playlists.push(realName);
  playlistOrders[realName] = [];
  selectedPlaylist = realName;
  saveMeta();
  render();
  showToast("Playlist created");
}

function doRenamePlaylist() {
  if (selectedPlaylist === "All songs") return;
  const newName = nodes.renamePlaylist.value.trim();
  if (!newName) return;
  if (playlists.some((p) => p !== selectedPlaylist && slugify(p) === slugify(newName))) { showToast("Name taken"); return; }
  songs.forEach((s) => { s.playlists = s.playlists.map((p) => p === selectedPlaylist ? newName : p); });
  playlists = playlists.map((p) => p === selectedPlaylist ? newName : p);
  playlistOrders[newName] = playlistOrders[selectedPlaylist] || [];
  delete playlistOrders[selectedPlaylist];
  selectedPlaylist = newName;
  saveMeta();
  render();
  showToast("Renamed");
}

function deleteSelectedPlaylist() {
  if (selectedPlaylist === "All songs") return;
  const name = selectedPlaylist;
  songs.forEach((s) => { s.playlists = s.playlists.filter((p) => p !== name); });
  playlists = playlists.filter((p) => p !== name);
  delete playlistOrders[name];
  selectedPlaylist = "All songs";
  saveMeta();
  render();
  showToast("Deleted");
}

/* ── Backup ── */
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function exportBackup() {
  const entries = await getAllBlobEntries();
  const blobs = [];
  for (const e of entries) blobs.push({ id: e.id, dataUrl: await blobToDataUrl(e.blob) });
  const payload = { app: "MusiMe", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), songs, playlists, playlistOrders, blobs };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `musime-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Backup exported");
}

async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || payload.app !== "MusiMe" || !Array.isArray(payload.songs)) throw new Error("Invalid");
  await clearBlobs();
  for (const e of payload.blobs || []) {
    if (!e.id || !e.dataUrl) continue;
    await saveBlob(e.id, await (await fetch(e.dataUrl)).blob());
  }
  songs = payload.songs.map((s) => ({ ...s, playlists: Array.isArray(s.playlists) ? s.playlists : [], createdAt: s.createdAt || Date.now(), lastPlayedAt: s.lastPlayedAt || 0, playCount: s.playCount || 0, album: s.album || "", artwork: s.artwork || "" }));
  playlists = payload.playlists?.includes("All songs") ? payload.playlists : ["All songs", ...(payload.playlists || [])];
  playlistOrders = payload.playlistOrders || {};
  normalizePlaylistOrders();
  selectedPlaylist = "All songs";
  favoritesOnly = false;
  searchQuery = "";
  sortMode = "newest";
  nodes.searchInput.value = "";
  nodes.sortSelect.value = "newest";
  saveMeta();
  render();
}

/* ── Event Listeners ── */
nodes.searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await searchRemoteSongs(nodes.searchQuery.value); }
  catch { remoteResults = []; renderRemoteResults(); showToast("Search failed"); }
});

nodes.urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = nodes.songUrl.value.trim();
  const title = nodes.songTitle.value.trim();
  const artist = nodes.songArtist.value.trim();
  try {
    showToast("Downloading...");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed");
    const blob = await res.blob();
    await addSong({ title, artist, source: "web", blob });
    nodes.urlForm.reset();
    showToast("Saved offline");
  } catch { showToast("Could not download"); }
});

nodes.fileInput.addEventListener("change", async (e) => {
  for (const file of [...(e.target.files || [])]) {
    if (!file.type.startsWith("audio/")) continue;
    await addSong({ title: file.name.replace(/\.[^/.]+$/, ""), artist: "", source: "device", blob: file });
  }
  nodes.fileInput.value = "";
  showToast("Imported");
});

nodes.playlistForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nodes.playlistForm.querySelector("input").value.trim();
  if (!name) return;
  nodes.playlistForm.reset();
  createPlaylist(name);
});

nodes.favoritesToggle.addEventListener("click", () => {
  favoritesOnly = !favoritesOnly;
  nodes.favoritesToggle.classList.toggle("active-fav", favoritesOnly);
  nodes.favoritesToggle.querySelector(".fav-icon").innerHTML = favoritesOnly ? "&#9829;" : "&#9825;";
  renderSongs();
});

nodes.renamePlaylistBtn.addEventListener("click", doRenamePlaylist);
nodes.deletePlaylistBtn.addEventListener("click", deleteSelectedPlaylist);
nodes.searchInput.addEventListener("input", () => { searchQuery = nodes.searchInput.value.trim(); renderSongs(); });
nodes.sortSelect.addEventListener("change", () => { sortMode = nodes.sortSelect.value; renderSongs(); });

nodes.exportBackup.addEventListener("click", async () => {
  try { await exportBackup(); } catch { showToast("Export failed"); }
});
nodes.importBackupFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try { await importBackup(file); showToast("Imported"); }
  catch { showToast("Import failed"); }
  finally { nodes.importBackupFile.value = ""; }
});

/* ── Service Worker ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* ── Storage Info ── */
async function updateStorageInfo() {
  const storageText = $("storage-text");
  const storageFill = $("storage-fill");
  if (!storageText || !storageFill) return;

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const usedMB = (est.usage || 0) / (1024 * 1024);
      const quotaMB = (est.quota || 0) / (1024 * 1024);
      const pct = quotaMB > 0 ? Math.min(100, (usedMB / quotaMB) * 100) : 0;
      const approxSongs = Math.max(0, Math.floor((quotaMB - usedMB) / 8));
      storageFill.style.width = `${pct}%`;
      if (pct > 80) storageFill.classList.add("warn");
      storageText.textContent = `${usedMB.toFixed(1)} MB used of ${quotaMB > 1024 ? (quotaMB / 1024).toFixed(1) + " GB" : quotaMB.toFixed(0) + " MB"} — room for ~${approxSongs} more songs`;
    } else {
      storageText.textContent = `${songs.length} songs saved offline`;
    }
  } catch {
    storageText.textContent = `${songs.length} songs saved offline`;
  }
}

/* ── PWA Install Banner ── */
function checkPwaBanner() {
  const banner = $("pwa-install-banner");
  if (!banner) return;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  const dismissed = localStorage.getItem("musime-pwa-banner-dismissed");
  if (!isStandalone && !dismissed) {
    banner.classList.remove("hidden");
  }
}

const dismissBtn = $("dismiss-banner");
if (dismissBtn) {
  dismissBtn.addEventListener("click", () => {
    $("pwa-install-banner").classList.add("hidden");
    localStorage.setItem("musime-pwa-banner-dismissed", "1");
  });
}

/* ── Init ── */
loadMeta();
render();
updateStorageInfo();
checkPwaBanner();
