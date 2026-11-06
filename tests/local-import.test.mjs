import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLocalTags, isLocalAudio, localAudioBlob } from '../local-import.js';

function file(parts, name = 'Recording.mp3', type = '') {
  const blob = new Blob(parts, { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}
function size(n) { return [n >>> 21 & 127, n >>> 14 & 127, n >>> 7 & 127, n & 127]; }
function tagged(frames, version = 3) {
  const body = Buffer.concat(frames.map(([id, bytes]) => {
    const header = Buffer.alloc(10); header.write(id);
    if (version === 4) header.set(size(bytes.length), 4); else header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
  }));
  return file([Buffer.from([73, 68, 51, version, 0, 0, ...size(body.length)]), body]);
}
test('accepts MP3 Files with absent/generic MIME and rejects empty or unrelated files', () => {
  assert.equal(isLocalAudio(file(['audio'], 'song.MP3')), true);
  assert.equal(isLocalAudio(file(['audio'], 'song.mp3', 'application/octet-stream')), true);
  assert.equal(isLocalAudio(file([], 'song.mp3', 'audio/mpeg')), false);
  assert.equal(isLocalAudio(file(['text'], 'notes.txt', 'text/plain')), false);
  assert.equal(isLocalAudio(file(['video'], 'video.mp4', 'video/mp4')), false);
});
test('assigns playable MP3 MIME to Files provider output without a whole-file read', async () => {
  for (const type of ['', 'application/octet-stream', 'audio/mp3']) {
    const original = file(['recording'], 'song.MP3', type);
    original.arrayBuffer = () => { throw new Error('Whole-file read'); };
    const audio = localAudioBlob(original);
    assert.equal(audio.type, 'audio/mpeg'); assert.equal(audio.size, original.size);
    assert.equal(await audio.text(), 'recording');
  }
  const original = file(['audio'], 'song.mp3', 'audio/mpeg');
  assert.equal(localAudioBlob(original), original);
});
test('reads UTF-8 title, artist and bounded embedded cover from v2.3 and v2.4', async () => {
  for (const version of [3, 4]) {
    const tags = await readLocalTags(tagged([
      ['TIT2', Buffer.from('\x03A song 🎵')], ['TPE1', Buffer.from('\x03Artist name')],
      ['APIC', Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0'), Buffer.from([255, 216, 255, 217])])],
    ], version));
    assert.equal(tags.title, 'A song 🎵'); assert.equal(tags.artist, 'Artist name');
    assert.equal(tags.cover.type, 'image/jpeg'); assert.equal(tags.cover.size, 4);
  }
});
test('malformed frames and huge tags fall back safely; large files only read tiny slices', async () => {
  const slices = [];
  const large = { name: 'Large.mp3', size: 1024 ** 3, slice(start, end) {
    slices.push([start, end]);
    return new Blob([start === 0 ? new Uint8Array([73, 68, 51, 3, 0, 0, ...size(100 * 1024 ** 2)]) : new Uint8Array(128)]);
  } };
  assert.equal((await readLocalTags(large)).title, 'Large');
  assert.deepEqual(slices, [[0, 10], [-128, undefined]]);
  const malformed = file([new Uint8Array([73, 68, 51, 4, 0, 0, ...size(10)]), Buffer.from('TIT2\x7f\x7f\x7f\x7f\0\0')]);
  assert.equal((await readLocalTags(malformed)).title, 'Recording');
});
test('ID3v1 title and artist are read when there is no v2 tag', async () => {
  const tail = Buffer.alloc(128); tail.write('TAG'); tail.write('Old song', 3); tail.write('Old artist', 33);
  const tags = await readLocalTags(file([tail]));
  assert.equal(tags.title, 'Old song'); assert.equal(tags.artist, 'Old artist');
});
