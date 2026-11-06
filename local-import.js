// Read only bounded slices of a recording, regardless of its total size.
const TAG_LIMIT = 2 * 1024 * 1024;
const syncSize = (b, i) => ((b[i] & 127) * 2097152 + (b[i + 1] & 127) * 16384 + (b[i + 2] & 127) * 128 + (b[i + 3] & 127));
const ascii = (b) => String.fromCharCode(...b);
function tagText(b) {
  if (!b.length) return "";
  const encoding = b[0] === 1 ? (b[1] === 254 ? "utf-16be" : "utf-16le") : b[0] === 2 ? "utf-16be" : b[0] === 3 ? "utf-8" : "windows-1252";
  return new TextDecoder(encoding).decode(b.subarray(1)).replace(/\0.*$/s, "").replace(/^\uFEFF/, "").trim().slice(0, 300);
}
export async function readLocalTags(file) {
  const tags = { title: file.name.replace(/\.[^.]+$/, ""), artist: "", cover: null };
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.length === 10 && ascii(head.subarray(0, 3)) === "ID3" && [3, 4].includes(head[3]) && !(head[5] & 0xc0)) {
    const length = syncSize(head, 6);
    if (length <= TAG_LIMIT && length + 10 <= file.size) {
      const data = new Uint8Array(await file.slice(10, 10 + length).arrayBuffer());
      for (let p = 0; p + 10 <= data.length;) {
        const id = ascii(data.subarray(p, p + 4));
        const size = head[3] === 4 ? syncSize(data, p + 4) : new DataView(data.buffer).getUint32(p + 4);
        if (!/^[A-Z0-9]{4}$/.test(id) || !size || p + 10 + size > data.length) break;
        const flags = data[p + 9], b = data.subarray(p + 10, p + 10 + size);
        // Unsupported compressed/encrypted/unsynchronised frames are skipped.
        if (!(flags & (head[3] === 4 ? 0x4f : 0xe0))) {
          if (id === "TIT2") tags.title = tagText(b) || tags.title;
          if (id === "TPE1") tags.artist = tagText(b);
          if (id === "APIC" && !tags.cover && b.length > 4) {
            const end = b.indexOf(0, 1);
            if (end > 1 && end < 40) {
              const mime = ascii(b.subarray(1, end)).toLowerCase();
              let start = end + 2;
              if (b[0] === 1 || b[0] === 2) {
                while (start + 1 < b.length && (b[start] || b[start + 1])) start += 2;
                start += 2;
              } else { while (start < b.length && b[start]) start++; start++; }
              if (["image/jpeg", "image/png", "image/webp"].includes(mime) && start < b.length) tags.cover = new Blob([b.subarray(start)], { type: mime });
            }
          }
        }
        p += 10 + size;
      }
    }
  }
  // ID3v1 fallback: 128 bytes, including for files with oversized ID3v2 tags.
  if (file.size >= 128) {
    const tail = new Uint8Array(await file.slice(-128).arrayBuffer());
    if (ascii(tail.subarray(0, 3)) === "TAG") {
      if (tags.title === file.name.replace(/\.[^.]+$/, "")) tags.title = tagText(new Uint8Array([0, ...tail.subarray(3, 33)])) || tags.title;
      if (!tags.artist) tags.artist = tagText(new Uint8Array([0, ...tail.subarray(33, 63)]));
    }
  }
  return tags;
}

export function isLocalAudio(file) {
  return file.size > 0 && (file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff|aif)$/i.test(file.name));
}

// Files providers may supply an empty or generic MIME type. A native Blob
// slice assigns the correct MP3 type without reading/copying its bytes into JS.
export function localAudioBlob(file) {
  return /\.mp3$/i.test(file.name) && file.type !== "audio/mpeg" ? file.slice(0, file.size, "audio/mpeg") : file;
}

export async function localCover(title, image) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cover creation unavailable");
  if (image) {
    if (image.size > 20 * 1024 * 1024) throw new Error("Choose a cover smaller than 20 MB");
    const url = URL.createObjectURL(image), img = new Image();
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("This cover could not be opened")); img.src = url; });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
    } finally { URL.revokeObjectURL(url); }
  } else {
    let hash = 0; for (const c of title) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    const hue = (hash >>> 0) % 360, gradient = ctx.createLinearGradient(0, 0, 512, 512);
    gradient.addColorStop(0, `hsl(${hue}, 55%, 44%)`); gradient.addColorStop(1, `hsl(${(hue + 50) % 360}, 45%, 16%)`);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "#ffffff22"; ctx.beginPath(); ctx.arc(340, 170, 205, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "white"; ctx.font = "bold 160px system-ui"; ctx.textAlign = "center"; ctx.fillText("♫", 256, 300);
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Cover creation failed")), "image/jpeg", 0.85));
}
