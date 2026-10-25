// Search metadata only: no audio downloads, credentials, or listening history.
export function normalizeSearch(value) {
  return String(value ?? "").slice(0, 500).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

function nearbyWord(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.max(a.length, b.length) > 40 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function searchMatch(query, value) {
  const q = normalizeSearch(query), text = normalizeSearch(value);
  if (!q || !text) return 0;
  if (q === text) return 1000;
  const wanted = q.split(" ").slice(0, 20), words = text.split(" ");
  const exact = wanted.filter((w) => words.includes(w)).length;
  if (exact === wanted.length) return 750 + (text.startsWith(q) ? 30 : 0);
  if (wanted.every((w) => words.some((word) => nearbyWord(w, word)))) return 450;
  if (q.length >= 3 && text.includes(q)) return 300;
  return exact ? 100 * exact / wanted.length : 0;
}

export function rankSearchSongs(list, query, artistId = "") {
  const q = normalizeSearch(query);
  return list.map((song, index) => {
    const title = searchMatch(q, song.title), artist = searchMatch(q, song.artist);
    const combined = searchMatch(q, `${song.title} ${song.artist}`);
    let score = Math.max(title, artist * .95, combined >= 750 ? 850 : combined * .8);
    if (artistId && song.artistIds?.includes(String(artistId))) score += 1200;
    // Popularity only breaks close matches; it cannot outweigh title relevance.
    score += Math.min(28, Math.log10(1 + Math.max(0, Number(song.playCount) || 0)) * 4);
    return { song, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.song);
}

export function rankSearchArtists(list, query) {
  return list.map((artist, index) => ({ artist, score: searchMatch(query, artist.name), index }))
    .filter((x) => x.score >= 300).sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.artist);
}

export function dedupeSearchSongs(list) {
  const ids = new Set(), recordings = new Set();
  return list.filter((song) => {
    const id = song.saavnId || song.id;
    // Keep versions with different names or durations, even by the same artist.
    const key = `${normalizeSearch(song.title)}|${normalizeSearch(song.artist)}|${Math.round(Number(song.duration) || 0)}`;
    if ((id && ids.has(id)) || recordings.has(key)) return false;
    if (id) ids.add(id);
    recordings.add(key);
    return true;
  });
}

export function createSearchClient({ mirrors, preferred, remember, fetcher = fetch, timeout = 4500, cacheLimit = 32, ttl = 120000 }) {
  const cache = new Map();
  return async function get(path, { signal, field = "results" } = {}) {
    if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
    const key = `${field}:${path}`, saved = cache.get(key);
    if (saved && Date.now() - saved.time < ttl) {
      cache.delete(key); cache.set(key, saved);
      return saved.value;
    }
    cache.delete(key);
    let lastError;
    const first = preferred();
    for (const mirror of [first, ...mirrors.filter((m) => m !== first)]) {
      if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      try {
        const response = await fetcher(`${mirror}${path}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Search unavailable (${response.status})`);
        const payload = await response.json();
        if (payload?.success === false || !Array.isArray(payload?.data?.[field])) throw new Error("Invalid search response");
        if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
        // Limit hostile/malformed payloads before ranking or rendering them.
        const value = { ...payload.data, [field]: payload.data[field].slice(0, 100) };
        remember(mirror);
        cache.set(key, { time: Date.now(), value });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
        lastError = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw lastError || new Error("Search unavailable");
  };
}
