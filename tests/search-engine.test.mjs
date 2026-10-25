import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../search-engine.js', import.meta.url), 'utf8');
const { normalizeSearch, searchMatch, rankSearchSongs, rankSearchArtists, dedupeSearchSongs, createSearchClient } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const song = (id, title, artist, extra = {}) => ({ id, saavnId: id, title, artist, duration: 200, ...extra });
const response = (results, extra = {}) => ({ ok: true, json: async () => ({ success: true, data: { results, ...extra } }) });

test('normalization preserves African/non-Latin names, accents and apostrophe variants', () => {
  assert.equal(normalizeSearch('  Céline — D’Angelo! '), 'celine dangelo');
  assert.equal(normalizeSearch('世界 音楽'), '世界 音楽');
  assert.equal(normalizeSearch('की'), 'की');
  assert.notEqual(normalizeSearch('की'), normalizeSearch('क'));
  assert.equal(searchMatch('', 'anything'), 0);
  assert.ok(searchMatch('mbonyi', 'Israel Mbonyi') > searchMatch('mbonyi', 'Mbonyicyambu'));
});
test('exact title outranks popular incidental artist matches and versions remain available', () => {
  const ranked = rankSearchSongs([song('a', 'Other song', 'Nakupenda', { playCount: 1e12 }), song('b', 'Nakupenda (Live)', 'TXC'), song('c', 'Nakupenda', 'TXC')], 'Nakupenda');
  assert.equal(ranked[0].id, 'c');
  assert.equal(ranked.length, 3);
  assert.equal(rankSearchSongs([song('a', 'Love me', 'Someone'), song('b', 'Love me', 'Artist')], 'Love me Artist')[0].id, 'b');
});
test('one-edit and transposed spellings help candidates without replacing exact matches', () => {
  assert.ok(searchMatch('Mbonyi', 'Mboyni') > 0);
  assert.ok(searchMatch('Mbonyi', 'Mbony') > 0);
  assert.ok(searchMatch('Mbonyi', 'Mbonyi') > searchMatch('Mbonyi', 'Mboyni'));
  assert.equal(searchMatch('TXC', 'TAC'), 0);
});
test('artist identity outweighs text; similarly named artists remain distinct', () => {
  assert.equal(rankSearchSongs([song('a', 'Israel Mbonyi', 'Other', { artistIds: ['other'] }), song('b', 'Karame', 'Israel Mbonyi', { artistIds: ['correct'] })], 'Israel Mbonyi', 'correct')[0].id, 'b');
  const artists = rankSearchArtists([{ id: 'a', name: 'Israel Mbonyicyambu' }, { id: 'b', name: 'Israel Mbonyi' }, { id: 'c', name: 'Unrelated' }], 'Israel Mbonyi');
  assert.equal(artists[0].id, 'b');
  assert.ok(!artists.some((a) => a.id === 'c'));
});
test('deduplication removes repeated recordings but preserves alternate versions and duration', () => {
  assert.deepEqual(dedupeSearchSongs([song('a', 'One', 'Artist'), song('a', 'One', 'Artist'), song('b', 'One', 'Artist'), song('c', 'One', 'Artist', { duration: 300 }), song('d', 'One (Live)', 'Artist')]).map((s) => s.id), ['a', 'c', 'd']);
});
test('malformed/error mirrors fail over; valid responses are cached', async () => {
  let calls = 0, remembered;
  const get = createSearchClient({ mirrors: ['a', 'b', 'c'], preferred: () => 'a', remember: (m) => remembered = m, fetcher: async (url) => {
    calls++;
    if (url.startsWith('a')) return { ok: false, status: 503 };
    if (url.startsWith('b')) return { ok: true, json: async () => ({ data: { results: null } }) };
    return response([{ id: 'valid' }]);
  } });
  assert.equal((await get('/search')).results[0].id, 'valid');
  await get('/search'); assert.equal(calls, 3); assert.equal(remembered, 'c');
});
test('valid empty responses are not errors and artist-song shapes are validated separately', async () => {
  let calls = 0;
  const get = createSearchClient({ mirrors: ['a'], preferred: () => 'a', remember() {}, fetcher: async () => { calls++; return response([], { songs: [] }); } });
  assert.deepEqual((await get('/empty')).results, []);
  assert.deepEqual((await get('/empty', { field: 'songs' })).songs, []);
  assert.equal(calls, 2);
});
test('failed responses are never cached; retry succeeds', async () => {
  let working = false, calls = 0;
  const get = createSearchClient({ mirrors: ['a'], preferred: () => 'a', remember() {}, fetcher: async () => { calls++; if (!working) throw new Error('offline'); return response([]); } });
  await assert.rejects(get('/retry'));
  working = true; await get('/retry'); assert.equal(calls, 2);
});
test('cache has bounded size and payloads cannot create an unbounded result list', async () => {
  let calls = 0;
  const get = createSearchClient({ mirrors: ['a'], preferred: () => 'a', remember() {}, cacheLimit: 2, fetcher: async () => { calls++; return response(Array.from({ length: 1000 }, (_, id) => ({ id }))); } });
  assert.equal((await get('/1')).results.length, 100);
  await get('/2'); await get('/3'); await get('/1'); assert.equal(calls, 4);
});
test('expired cache entries refresh instead of serving permanent stale results', async () => {
  let calls = 0;
  const get = createSearchClient({ mirrors: ['a'], preferred: () => 'a', remember() {}, ttl: -1, fetcher: async () => { calls++; return response([]); } });
  await get('/query'); await get('/query'); assert.equal(calls, 2);
});
test('hung requests time out and continue to a working mirror', async () => {
  const get = createSearchClient({ mirrors: ['a', 'b'], preferred: () => 'a', remember() {}, timeout: 20, fetcher: (url, { signal }) => url.startsWith('b') ? Promise.resolve(response([])) : new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true })) });
  assert.deepEqual((await get('/slow')).results, []);
});
test('cancelling a query stops fallback requests and rejects pre-aborted requests', async () => {
  let calls = 0;
  const get = createSearchClient({ mirrors: ['a', 'b'], preferred: () => 'a', remember() {}, fetcher: (_, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })); } });
  const controller = new AbortController(), pending = get('/slow', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(get('/slow', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
