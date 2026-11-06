export const LYRICS_MAX_CHARS = 60000;
export const LYRICS_MAX_LINES = 1000;

export function cleanLyrics(input) {
  const text = String(input || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!text) throw new Error("Paste some lyrics first.");
  if (text.length > LYRICS_MAX_CHARS) throw new Error("Keep lyrics under 60,000 characters.");
  if (text.split("\n").length > LYRICS_MAX_LINES) throw new Error("Keep lyrics under 1,000 lines.");
  return text;
}

export function lyricStamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Choose a valid playback time.");
  const hundredths = Math.round(seconds * 100);
  return `[${String(Math.floor(hundredths / 6000)).padStart(2, "0")}:${String(Math.floor(hundredths / 100) % 60).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}]`;
}

export function userLyrics(input, times = null) {
  const text = cleanLyrics(input);
  const lines = text.split("\n");
  if (times) {
    const words = lines.filter((line) => line.trim());
    if (times.length !== words.length || times.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t < times[i - 1]))) throw new Error("Mark every line in order before saving synced lyrics.");
    return { source: "user", plainLyrics: text, syncedLyrics: words.map((line, i) => `${lyricStamp(times[i])} ${line}`).join("\n") };
  }
  const timed = lines.some((line) => /^\s*\[\d+:\d/.test(line));
  if (!timed) return { source: "user", plainLyrics: text, syncedLyrics: null };
  const plain = [];
  let stamps = 0;
  for (const line of lines) {
    if (!line.trim() || /^\[(ar|ti|al|by|length|re|ve):[^\]]*\]\s*$/i.test(line)) continue;
    // Leading timestamps only. Preserve bracketed words in the actual lyric.
    const prefix = line.match(/^\s*((?:\[\d{1,5}:[0-5]\d(?:\.\d{1,3})?\])+)/);
    if (!prefix) throw new Error("Timestamp every lyric line, or paste plain lyrics without timestamps.");
    stamps += (prefix[1].match(/\[/g) || []).length;
    if (stamps > 2000) throw new Error("Too many timestamps in these lyrics.");
    plain.push(line.slice(prefix[0].length).trim());
  }
  return { source: "user", plainLyrics: plain.join("\n"), syncedLyrics: text };
}
