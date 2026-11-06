import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userLyrics, lyricStamp } from '../lyrics-tools.js';

test('plain lyrics preserve stanzas, Unicode and literal HTML without inventing timing', () => {
  const record = userLyrics(' First line\r\n\r\nAmagambo 🎵 <b>literal</b> ');
  assert.equal(record.source, 'user'); assert.equal(record.syncedLyrics, null);
  assert.equal(record.plainLyrics, 'First line\n\nAmagambo 🎵 <b>literal</b>');
});
test('timestamped LRC keeps timing and builds a readable plain version', () => {
  const record = userLyrics('[ar:Artist]\n[00:01.25] First\n[00:03][00:07] Second [chorus]');
  assert.equal(record.plainLyrics, 'First\nSecond [chorus]');
  assert.match(record.syncedLyrics, /00:07/);
  assert.throws(() => userLyrics('[00:99] Wrong'), /Timestamp/);
  assert.throws(() => userLyrics('[00:01] First\nUntimed'), /Timestamp/);
});
test('manual timing validates completeness/order and handles rounding at minute boundaries', () => {
  const record = userLyrics('First\n\nSecond', [0, 59.999]);
  assert.equal(record.syncedLyrics, '[00:00.00] First\n[01:00.00] Second');
  assert.equal(lyricStamp(123.456), '[02:03.46]');
  for (const times of [[0], [4, 1], [NaN, 1], [-1, 1]]) assert.throws(() => userLyrics('First\nSecond', times));
});
test('empty or oversized input is rejected before rendering/storage', () => {
  assert.throws(() => userLyrics(' \n '), /Paste/);
  assert.throws(() => userLyrics('a'.repeat(60001)), /60,000/);
  assert.throws(() => userLyrics(Array(1001).fill('line').join('\n')), /1,000/);
});
