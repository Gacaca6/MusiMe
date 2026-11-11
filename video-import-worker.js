import {
  BufferTarget, CustomSource, EncodedAudioPacketSource, EncodedPacketSink,
  Input, MP4, Mp4OutputFormat, Output, QTFF,
} from "./vendor/mediabunny-video-1.65.2.js";

const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const MAX_AUDIO_BYTES = 64 * 1024 ** 2;
const MAX_SECONDS = 60 * 60;
const MAX_PACKETS = 250000;

class ImportError extends Error {}

const pendingReads = new Map();
let nextReadId = 0;
function readVideoRange(start, end) {
  return new Promise((resolve) => {
    const id = ++nextReadId;
    pendingReads.set(id, resolve);
    self.postMessage({ type: "read", id, start, end });
  });
}

async function extractAudio(size) {
  if (!size) throw new ImportError("This video is empty.");
  if (size > MAX_VIDEO_BYTES) throw new ImportError("Choose a video under 2 GB.");

  // Keep the picker File in the page that has permission to read it. Transfer
  // only requested byte ranges and keep parsing off the UI thread.
  const file = new CustomSource({ getSize: () => size, read: readVideoRange, prefetchProfile: "fileSystem" });
  const input = new Input({ source: file, formats: [MP4, QTFF] });
  let output;
  try {
    if (!(await input.getVideoTracks()).length) throw new ImportError("Choose an MP4 or MOV video. Audio files go in the song picker above.");
    const audioTracks = await input.getAudioTracks();
    if (!audioTracks.length) throw new ImportError("This video has no audio track.");

    // Some iPhone videos include a spatial track alongside standard AAC.
    const primary = await input.getPrimaryAudioTrack();
    const candidates = [primary, ...audioTracks.filter((track) => track !== primary)];
    let audio;
    for (const track of candidates) {
      if (track && await track.getCodec() === "aac") { audio = track; break; }
    }
    if (!audio) throw new ImportError("This video's audio format isn't supported. Choose a video with AAC audio.");

    const decoderConfig = await audio.getDecoderConfig();
    if (!decoderConfig) throw new ImportError("Could not read this video's audio track.");
    const expectedDuration = await audio.getDurationFromMetadata();
    if (expectedDuration > MAX_SECONDS + 0.1) throw new ImportError("Choose a video with up to 60 minutes of audio.");

    const target = new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const source = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(source);
    await output.start();

    let bytes = 0;
    let count = 0;
    let firstTimestamp = 0;
    let duration = 0;
    for await (const packet of new EncodedPacketSink(audio).packets()) {
      if (count === 0) firstTimestamp = packet.timestamp;
      const timestamp = packet.timestamp - firstTimestamp;
      duration = Math.max(duration, timestamp + packet.duration);
      bytes += packet.byteLength;
      if (duration > MAX_SECONDS + 0.1) throw new ImportError("Choose a video with up to 60 minutes of audio.");
      if (count >= MAX_PACKETS) throw new ImportError("This video contains too many audio packets. Try a shorter clip.");
      if (bytes > MAX_AUDIO_BYTES) throw new ImportError("This video has more than 64 MB of audio. Try a shorter clip.");
      await source.add(packet.clone({ timestamp }), count === 0 ? { decoderConfig } : undefined);
      if (++count % 128 === 0) {
        self.postMessage({ type: "progress", value: expectedDuration > 0 ? Math.min(0.99, duration / expectedDuration) : null });
      }
    }
    if (!bytes) throw new ImportError("This video has no audio to import.");
    await output.finalize();
    return { blob: new Blob([target.buffer], { type: "audio/mp4" }), duration };
  } finally {
    input.dispose();
    if (output && output.state !== "finalized") await output.cancel().catch(() => {});
  }
}

async function run(size) {
  try {
    self.postMessage({ type: "done", ...await extractAudio(size) });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof ImportError ? error.message : "Could not read this video. Choose a playable MP4 or MOV with AAC audio." });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    void run(data.size);
  } else if (data.type === "read-result") {
    const resolve = pendingReads.get(data.id);
    pendingReads.delete(data.id);
    resolve?.(new Uint8Array(data.buffer));
  }
};
