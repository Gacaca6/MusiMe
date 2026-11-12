/* Isolated synthetic libraries only. Never connects to the user's browser profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.TEST_OUTPUT_DIR || path.join(root, 'test-results'));
fs.mkdirSync(output, { recursive: true });
const build = '2026.11.12.3';
const results = [];
const browserResourceDiagnostics = [];
let activeScenario = "";
let release = 'current', failedAsset = '', version = build;
const oldFiles = Object.fromEntries(['index.html', 'app.js', 'styles.css', 'sw.js'].map((name) => [name,
  execFileSync('git', ['show', `dd6fb19:${name}`], { cwd: root, encoding: 'utf8' })]));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#845c41"/><circle cx="150" cy="150" r="90" fill="#343e4b"/><text x="150" y="160" fill="white" text-anchor="middle" font-size="28">OFFLINE</text></svg>';
function wav() {
  const data = Buffer.alloc(44 + 8000 * 2 * 60);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40); return data;
}
const audio = wav();
const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.startsWith('/MusiMe/')) pathname = pathname.slice('/MusiMe'.length);
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  res.setHeader('Cache-Control', 'no-store');
  if (name === 'art.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg); return; }
  if (name === 'audio.wav') { res.setHeader('Content-Type', 'audio/wav'); res.end(audio); return; }
  if (name === 'error.mp3') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Not audio</h1>'); return; }
  if (name === 'empty.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(); return; }
  if (name === 'stall.mp3') return;
  if (name === 'fail.mp3' || name === failedAsset) { res.statusCode = 503; res.end('Unavailable'); return; }
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  let body = release === 'legacy' && oldFiles[name] !== undefined ? oldFiles[name] : fs.readFileSync(file);
  if (typeof body !== 'string' && ['app.js', 'index.html', 'sw.js'].includes(name)) body = body.toString();
  if (release !== 'legacy' && typeof body === 'string') body = body.replaceAll(build, version);
  res.end(body);
});
let origin, browser;
function library(count, options = {}) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Song ${String(i).padStart(5, '0')}`,
    artist: options.oneAlbum ? "Album artist" : `Artist ${Math.floor(i / 10) % 400}`, album: options.oneAlbum ? 'Mega album' : `Album ${Math.floor(i / 10)}`,
    artwork: i < 20 ? `${origin}/art.svg` : `${origin}/missing-cover.png`, source: 'device', duration: 60,
    createdAt: 1800000000000 - i, lastPlayedAt: i < 10 ? i + 1 : 0, track: options.oneAlbum ? i + 1 : i % 10 + 1,
    favorite: i < 3, playlists: [`Playlist ${i % 200}`] }));
}
async function contextPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__fullBlobReads = 0; const read = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'songs' && args[0] === undefined) window.__fullBlobReads++; return read.apply(this, args); }; });
  const errors = [];
  if (process.env.TEST_DEBUG) { page.on('request', (r) => console.log('REQ', r.url())); page.on('requestfinished', (r) => console.log('DONE', r.url())); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); }
  page.on('pageerror', (error) => {
    if (process.env.TEST_BROWSER === 'webkit' && /due to access control checks\.$/.test(error.message)) browserResourceDiagnostics.push({ scenario: activeScenario, message: error.message });
    else errors.push(error.message);
  });
  // API failures and artwork failures are deterministic; no real external downloads.
  await context.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, headers: {'Access-Control-Allow-Origin':'*'}, body: 'Unavailable' }));
  return { context, page, errors };
}
async function seed(page, list, options = {}) {
  await page.goto(origin + (options.prefix || '/'));
  await page.evaluate(async ({ list, svg, options }) => {
    try { localStorage.setItem('musime-songs-meta', JSON.stringify(list)); } catch (error) { throw new Error(`Fixture metadata: ${error.name}: ${error.message}; JSON characters ${JSON.stringify(list).length}`); }
    localStorage.setItem('musime-playlists', JSON.stringify(options.playlists || ['All songs', ...Array.from({ length: 200 }, (_, i) => `Playlist ${i}`)]));
    localStorage.setItem('musime-playlist-orders', JSON.stringify(options.orders || {}));
    localStorage.setItem('musime-debug-log', '[]');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('musime-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('songs');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const audio = await fetch(new URL("audio.wav", location.href)).then((r) => r.blob());
    const preparedAudio = options.encodedBlobs ? { data: await audio.arrayBuffer(), type: audio.type } : audio;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite'), store = tx.objectStore('songs');
      store.clear();
      const tiny = new Blob(['fixture'], { type: 'audio/wav' });
      for (let i = 0; i < list.length; i++) {
        if (!list[i] || typeof list[i].id !== 'string') continue;
        if (!options.missingAudio) store.put(i < 3 ? preparedAudio : options.encodedBlobs ? { data: new Uint8Array([1]).buffer, type: "audio/wav" } : tiny, list[i].id);
        if (i < 20) store.put(options.corruptArtwork && i === 1 ? (options.encodedBlobs ? { data: new TextEncoder().encode("broken image").buffer, type: "image/svg+xml" } : new Blob(["broken image"], {type:"image/svg+xml"})) : options.encodedBlobs ? { data: new TextEncoder().encode(svg).buffer, type: "image/svg+xml" } : new Blob([svg], { type: "image/svg+xml" }), `art-${list[i].id}`);
      }
      tx.oncomplete = resolve; tx.onerror = (event) => reject(new Error(`Fixture IDB error: ${event.target.error?.name}: ${event.target.error?.message}`)); tx.onabort = () => reject(new Error(`Fixture IDB abort: ${tx.error?.name}`));
    });
    db.close();
  }, { list, svg, options: { ...options, encodedBlobs: process.env.TEST_BROWSER === "webkit" } });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
  await page.waitForTimeout(250);
}
async function noErrors(errors) { assert.deepEqual(errors, []); }
async function check(name, fn) {
  if (process.env.TEST_MATCH && !new RegExp(process.env.TEST_MATCH).test(name)) return;
  if (process.env.TEST_BROWSER === 'webkit' && /^(legacy installed|failed release|cached offline)/.test(name)) { const skipped = { name, status: 'SKIP', reason: 'Playwright service-worker/offline emulation is only supported on Chromium; physical iOS verification remains required.' }; results.push(skipped); console.log(JSON.stringify(skipped)); return; }
  const start = Date.now();
  activeScenario = name;
  console.log(`RUN ${name}`);
  try { const detail = await fn(); const result = { name, status: 'PASS', ms: Date.now() - start, ...detail }; results.push(result); console.log(JSON.stringify(result)); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); throw error; }
}
async function clickMode(page, mode) { await page.locator(`#lib-mode [data-mode="${mode}"]`).click(); }
async function storageSnapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('musime-db', 1); r.onsuccess = () => resolve(r.result); });
    const rows = await new Promise((resolve) => { const tx = db.transaction('songs'); const store = tx.objectStore('songs'); const req = store.getAll(); const keys = store.getAllKeys(); tx.oncomplete = () => resolve(req.result.filter((_, i) => !/^(lyr-|dj-)/.test(keys.result[i]))); });
    db.close();
    return { metadata: localStorage.getItem('musime-songs-meta'), playlists: localStorage.getItem('musime-playlists'),
      bytes: await Promise.all(rows.map(async (blob) => ({ size: blob.size ?? blob.data.byteLength, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', blob instanceof Blob ? await blob.arrayBuffer() : blob.data))].join(',') }))) };
  });
}
function searchSong(id, name, artist = "Test artist", artistId = "artist", extra = {}) {
  return { id, name, duration: 60, playCount: 10, album: { id: `release-${id}`, name },
    artists: { primary: [{ id: artistId, name: artist }] }, image: [{ quality: '500x500', url: origin + '/art.svg' }],
    downloadUrl: [{ quality: '96kbps', url: origin + '/audio.wav' }, { quality: '160kbps', url: origin + '/audio.wav' }], ...extra };
}
async function searchMock(context, handler) {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const result = await handler(url);
    if (process.env.TEST_DEBUG) console.log("MOCK", url.href, result?.json?.data?.results?.length, result?.status);
    if (result?.abort) { await route.abort('failed').catch(() => {}); return; }
    await route.fulfill({ status: result?.status || 200, headers: { 'Access-Control-Allow-Origin': '*' },
      json: result?.json || { success: true, data: { total: 0, results: [] } } }).catch(() => {});
  });
}
async function submitSearch(page, query) {
  await page.locator('[data-view="view-search"]').click();
  await page.locator('#search-query').fill(query); await page.locator('#search-query').press('Enter');
}
async function searchSettled(page) { await page.waitForFunction(() => document.getElementById('search-results').getAttribute('aria-busy') === 'false'); }
async function runFrontend() {
  await check('video import: MP4 and iPhone-style MOV save only AAC audio with covers and offline playback', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] });
      const chromium = (process.env.TEST_BROWSER || 'chromium') === 'chromium';
      if (chromium) {
        await page.evaluate(() => navigator.serviceWorker.ready);
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      }
      await page.locator('[aria-label="Settings"]').click();
      const picker = page.locator('#video-file-input');
      for (const extension of ['mp4', 'mov']) {
        const bytes = fs.readFileSync(path.join(root, `tests/fixtures/video-with-audio.${extension}`));
        if (extension === 'mp4') {
          const choosing = page.waitForEvent('filechooser');
          await picker.click();
          await (await choosing).setFiles(path.join(root, 'tests/fixtures/video-with-audio.mp4'));
        } else {
          await picker.setInputFiles({ name: 'Tone from mov.mov', mimeType: 'application/octet-stream', buffer: bytes });
        }
        await page.waitForFunction(() => document.getElementById('device-import-status').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#device-import-status').textContent(), '1 song imported to Home.');
      }
      await page.locator('.video-import-option').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'video-import-settings.png') });
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      const records = await page.evaluate(async () => {
        const { BlobSource, Input, MP4 } = await import('/vendor/mediabunny-video-1.65.2.js');
        const songs = JSON.parse(localStorage.getItem('musime-songs-meta'));
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('musime-db', 1);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const read = (id) => new Promise((resolve, reject) => {
          const request = db.transaction('songs').objectStore('songs').get(id);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try {
          return await Promise.all(songs.map(async (song) => {
            const saved = await read(song.id);
            const blob = saved instanceof Blob ? saved : new Blob([saved.data], { type: saved.type });
            const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
            try {
              const tracks = await input.getAudioTracks();
              return { title: song.title, duration: song.duration, type: blob.type, cover: !!await read(`art-${song.id}`), videoTracks: (await input.getVideoTracks()).length, audioCodecs: await Promise.all(tracks.map((track) => track.getCodec())) };
            } finally { input.dispose(); }
          }));
        } finally { db.close(); }
      });
      assert.deepEqual(records.map((record) => record.title).sort(), ['Tone from mov', 'video-with-audio']);
      for (const record of records) {
        assert.deepEqual(record.audioCodecs, ['aac']);
        assert.equal(record.videoTracks, 0);
        assert.equal(record.type, 'audio/mp4');
        assert.equal(record.cover, true);
        assert.ok(record.duration >= 3 && record.duration < 3.1);
      }
      if (chromium) {
        await clickMode(page, 'songs');
        await page.locator('.song-main').first().click();
        await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2);
      }
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('video import: silent and damaged files leave the library intact; cancel and retry work', async () => {
    const { context, page, errors } = await contextPage({ serviceWorkers: 'block' });
    try {
      await seed(page, [], { playlists: ['All songs'] });
      await page.locator('[aria-label="Settings"]').click();
      const picker = page.locator('#video-file-input');
      const status = page.locator('#device-import-status');
      await picker.setInputFiles(path.join(root, 'tests/fixtures/video-silent.mp4'));
      await page.waitForFunction(() => document.getElementById('device-import-status').getAttribute('aria-busy') === 'false');
      assert.match(await status.textContent(), /no audio track/);
      await picker.setInputFiles({ name: 'Broken.mov', mimeType: 'video/quicktime', buffer: Buffer.from('invalid container') });
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent.includes('Could not read this video'));
      const workerRoute = '**/video-import-worker.js?*';
      await context.route(workerRoute, (route) => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = () => {};' }));
      await picker.setInputFiles(path.join(root, 'tests/fixtures/video-with-audio.mp4'));
      await page.locator('#video-import-cancel').click();
      assert.equal(await status.textContent(), 'Video import canceled.');
      assert.equal(await page.locator('#songs .song').count(), 0);
      await context.unroute(workerRoute);
      await picker.setInputFiles(path.join(root, 'tests/fixtures/video-with-audio.mp4'));
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent === '1 song imported to Home.');
      assert.equal(await page.locator('#songs .song').count(), 1);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom cover: existing song photo changes persist offline and update player without restarting audio', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1)); await clickMode(page, 'songs'); await page.locator('.song-main').click();
      const source = await page.locator('#audio').getAttribute('src');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Change cover', exact: true }).click();
      await page.locator('.song-cover-editor').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
      await page.setViewportSize({width:844,height:390});
      const coverBounds = await page.locator('.song-cover-editor').boundingBox();
      assert.ok(coverBounds.y >= -1 && coverBounds.y+coverBounds.height <= 391);
      await page.setViewportSize({width:390,height:844});
      await page.locator('#song-cover-file').setInputFiles({ name: 'my-cover.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64') });
      await page.waitForFunction(() => !document.getElementById('song-cover-save').disabled);
      await page.screenshot({ path: path.join(output, 'song-cover-editor.png') });
      await page.locator('#song-cover-save').click(); await page.locator('#song-cover-sheet').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#audio').getAttribute('src'), source);
      assert.equal(await page.locator('#mini-art').evaluate((img) => img.src.startsWith('blob:')), true);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('musime-songs-meta'))[0].customArtwork), true);
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true'); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Change cover', exact: true }).click();
      await page.waitForFunction(() => { const i = document.getElementById('song-cover-image'); return !i.classList.contains('hidden') && i.complete && i.naturalWidth > 0; });
      await page.locator('#song-cover-auto').click(); await page.waitForFunction(() => !document.getElementById('song-cover-save').disabled);
      await page.locator('#song-cover-cancel').click();
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Change cover', exact: true }).click();
      assert.equal(await page.locator('#song-cover-save').isDisabled(), true);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: app updates wait for unsaved lyrics and cover editors', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1)); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      await page.locator('#lyrics-editor-text').fill('Unsaved lyrics');
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {data:{type:'MUSIME_VERSION',version:'future-test'}})));
      assert.equal(await page.locator('#apply-app-update').isDisabled(), true);
      await page.locator('#lyrics-editor-cancel').click(); assert.equal(await page.locator('#apply-app-update').isEnabled(), true);
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Change cover', exact: true }).click();
      assert.equal(await page.locator('#apply-app-update').isDisabled(), true);
      await page.locator('#song-cover-cancel').click(); assert.equal(await page.locator('#apply-app-update').isEnabled(), true);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom cover: invalid image and storage errors keep old artwork; retry and automatic cover work', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1)); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Change cover', exact: true }).click();
      await page.locator('#song-cover-file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
      await page.waitForFunction(() => document.getElementById('song-cover-status').textContent.includes('could not be opened'));
      assert.equal(await page.locator('#song-cover-save').isDisabled(), true);
      await page.locator('#song-cover-auto').click(); await page.waitForFunction(() => !document.getElementById('song-cover-save').disabled);
      await page.evaluate(() => { const put = IDBObjectStore.prototype.put; window.__coverPut = put; IDBObjectStore.prototype.put = function (value, key) { if (String(key).startsWith('art-')) throw new DOMException('Full', 'QuotaExceededError'); return put.call(this, value, key); }; });
      await page.locator('#song-cover-save').click(); await page.waitForFunction(() => document.getElementById('song-cover-status').textContent.includes('Storage is full'));
      await page.evaluate(() => IDBObjectStore.prototype.put = window.__coverPut);
      await page.locator('#song-cover-save').click(); await page.locator('#song-cover-sheet').waitFor({ state: 'hidden' });
      assert.match(await page.locator('#toast').textContent(), /Cover saved offline/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: imported song shortcut, plain preview, safe text, offline persistence and re-edit', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] }); await page.locator('[aria-label="Settings"]').click();
      await page.locator('#file-input').setInputFiles(path.join(root, 'tests/fixtures/import-tone.mp3'));
      await page.locator('#import-add-lyrics').waitFor({ state: 'visible' });
      await page.locator('#import-add-lyrics').click(); await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      const words = 'First line\n\nAmagambo 🎵\n<img src=x onerror="window.lyricsXss=true">';
      await page.locator('#lyrics-editor-text').fill(words); await page.locator('#lyrics-editor-preview-btn').click();
      assert.equal(await page.locator('#lyrics-editor-preview img').count(), 0);
      assert.match(await page.locator('#lyrics-editor-preview').textContent(), /Amagambo/);
      await page.locator('#lyrics-editor-save').click(); await page.locator('#lyrics-editor').waitFor({ state: 'hidden' });
      if ((process.env.TEST_BROWSER || 'chromium') === 'chromium') { await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true); }
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true'); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      assert.equal(await page.locator('#lyrics-editor-text').inputValue(), words);
      await page.locator('#lyrics-editor-text').fill('Unsaved draft'); await page.locator('#lyrics-editor-cancel').click();
      await page.locator('.song-main').click(); await page.waitForFunction(() => !document.getElementById('lyrics-card').classList.contains('hidden'));
      await page.locator('#mini-title').click(); await page.locator('#np-lyrics').click();
      assert.match(await page.locator('#lf-scroll').textContent(), /Amagambo/);
      assert.equal(await page.locator('#lf-scroll img').count(), 0); assert.equal(await page.evaluate(() => window.lyricsXss), undefined);
      await page.screenshot({ path: path.join(output, 'custom-lyrics-reader.png') });
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: professional import and editor fit narrow phones and landscape', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1)); await page.locator('[aria-label="Settings"]').click();
      for (const viewport of [{width:280,height:640}, {width:390,height:844}, {width:844,height:390}]) {
        await page.setViewportSize(viewport);
        await page.locator('#device-import').scrollIntoViewIfNeeded();
        const overflow = await page.locator('#device-import').evaluate((el) => el.scrollWidth - el.clientWidth);
        assert.ok(overflow <= 1, `Import overflow ${overflow} at ${viewport.width}`);
        if (viewport.width === 390) { await page.locator('#device-import').evaluate((el) => el.scrollIntoView({block:'start'})); await page.screenshot({path:path.join(output,'import-settings.png')}); }
      }
      await page.setViewportSize({width:390,height:844}); await page.locator('[data-view="view-home"]').click(); await clickMode(page,'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button',{name:'Add / edit lyrics',exact:true}).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      await page.locator('#lyrics-editor-text').fill('First verse\nYour words, your music\n\nA chorus to remember');
      await page.locator('.lyrics-editor').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
      for (const viewport of [{width:280,height:640}, {width:390,height:844}, {width:844,height:390}]) {
        await page.setViewportSize(viewport);
        const bounds = await page.locator('.lyrics-editor').boundingBox();
        assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x+bounds.width <= viewport.width+1 && bounds.y+bounds.height <= viewport.height+1, JSON.stringify({viewport,bounds}));
        assert.ok(await page.locator('#lyrics-editor-save').isVisible());
        if (viewport.width === 390) await page.screenshot({path:path.join(output,'lyrics-editor.png')});
      }
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: timestamped lines, validation, failed storage retry and song isolation', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(2)); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').first().click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      await page.locator('#lyrics-editor-save').click(); assert.match(await page.locator('#lyrics-editor-status').textContent(), /Paste some lyrics/);
      const lrc = '[00:00.00] First [chorus]\n[00:02.00] Second line';
      await page.locator('#lyrics-editor-text').fill(lrc);
      await page.evaluate(() => { const original = IDBObjectStore.prototype.put; window.__restoreLyricsPut = () => IDBObjectStore.prototype.put = original; IDBObjectStore.prototype.put = function (value, key) { if (String(key).startsWith('lyr-')) throw new DOMException('Full', 'QuotaExceededError'); return original.call(this, value, key); }; });
      await page.locator('#lyrics-editor-save').click(); await page.waitForFunction(() => document.getElementById('lyrics-editor-status').textContent.includes('Storage is full'));
      assert.equal(await page.locator('#lyrics-editor-text').inputValue(), lrc);
      await page.evaluate(() => window.__restoreLyricsPut()); await page.locator('#lyrics-editor-save').click(); await page.locator('#lyrics-editor').waitFor({ state: 'hidden' });
      await page.locator('.song-main').first().click(); await page.waitForFunction(() => document.querySelectorAll('#lyrics-panel .lyric-line').length === 2);
      assert.equal(await page.locator('#lyrics-panel .lyric-line').first().textContent(), 'First [chorus]');
      await page.locator('#songs button[aria-label^="Options for"]').nth(1).click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly); assert.equal(await page.locator('#lyrics-editor-text').inputValue(), '');
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: tap-to-sync records, undo and complete save', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1)); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      await page.locator('#lyrics-editor-text').fill('First line\nSecond line'); await page.locator('#lyrics-sync-start').click();
      await page.locator('#lyrics-sync-panel').waitFor({ state: 'visible' });
      // Deterministic UI timing checks, separate from audio-output tests.
      await page.evaluate(() => { const a = document.getElementById('audio'); a.pause(); Object.defineProperty(a, 'currentTime', { configurable: true, writable: true, value: 1 }); });
      await page.locator('#lyrics-sync-mark').click(); assert.match(await page.locator('#lyrics-sync-count').textContent(), /1 of 2/);
      await page.locator('#lyrics-sync-undo').click(); assert.match(await page.locator('#lyrics-sync-count').textContent(), /0 of 2/);
      await page.locator('#lyrics-sync-mark').click(); await page.evaluate(() => document.getElementById('audio').currentTime = 3);
      await page.locator('#lyrics-sync-mark').click(); assert.equal(await page.locator('#lyrics-editor-save').textContent(), 'Save synced lyrics');
      await page.locator('#lyrics-editor-save').click(); await page.locator('#lyrics-editor').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#lyrics-panel .lyric-line').count(), 2);
      await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('timeupdate')));
      assert.equal(await page.locator('#lyrics-panel .lyric-line.active').textContent(), 'Second line');
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('custom lyrics: late online lookup cannot overwrite pasted lyrics', async () => {
    const { context, page, errors } = await contextPage({ serviceWorkers: 'block' });
    let release;
    const gate = new Promise((resolve) => release = resolve);
    try {
      await context.route('https://lrclib.net/api/search**', async (route) => { await gate; await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: [{ syncedLyrics: '[00:00] Wrong provider words', plainLyrics: 'Wrong provider words' }] }); });
      await seed(page, library(1)); await clickMode(page, 'songs'); await page.locator('.song-main').click();
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly);
      await page.locator('#lyrics-editor-text').fill('My own words'); await page.locator('#lyrics-editor-save').click(); await page.locator('#lyrics-editor').waitFor({ state: 'hidden' });
      release(); await page.waitForTimeout(400);
      assert.equal(await page.locator('#lyrics-panel .lyrics-plain').textContent(), 'My own words');
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true'); await clickMode(page, 'songs');
      await page.locator('#songs button[aria-label^="Options for"]').click(); await page.getByRole('button', { name: 'Add / edit lyrics', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('lyrics-editor-text').readOnly); assert.equal(await page.locator('#lyrics-editor-text').inputValue(), 'My own words');
      await noErrors(errors);
    } finally { release(); await context.close(); }
  });
  await check('album artist: correct identity, complete catalog pages, album detail and download', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    const pages = [];
    const album = (i) => ({ id: `album-${i}`, name: `Catalog album ${i}`, artists: { primary: [{ id: 'correct', name: 'Correct artist' }] }, image: [{ quality: '150x150', url: origin + '/art.svg' }] });
    try {
      await searchMock(context, (url) => {
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [{ id: 'similar', name: 'Correct artist orchestra' }, { id: 'correct', name: 'Correct artist' }] } } };
        if (url.pathname.endsWith('/search/albums')) return { json: { data: { results: [{ id: 'title-match', name: 'Direct album title' }] } } };
        if (url.pathname.endsWith('/artists/correct/albums')) {
          const p = Number(url.searchParams.get('page')); pages.push(p);
          return { json: { data: { total: 5, albums: (p === 0 ? [0, 1] : [2, 3, 4]).map(album) } } };
        }
        if (url.pathname.endsWith('/albums')) return { json: { data: { name: 'Catalog album 0', songs: [searchSong('album-track', 'Catalog track', 'Correct artist', 'correct')] } } };
        return;
      });
      await seed(page, []); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-mode [data-mode="albums"]').click();
      await page.locator('#search-query').fill('Correct artist'); await page.locator('#search-query').press('Enter'); await searchSettled(page);
      assert.equal(await page.locator('.album-card').textContent(), '♫Direct album title');
      await page.locator('.search-artist').filter({ has: page.getByText('Correct artist', { exact: true }) }).click(); await searchSettled(page);
      assert.match(await page.locator('.search-section-title').textContent(), /Albums by Correct artist/);
      assert.equal(await page.locator('.album-card').count(), 2);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.album-card').count(), 5);
      assert.deepEqual(pages, [0, 1]);
      assert.equal(await page.locator('.load-more-btn').count(), 0);
      await page.locator('.album-card').first().click(); await page.waitForFunction(() => document.querySelectorAll('#ap-tracks .ap-track').length === 1);
      await page.locator('#ap-actions button').filter({ hasText: 'Download album' }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('musime-songs-meta') || '[]').some((s) => s.saavnId === 'album-track' && s.downloadedAsAlbum));
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('album artist: retry retains albums; duplicate pages stop; empty catalogs and stale results stay safe', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    let fail = true;
    try {
      await searchMock(context, async (url) => {
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [{ id: 'a', name: 'Artist A' }, { id: 'empty', name: 'Artist Empty' }, { id: 'slow', name: 'Artist Slow' }] } } };
        if (url.pathname.endsWith('/search/albums')) return { json: { data: { results: [{ id: 'fresh', name: 'Fresh title match' }] } } };
        if (url.pathname.endsWith('/artists/empty/albums')) return { json: { data: { albums: [], total: 0 } } };
        if (url.pathname.endsWith('/artists/slow/albums')) { await new Promise((r) => setTimeout(r, 600)); return { json: { data: { albums: [{ id: 'stale', name: 'Stale album' }], total: 1 } } }; }
        if (url.pathname.endsWith('/artists/a/albums')) {
          const p = Number(url.searchParams.get('page'));
          if (p === 1 && fail) return { status: 503 };
          return { json: { data: { albums: [{ id: 'saved', name: 'Keep this album' }], total: 5 } } };
        }
      });
      await seed(page, []); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-mode [data-mode="albums"]').click();
      await page.locator('#search-query').fill('Artist'); await page.locator('#search-query').press('Enter'); await searchSettled(page);
      await page.locator('.search-artist').filter({ hasText: 'Artist A' }).click(); await searchSettled(page);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.match(await page.locator('#search-results').textContent(), /Could not load more albums/);
      assert.equal(await page.locator('.album-card').count(), 1);
      fail = false; await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.album-card').count(), 1); assert.equal(await page.locator('.load-more-btn').count(), 0);
      await page.locator('.search-back').click(); await searchSettled(page);
      await page.locator('.search-artist').filter({ hasText: 'Artist Empty' }).click(); await searchSettled(page);
      assert.match(await page.locator('#search-results').textContent(), /No albums are currently available/);
      await page.locator('.search-back').click(); await searchSettled(page);
      await page.locator('.search-artist').filter({ hasText: 'Artist Slow' }).click();
      await page.locator('#search-query').fill('Fresh'); await page.locator('#search-query').press('Enter'); await searchSettled(page); await page.waitForTimeout(800);
      assert.equal(await page.getByText('Stale album', { exact: true }).count(), 0);
      assert.equal(await page.locator('.album-card .name').textContent(), 'Fresh title match');
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('album artist: catalogs over 100 keep every loaded album reachable with bounded cards', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    try {
      await searchMock(context, (url) => {
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [{ id: 'large', name: 'Large artist' }] } } };
        if (url.pathname.endsWith('/artists/large/albums')) {
          const p = Number(url.searchParams.get('page'));
          return { json: { data: { total: 150, albums: Array.from({ length: 50 }, (_, i) => ({ id: `large-${p * 50 + i}`, name: `Album ${p * 50 + i}` })) } } };
        }
      });
      await seed(page, []); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-mode [data-mode="albums"]').click();
      await page.locator('#search-query').fill('Large artist'); await page.locator('#search-query').press('Enter'); await searchSettled(page);
      await page.locator('.search-artist').click(); await searchSettled(page);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.album-card').count(), 100);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.album-card').count(), 50);
      assert.equal(await page.locator('.album-card .name').first().textContent(), 'Album 100');
      await page.locator('#search-results .collection-pager button').first().click();
      assert.equal(await page.locator('.album-card').count(), 100);
      assert.equal(await page.locator('.album-card .name').first().textContent(), 'Album 0');
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('previous: single press replays; double press navigates across mini, full and media controls', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await page.addInitScript(() => {
        window.__mediaActions = {};
        if (navigator.mediaSession) {
          const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
          navigator.mediaSession.setActionHandler = (action, handler) => { window.__mediaActions[action] = handler; return original(action, handler); };
        }
      });
      await seed(page, library(3)); await clickMode(page, 'songs');
      await page.locator('.song-main').nth(2).click();
      await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').readyState >= 2);
      const originalSrc = await page.locator('#audio').getAttribute('src');
      await page.locator('#audio').evaluate((a) => a.currentTime = 30);
      await page.locator('#mini-prev').click();
      assert.equal(await page.locator('#mini-title').textContent(), 'Song 00002');
      assert.ok(await page.locator('#audio').evaluate((a) => a.currentTime < 2 && !a.paused));
      assert.equal(await page.locator('#audio').getAttribute('src'), originalSrc, 'Replay must not reload a healthy audio source');
      await page.waitForTimeout(900);
      await page.locator('#audio').evaluate((a) => { a.pause(); a.currentTime = 25; });
      await page.locator('#mini-prev').click();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      assert.ok(await page.locator('#audio').evaluate((a) => a.currentTime < 2));
      assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('musime-playback-state')).currentTime < 2));
      await page.waitForTimeout(900);
      await page.locator('#mini-prev').dblclick();
      await page.waitForFunction(() => document.getElementById('mini-title').textContent === 'Song 00001');
      await page.locator('#mini-title').click();
      await page.locator('#np-prev').click();
      assert.equal(await page.locator('#np-title').textContent(), 'Song 00001');
      await page.locator('#np-prev').click();
      await page.waitForFunction(() => document.getElementById('mini-title').textContent === 'Song 00000');
      await page.locator('#np-close').click();
      await page.evaluate(() => window.__mediaActions.previoustrack());
      assert.equal(await page.locator('#mini-title').textContent(), 'Song 00000');
      await page.evaluate(() => window.__mediaActions.previoustrack());
      await page.waitForFunction(() => document.getElementById('mini-title').textContent === 'Song 00002');
      // Next or a newly selected track must invalidate the preceding press.
      await page.locator('#mini-prev').click();
      await page.locator('.song-main').nth(1).click();
      await page.waitForFunction(() => document.getElementById('mini-title').textContent === 'Song 00001');
      await page.locator('#mini-prev').click();
      assert.equal(await page.locator('#mini-title').textContent(), 'Song 00001');
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: title relevance, versions, safe metadata, preview and download persist', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    try {
      await searchMock(context, (url) => {
        if (!url.pathname.endsWith('/search/songs')) return;
        return { json: { success: true, data: { total: 6, results: [
          searchSong('incidental', 'Different song', 'Nakupenda', 'other', { playCount: 999999999 }),
          searchSong('live', 'Nakupenda (Live)', 'TXC', 'txc', { duration: 90 }),
          searchSong('original', 'Nakupenda', 'TXC', 'txc'), searchSong('duplicate', 'Nakupenda', 'TXC', 'txc'),
          searchSong('unsafe', 'Unsafe result', 'Other', 'other', { downloadUrl: [{ url: 'javascript:alert(1)' }] }),
          searchSong('html', '<img src=x onerror="window.__searchInjected=true">', 'Other'),
        ] } } };
      });
      await seed(page, []); await submitSearch(page, 'Nakupenda'); await searchSettled(page);
      assert.equal(await page.locator('.result-info .title').first().textContent(), 'Nakupenda');
      assert.equal(await page.locator('#search-results .result-item').count(), 4);
      assert.equal(await page.evaluate(() => window.__searchInjected), undefined);
      const row = page.locator('.result-item').first();
      await row.locator('.search-preview').click();
      if (process.env.TEST_BROWSER !== 'webkit') {
        await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => a.id !== 'audio' && !a.paused));
        assert.equal(await page.locator('#audio').evaluate((a) => a.paused), true);
        await row.locator('.search-preview').click();
        assert.equal(await row.evaluate((e) => e.classList.contains('previewing')), false);
      }
      await row.locator('.add-btn').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('musime-songs-meta') || '[]').some((s) => s.saavnId === 'original'));
      assert.equal(await row.locator('.add-btn').textContent(), '✓');
      await row.locator('.add-btn').click();
      assert.equal(await page.locator('#songs .song').count(), 1);
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      assert.equal(await page.locator('#songs .song').count(), 1);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: deeper title retrieval, page zero, retry and bounded pagination', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {}); let failNext = false;
    const pages = [];
    try {
      await searchMock(context, (url) => {
        if (!url.pathname.endsWith('/search/songs')) return;
        const p = Number(url.searchParams.get('page')); pages.push(p);
        if (p === 2 && failNext) return { status: 503 };
        const tracks = Array.from({ length: 30 }, (_, i) => searchSong(`${p}-${i}`, p === 1 && i === 0 ? 'Hidden Gem' : `Other ${p}-${i}`));
        return { json: { data: { total: 999, results: tracks } } };
      });
      await seed(page, []); await submitSearch(page, 'Hidden Gem'); await searchSettled(page);
      assert.deepEqual(pages, [0, 1]);
      assert.equal(await page.locator('.result-info .title').first().textContent(), 'Hidden Gem');
      assert.equal(await page.locator('.result-item').count(), 60);
      failNext = true; await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 60);
      assert.match(await page.locator('#search-results').textContent(), /Could not load more/);
      failNext = false; await page.locator('.load-more-btn').click(); await searchSettled(page);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 120);
      assert.equal(await page.locator('.load-more-btn').count(), 0);
      assert.match(await page.locator('#search-results').textContent(), /closest 120/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: artist identity, similar names, artist-only browsing and catalog pagination', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {}); const catalogPages = [];
    try {
      await searchMock(context, (url) => {
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [
          { id: 'wrong', name: 'Israel Mbonyicyambu' }, { id: 'correct', name: 'Israel Mbonyi' }, { id: {}, name: 'Bad identity' }, null,
        ] } } };
        if (url.pathname.endsWith('/search/songs')) return { json: { data: { total: 1, results: [searchSong('false', 'Israel Mbonyi tribute', 'Other singer', 'wrong')] } } };
        if (url.pathname.endsWith('/artists/correct/songs')) {
          const p = Number(url.searchParams.get('page')); catalogPages.push(p);
          return { json: { data: { total: 4, songs: [searchSong(`correct-${p}`, `Real artist song ${p}`, 'Israel Mbonyi', 'correct'), searchSong(`wrong-${p}`, 'Wrong artist song', 'Other singer', 'wrong')] } } };
        }
      });
      await seed(page, []); await submitSearch(page, 'Israel Mbonyi'); await searchSettled(page);
      assert.equal(await page.locator('.search-artist strong').first().textContent(), 'Israel Mbonyi');
      assert.match(await page.locator('.result-info .title').first().textContent(), /Real artist song/);
      assert.equal(await page.getByText('Wrong artist song', { exact: true }).count(), 0);
      await page.locator('.search-artist').filter({ hasText: 'Israel MbonyiArtist' }).click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 1);
      await page.locator('.load-more-btn').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 2);
      assert.deepEqual(catalogPages, [0, 1]); // reopening uses the bounded metadata cache
      await page.locator('.search-back').click(); await searchSettled(page);
      await page.locator('#search-mode [data-mode="artists"]').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 0);
      assert.equal(await page.locator('.search-artist').count(), 2);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: crowded titles expand candidates; empty artist catalogs keep song pagination available', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    try {
      await searchMock(context, (url) => {
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [{ id: 'same-name', name: 'One' }] } } };
        if (url.pathname.endsWith('/artists/same-name/songs')) return { json: { data: { songs: [], total: 0 } } };
        if (url.pathname.endsWith('/search/songs')) return { json: { data: { total: 90, results: Array.from({ length: 30 }, (_, i) => { const n = Number(url.searchParams.get('page')) * 30 + i; return searchSong(`one-${n}`, 'One', `Singer ${n}`, `singer-${n}`, { playCount: n === 30 ? 100000 : 1 }); }) } } };
      });
      await seed(page, []); await submitSearch(page, 'One'); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 60);
      assert.match(await page.locator('.result-info .meta').first().textContent(), /Singer 30/);
      assert.equal(await page.locator('.load-more-btn').count(), 1);
      assert.equal(await page.locator('.search-artists-compact').count(), 1);
      await page.locator('.search-artist').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 0);
      assert.match(await page.locator('#search-results').textContent(), /No results found/);
      await page.locator('.search-back').click(); await searchSettled(page);
      assert.equal(await page.locator('.load-more-btn').count(), 1);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: stalled requests hit the overall deadline and release the loading state', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    try {
      await context.route('**/api/**', () => {});
      await seed(page, []); await page.locator('#splash').waitFor({ state: 'hidden' });
      await page.clock.install();
      const request = page.waitForRequest((r) => r.url().includes('/api/search/songs'));
      await submitSearch(page, 'stalled'); await request;
      await page.clock.fastForward(19000); await searchSettled(page);
      assert.match(await page.locator('#search-results').textContent(), /Search took too long/);
      assert.equal(await page.locator('.search-retry').count(), 1);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: slow old queries, clearing input and album mode cannot overwrite newer results', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {});
    try {
      await searchMock(context, async (url) => {
        const q = url.searchParams.get('query');
        if (q === 'slow' || url.pathname.endsWith('/search/albums')) await new Promise((r) => setTimeout(r, 700));
        if (url.pathname.endsWith('/search/albums')) return { json: { data: { results: [{ id: 'old', name: 'Stale album' }] } } };
        if (url.pathname.endsWith('/search/songs')) return { json: { data: { results: [searchSong(q, q)] } } };
      });
      await seed(page, []); await submitSearch(page, 'slow');
      await page.locator('#search-query').fill('latest'); await page.locator('#search-query').press('Enter'); await searchSettled(page);
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.result-info .title').textContent(), 'latest');
      await page.locator('#search-mode [data-mode="albums"]').click();
      await page.locator('#search-mode [data-mode="songs"]').click(); await searchSettled(page); await page.waitForTimeout(900);
      assert.equal(await page.locator('.album-card').count(), 0);
      assert.equal(await page.locator('.result-info .title').textContent(), 'latest');
      await page.locator('#search-query').fill('slow'); await page.locator('#search-query').press('Enter'); await page.locator('#search-query').fill('');
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.result-item').count(), 0);
      assert.match(await page.locator('#search-results').textContent(), /Search for any song/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('search: outages, malformed mirrors, offline library and narrow layouts recover safely', async () => {
    const { context, page, errors } = await contextPage(process.env.TEST_BROWSER === 'webkit' ? { serviceWorkers: 'block' } : {}); let working = false;
    try {
      await searchMock(context, (url) => {
        if (!working) return { status: 503 };
        if (url.hostname === 'jiosavan-api2.vercel.app') return { json: { data: { results: 'malformed' } } };
        if (url.pathname.endsWith('/search/artists')) return { json: { data: { results: [] } } };
        return { json: { data: { results: [null, {}, searchSong('recovered', 'Recovered song', 'Very long artist '.repeat(15))] } } };
      });
      await seed(page, [{ ...library(1)[0], title: 'Offline match' }]);
      await submitSearch(page, 'Recovered'); await searchSettled(page);
      assert.match(await page.locator('#search-results').textContent(), /temporarily unavailable/);
      assert.equal(await page.locator('.search-retry').count(), 1);
      working = true; await page.locator('.search-retry').click(); await searchSettled(page);
      assert.equal(await page.locator('.result-item').count(), 1);
      for (const width of [280, 320, 390, 900]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.querySelector('#view-search').scrollWidth <= document.querySelector('#view-search').clientWidth), true);
      }
      if (process.env.TEST_BROWSER !== 'webkit') await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true);
      await submitSearch(page, 'Offline match'); await searchSettled(page);
      assert.match(await page.locator('#search-results').textContent(), /You're offline/);
      assert.equal(await page.locator('.search-local-song').count(), 1);
      if (process.env.TEST_BROWSER !== 'webkit') {
        await page.locator('.search-local-song').click(); await page.waitForFunction(() => !document.getElementById('audio').paused);
      }
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('edge-to-edge Home and lyrics, safe-area controls, scroll and rotation', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(40));
      await page.locator('#splash').waitFor({ state: 'hidden' });
      await page.evaluate(() => {
        const root = document.documentElement.style;
        root.setProperty('--safe-top', '47px');
        root.setProperty('--safe-bottom', '34px');
        root.setProperty('--tab-pad-bottom', '34px');
        root.setProperty('--lyr-color', 'rgb(165, 63, 33)');
      });
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const nav = await page.locator('.tab-bar').boundingBox();
        assert.ok(Math.abs(nav.y + nav.height - viewport.height) < 1);
        const tab = await page.locator('.tab').first().boundingBox();
        assert.ok(tab.y + tab.height <= viewport.height - 34);
        const header = await page.locator('.home-header').boundingBox();
        await page.locator('#view-home').evaluate((e) => e.scrollTop = 500);
        assert.deepEqual(await page.locator('.tab-bar').boundingBox(), nav);
        assert.equal((await page.locator('.home-header').boundingBox()).y, header.y);
        assert.equal(await page.evaluate(() => window.scrollY), 0);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(25, 25, 25)');
        await page.evaluate(() => {
          document.querySelector('#lf-title').textContent = 'Offline lyrics';
          document.querySelector('#lyrics-full').classList.remove('hidden');
        });
        await page.locator('#lyrics-full').evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
        const lyrics = await page.locator('#lyrics-full').boundingBox();
        assert.ok(Math.abs(lyrics.x) < 1 && Math.abs(lyrics.y) < 1);
        assert.ok(Math.abs(lyrics.width - viewport.width) < 1 && Math.abs(lyrics.height - viewport.height) < 1);
        const play = await page.locator('#lf-play').boundingBox();
        assert.ok(play.y + play.height <= viewport.height - 34);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(165, 63, 33)');
        assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight - 1).id), 'lyrics-full');
        if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'edge-to-edge-lyrics.png') });
        await page.locator('#lf-close').click();
        assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight - 1).closest('.tab-bar') !== null), true);
        if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'edge-to-edge-home.png') });
      }
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('10,000 songs: bounded DOM, pagination, filters, albums, artists, playlists', async () => {
    const { context, page, errors } = await contextPage();
    try {
      const start = Date.now();
      await seed(page, library(10000));
      const bootMs = Date.now() - start;
      assert.equal(await page.locator('#songs .song').count(), 100);
      assert.equal(await page.evaluate(() => window.__fullBlobReads), 0, 'Startup read the entire audio store');
      assert.match(await page.locator('#home-library-note').textContent(), /^10000 songs/);
      const nodes = await page.locator('*').count(); assert.ok(nodes < 5000, `DOM has ${nodes} nodes`);
      await page.screenshot({ path: path.join(output, `${process.env.TEST_BROWSER || 'chromium'}-large-home.png`) });
      await clickMode(page, 'songs');
      await page.locator('#songs .collection-pager button').last().click();
      assert.equal(await page.locator('#songs .song-title').first().textContent(), 'Song 00100');
      await page.locator('#home-options-toggle').click();
      await page.locator('#search-input').fill('Song 09999');
      assert.equal(await page.locator('#songs .song').count(), 1);
      await page.locator('#search-input').fill('');
      for (const sort of ['title', 'artist', 'recent', 'most-played', 'newest']) await page.locator('#sort-select').selectOption(sort);
      await page.locator('#favorites-toggle').click(); assert.equal(await page.locator('#songs .song').count(), 3);
      await page.locator('#favorites-toggle').click();
      await clickMode(page, 'albums'); assert.equal(await page.locator('#home-albums .home-album').count(), 100);
      await page.locator('#home-albums .collection-pager button').last().click();
      assert.equal(await page.locator('#home-albums .home-album').first().getAttribute('aria-label'), 'Album 100, Artist 100');
      await clickMode(page, 'artists'); assert.equal(await page.locator('.artist-row').count(), 100);
      await page.locator('#lib-collection .collection-pager button').last().click(); assert.equal(await page.locator('.artist-row').count(), 100);
      await page.locator('[data-view="view-playlists"]').click(); assert.equal(await page.locator('.playlist-card').count(), 100);
      await page.locator('#playlists .collection-pager button').last().click(); assert.equal(await page.locator('.playlist-card').count(), 100);
      await noErrors(errors);
      await searchMock(context, () => ({ json: { data: { results: [], total: 0 } } }));
      const searchStart = Date.now();
      await submitSearch(page, 'Song'); await searchSettled(page);
      const searchMs = Date.now() - searchStart;
      assert.equal(await page.locator('.search-local-song').count(), 5);
      assert.ok(searchMs < 5000, `Search of 10,000 downloaded songs took ${searchMs}ms`);
      await page.locator('[data-view="view-home"]').click(); await clickMode(page, 'songs');
      await page.screenshot({ path: path.join(output, 'large-library.png') });
      return { bootIncludingFixtureSetupMs: bootMs, libraryReadyMs: await page.evaluate(() => performance.getEntriesByName("musime-library-ready")[0]?.startTime), domNodes: nodes, songRows: 100, totalSongs: 10000 };
    } finally { await context.close(); }
  });
  await check('205-track album keeps all tracks reachable and album order across pages', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(205, { oneAlbum: true }));
      await page.locator('#home-albums .home-album').click(); assert.equal(await page.locator('#ap-tracks .ap-track').count(), 100);
      await page.locator('#ap-tracks .collection-pager button').last().click();
      assert.match(await page.locator('#ap-tracks .ap-track').first().textContent(), /^101/);
      await page.locator('#ap-tracks .collection-pager button').last().click(); assert.equal(await page.locator('#ap-tracks .ap-track').count(), 5);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('empty library, one song, and a no-results filter', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] }); assert.equal(await page.locator('#home-shuffle').isDisabled(), true);
      await page.locator('.home-empty button').click(); assert.equal(await page.locator('#view-search').isVisible(), true);
      await seed(page, library(1));
      // A single song's release metadata must not create a saved album.
      assert.equal(await page.locator('.home-album').count(), 0);
      assert.equal(await page.locator('#songs .song').count(), 1);
      await clickMode(page, 'songs'); await page.locator('#home-options-toggle').click(); await page.locator('#search-input').fill('nothing like this');
      assert.match(await page.locator('#songs').textContent(), /No matching downloads/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('long names, emoji, RTL, HTML-like text, bad covers; widths 280–1440', async () => {
    const { context, page, errors } = await contextPage();
    try {
      const list = library(8);
      const hostile = '<img src=x onerror="window.__injected=1">';
      list[0].title = hostile; list[0].artist = '__proto__'; list[0].album = hostile;
      list[1].title = '🎵 مرحبا 世界 ' + 'LongUnbrokenTitle'.repeat(25); list[1].artist = 'Artist'.repeat(70); list[1].album = 'Album'.repeat(80);
      await seed(page, list, { playlists: ['All songs', hostile, 'Playlist'.repeat(80)] });
      for (const width of [280, 320, 360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        for (const mode of ['all', 'songs', 'albums', 'artists']) {
          await clickMode(page, mode);
          const sizes = await page.locator('#view-home').evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
          assert.ok(sizes.scroll <= sizes.client + 1, `${mode} overflow at ${width}: ${JSON.stringify(sizes)}`);
        }
        await page.locator('[data-view="view-playlists"]').click();
        const sizes = await page.locator('#view-playlists').evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
        assert.ok(sizes.scroll <= sizes.client + 1, `playlist overflow at ${width}`);
        await page.locator('[data-view="view-home"]').click();
      }
      assert.equal(await page.evaluate(() => window.__injected), undefined);
      assert.equal(await page.locator('#songs .song-main img').count(), 0);
      await noErrors(errors);
      await page.setViewportSize({ width: 320, height: 844 }); await clickMode(page, 'songs');
      await page.screenshot({ path: path.join(output, 'long-titles-320.png') });
    } finally { await context.close(); }
  });
  await check('damaged records and corrupted localStorage values do not crash startup', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [null, false, 4, {}, { id: 'valid', title: 42, artist: {}, album: 99, playlists: 'bad' }, { id: 'valid', title: 'duplicate' }], { playlists: ['All songs', null, 3, '__proto__'], orders: { '__proto__': 5 } });
      assert.equal(await page.locator('#songs .song').count(), 1);
      assert.equal(await page.locator('.song-title').textContent(), 'Untitled');
      await page.evaluate(() => { localStorage.setItem('musime-songs-meta', '{broken'); localStorage.setItem('musime-playlists', '{broken'); localStorage.setItem('musime-debug-log', '{}'); });
      await page.reload(); await page.waitForTimeout(300);
      assert.equal(await page.locator('.home-empty').count(), 1);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('missing audio and corrupt artwork stay manageable without fake offline counts', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(3), { missingAudio: true });
      assert.match(await page.locator('#home-library-note').textContent(), /^0 songs/);
      await clickMode(page, 'songs'); assert.equal(await page.locator('#songs .song-missing').count(), 3);
      await page.locator('.song-main').first().click(); await page.waitForFunction(() => document.getElementById('toast').textContent.includes('not found')); assert.match(await page.locator('#toast').textContent(), /not found/);
      await seed(page, library(3), {corruptArtwork:true});
      await page.locator('#home-recent img.artwork-unavailable').waitFor({state:'attached'});
      assert.equal(await page.locator('#home-recent .home-track').count(),3);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('blocked device storage and metadata quota errors have recoverable UI', async () => {
    for (const blocked of ['indexedDB', 'metadata-quota', 'localStorage']) {
      const { context, page, errors } = await contextPage();
      try {
        await page.addInitScript((blocked) => {
          if (blocked === 'indexedDB') Object.defineProperty(window, 'indexedDB', { configurable:true, value: { open: () => { throw new DOMException('Blocked', 'SecurityError'); } } });
          if (blocked !== 'indexedDB') Object.defineProperty(window, 'localStorage', { configurable:true, value: { getItem: () => { if (blocked === 'localStorage') throw new DOMException('Blocked','SecurityError'); return null; }, setItem: () => { throw new DOMException('Quota','QuotaExceededError'); }, removeItem: () => {} } });
        }, blocked);
        await page.goto(origin); await page.waitForTimeout(400);
        await page.locator('[aria-label="Settings"]').click();
        await page.locator('#file-input').setInputFiles({ name: 'storage-test.wav', mimeType: 'audio/wav', buffer: audio });
        try { await page.waitForFunction(() => document.getElementById('toast').textContent.includes('could not be saved')); } catch (error) { console.log('Storage failure diagnostic', blocked, await page.locator('#toast').textContent(), errors); throw error; }
        assert.match(await page.locator('#toast').textContent(), /could not be saved/);
        await page.locator('[data-view="view-home"]').click(); assert.equal(await page.locator('#songs .song').count(), 0);
        await noErrors(errors);
      } finally { await context.close(); }
    }
  });
  await check('failed search, bad audio responses, empty files, and offline search', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(2));
      await page.locator('[data-view="view-search"]').click(); await page.locator('#search-query').fill('network failure'); await page.locator('#search-query').press('Enter');
      await page.waitForFunction(() => document.getElementById('search-results').textContent.includes('temporarily unavailable'));
      await page.locator('[data-view="view-home"]').click(); await page.locator('[aria-label="Settings"]').click();
      for (const name of ['fail.mp3', 'error.mp3', 'empty.mp3']) {
        await page.locator('#song-url').fill(`${origin}/${name}`); await page.locator('#song-title').fill('Must not save'); await page.locator('#url-form button').click();
        await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Could not download'));
      }
      assert.equal(await page.locator('#songs .song').count(), 2);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-query').fill('offline'); await page.locator('#search-query').press('Enter');
      assert.match(await page.locator('#search-results').textContent(), /You're offline/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('track menu remains usable in landscape and with reduced motion', async () => {
    const { context, page, errors } = await contextPage({ viewport: {width:568,height:320}, reducedMotion:'reduce' });
    try {
      await seed(page, library(3)); await clickMode(page, 'songs'); await page.locator('#songs .actions button').first().click();
      await page.locator('#song-actions-list button').filter({hasText:'Add to playlist'}).click();
      await page.locator('#sheet-close').click();
      assert.equal(await page.locator('#playlist-sheet').isVisible(), false); await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('duplicate download clicks do not create duplicate songs', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await context.route('**/search/songs?**', (route) => route.fulfill({ headers: {'Access-Control-Allow-Origin':'*'}, json: { data: { results: [{id:'unique',name:'Unique song',duration:60,album:{id:'unique',name:'Unique single'},artists:{primary:[{name:'Test artist'}]},downloadUrl:[{quality:'160kbps',url:origin+'/audio.wav'}]}] } } }));
      await seed(page, []); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-query').fill('unique'); await page.locator('#search-query').press('Enter');
      await page.locator('#search-results .add-btn').click(); await page.waitForFunction(() => document.querySelectorAll('#songs .song').length === 1);
      await page.locator('#search-results .add-btn').click(); await page.waitForTimeout(500);
      assert.equal(await page.locator('#songs .song').count(), 1); await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('corrupt audio stops recovery after two retries and leaves Home usable', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(1));
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => { const r = indexedDB.open('musime-db', 1); r.onsuccess = () => resolve(r.result); });
        await new Promise((resolve) => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').put({data:new TextEncoder().encode('not a music file').buffer,type:'audio/wav'},'s0'); tx.oncomplete=resolve; }); db.close();
      });
      await clickMode(page,'songs'); await page.locator('.song-main').click();
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Cannot play this audio'));
      assert.equal(await page.locator('#audio').evaluate((a)=>a.paused),true);
      assert.equal(await page.locator('.song-missing').count(),1);
      await page.locator('[data-view="view-playlists"]').click(); assert.equal(await page.locator('#view-playlists').isVisible(),true);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('stalled downloads time out instead of leaving the UI busy', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, []); await page.clock.install();
      await page.locator('[aria-label="Settings"]').click();
      await page.locator('#song-url').fill(`${origin}/stall.mp3`); await page.locator('#song-title').fill('Stalled song'); await page.locator('#url-form button').click();
      await page.waitForTimeout(100); await page.clock.fastForward(31000);
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Could not download'));
      assert.equal(await page.locator('#songs .song').count(), 0); await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('device import: audio-extension Files chooser and unfiltered fallback import genuine MP3s with playback', async () => {
    const { context, page, errors } = await contextPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    try {
      await seed(page, [], { playlists: ['All songs'] });
      await page.locator('[aria-label="Settings"]').click();
      // This is the filter regression: setInputFiles alone bypasses accept and
      // cannot prove that iOS's Files UI will leave audio files selectable.
      assert.match(await page.locator('#file-input').getAttribute('accept'), /\.mp3/);
      assert.doesNotMatch(await page.locator('#file-input').getAttribute('accept'), /audio\/\*|video/);
      const choosing = page.waitForEvent('filechooser');
      await page.locator('label[for="file-input"]').click();
      const chooser = await choosing;
      assert.equal(chooser.isMultiple(), true);
      await chooser.setFiles(path.join(root, 'tests/fixtures/import-tone.mp3'));
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent === '1 song imported to Home.');
      await page.locator('#import-show-all').check();
      assert.equal(await page.locator('#file-input').getAttribute('accept'), null);
      await page.locator('#file-input').setInputFiles({ name: 'Generic provider.MP3', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(root, 'tests/fixtures/import-tone.mp3')) });
      await page.waitForFunction(() => document.getElementById('device-import-status').getAttribute('aria-busy') === 'false' && JSON.parse(localStorage.getItem('musime-songs-meta')).length === 2);
      const metadata = await page.evaluate(() => JSON.parse(localStorage.getItem('musime-songs-meta')));
      assert.equal(metadata.length, 2); assert.equal(metadata[0].title, 'MP3 import check'); assert.equal(metadata[0].artist, 'MusiMe test tone');
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      assert.match(await page.locator('#file-input').getAttribute('accept'), /\.mp3/);
      await clickMode(page, 'songs');
      assert.match(await page.locator('#songs').textContent(), /MP3 import check/);
      if ((process.env.TEST_BROWSER || 'chromium') === 'chromium') {
        await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
        await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true'); await clickMode(page, 'songs');
        await page.locator('.song-main').first().click();
        await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2);
      }
      await noErrors(errors);
      return { mp3Bytes: fs.statSync(path.join(root, 'tests/fixtures/import-tone.mp3')).size, physicalIPhonePickerVerified: false };
    } finally { await context.close(); }
  });
  await check('device import: Files MP3 tags, custom and generated covers persist offline; invalid files do not block a batch', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] });
      await page.locator('[aria-label="Settings"]').click();
      const frames = Buffer.concat([['TIT2', 'Tagged song'], ['TPE1', 'Tagged artist']].map(([id, text]) => {
        const value = Buffer.from('\x03' + text), header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(value.length, 4);
        return Buffer.concat([header, value]);
      }));
      const tagHeader = Buffer.from([73,68,51,3,0,0,0,0,frames.length >>> 7, frames.length & 127]);
      await page.locator('#file-input').setInputFiles([
        { name: 'wrong filename.mp3', mimeType: 'application/octet-stream', buffer: Buffer.concat([tagHeader, frames, audio]) },
        { name: 'empty.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(0) },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not music') },
        { name: 'Video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video data') },
        { name: 'Another.wav', mimeType: 'audio/wav', buffer: audio },
      ]);
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent.includes('2 songs imported to Home. 3 failed.'));
      assert.match(await page.locator('#device-import-status').textContent(), /Use Import audio from video/);
      await page.locator('#import-cover-input').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64') });
      await page.locator('#file-input').setInputFiles({ name: 'Custom.wav', mimeType: 'audio/wav', buffer: audio });
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent === '1 song imported to Home.');
      assert.equal(await page.locator('#file-input').isEnabled(), true);
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      const saved = await page.evaluate(async () => {
        const songs = JSON.parse(localStorage.getItem('musime-songs-meta'));
        const db = await new Promise((resolve) => { const r = indexedDB.open('musime-db', 1); r.onsuccess = () => resolve(r.result); });
        const covers = await Promise.all(songs.map((s) => new Promise((resolve) => { const r = db.transaction('songs').objectStore('songs').get('art-' + s.id); r.onsuccess = () => resolve(r.result?.size || r.result?.data?.byteLength || 0); })));
        db.close(); return { songs, covers };
      });
      assert.equal(saved.songs.length, 3); assert.equal(saved.songs.find((s) => s.title === 'Tagged song').artist, 'Tagged artist');
      assert.ok(saved.covers.every((n) => n > 0));
      assert.ok(saved.songs.every((s) => !s.downloadedAsAlbum));
      await page.locator('[data-view="view-home"]').click();
      await page.waitForFunction(() => [...document.querySelectorAll('#home-recent img')].filter((img) => img.complete && img.naturalWidth > 0).length === 3);
      await page.locator('#splash').waitFor({ state: 'hidden' });
      await page.screenshot({ path: path.join(output, 'device-import-home.png') });
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('device import: quota failure is explained and a later retry succeeds', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] });
      await page.evaluate(() => {
        window.__estimate = navigator.storage?.estimate?.bind(navigator.storage) || (async () => ({}));
        if (!navigator.storage) Object.defineProperty(navigator, 'storage', { configurable: true, value: {} });
        navigator.storage.estimate = async () => ({ quota: 1000, usage: 999 });
      });
      await page.locator('[aria-label="Settings"]').click();
      await page.locator('#file-input').setInputFiles({ name: 'Retry.wav', mimeType: 'audio/wav', buffer: audio });
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent.includes('Not enough storage'));
      assert.equal(await page.locator('#songs .song').count(), 0);
      await page.evaluate(() => navigator.storage.estimate = window.__estimate);
      await page.locator('#file-input').setInputFiles({ name: 'Retry.wav', mimeType: 'audio/wav', buffer: audio });
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent === '1 song imported to Home.');
      assert.equal(await page.locator('#songs .song').count(), 1); await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('device import: unsupported large Blob storage refuses unsafe full-memory fallback', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] }); await page.locator('[aria-label="Settings"]').click();
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (value instanceof File) throw new DOMException('Blob unavailable', 'DataCloneError');
          return put.call(this, value, ...args);
        };
        const f = new File(['audio'], 'Large.mp3', { type: 'audio/mpeg' });
        Object.defineProperty(f, 'size', { value: 40 * 1024 * 1024 });
        // Only slices may be read. The simulated large file must never be read.
        f.arrayBuffer = () => { throw new Error('Unsafe whole-file fallback'); };
        const list = new DataTransfer(); list.items.add(f);
        document.getElementById('file-input').files = list.files;
        document.getElementById('file-input').dispatchEvent(new Event('change'));
      });
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent.includes('cannot safely store this large file'));
      assert.equal(await page.locator('#songs .song').count(), 0);
      assert.equal(await page.locator('#file-input').isEnabled(), true); await noErrors(errors);
    } finally { await context.close(); }
  });
  if (process.env.TEST_LARGE_IMPORT) await check('device import: actual 1 GiB file stores without whole-file JS reads and survives reload', async () => {
    const { context, page, errors } = await contextPage();
    const filename = path.join(output, 'large-import.wav'), bytes = 1024 ** 3;
    try {
      const fd = fs.openSync(filename, 'w');
      try { fs.ftruncateSync(fd, bytes); const header = Buffer.from(audio.subarray(0, 44)); header.writeUInt32LE(bytes - 8, 4); header.writeUInt32LE(bytes - 44, 40); fs.writeSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      await seed(page, [], { playlists: ['All songs'] });
      // Incognito's default temporary quota may be below 1 GiB. Grant this
      // isolated test origin enough space; production still obeys device quota.
      if ((process.env.TEST_BROWSER || 'chromium') === 'chromium') {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 3 * 1024 ** 3 });
      }
      await page.evaluate(() => {
        const read = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function () { if (this.size > 2 * 1024 * 1024) throw new Error('Whole audio read forbidden'); return read.call(this); };
      });
      await page.locator('[aria-label="Settings"]').click(); await page.locator('#file-input').setInputFiles(filename);
      await page.waitForFunction(() => document.getElementById('device-import-status').textContent.includes('imported to Home.'), null, { timeout: 180000 });
      assert.equal(await page.locator('#device-import-status').textContent(), '1 song imported to Home.');
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      const size = await page.evaluate(async () => {
        const song = JSON.parse(localStorage.getItem('musime-songs-meta'))[0];
        const db = await new Promise((resolve) => { const r = indexedDB.open('musime-db', 1); r.onsuccess = () => resolve(r.result); });
        const blob = await new Promise((resolve) => { const r = db.transaction('songs').objectStore('songs').get(song.id); r.onsuccess = () => resolve(r.result); });
        db.close(); return blob.size;
      });
      assert.equal(size, bytes);
      if ((process.env.TEST_BROWSER || 'chromium') === 'chromium') {
        await clickMode(page, 'songs'); await page.locator('.song-main').click();
        await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2);
      }
      await noErrors(errors); return { persistedBytes: size };
    } finally { await context.close(); if (fs.existsSync(filename)) fs.unlinkSync(filename); }
  });
  await check('real import saves audio and survives reload, including the Blob-storage fallback', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, [], { playlists: ['All songs'] }); await page.locator('[aria-label="Settings"]').click();
      await page.locator('#file-input').setInputFiles({ name: 'Imported music.wav', mimeType: 'audio/wav', buffer: audio });
      await page.waitForFunction(() => document.querySelectorAll('#songs .song').length === 1);
      await page.reload(); await page.waitForFunction(() => document.body.dataset.libraryReady === 'true');
      assert.match(await page.locator('#home-library-note').textContent(), /^1 song/);
      await clickMode(page, 'songs'); if (process.env.TEST_BROWSER === 'webkit') { await noErrors(errors); return { playback: 'Imported audio persists; audio output is not asserted on Windows WebKit. Physical iOS check required.' }; }
      await page.locator('.song-main').click();
      await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('250-track remote album and bulk download queue keep a bounded UI', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await context.route('**/search/albums?**', (route) => route.fulfill({ headers: {'Access-Control-Allow-Origin':'*'}, json: { data: { results: [{ id: 'bulk', name: 'Bulk album', artists: { primary: [{ name: 'Test artist' }] }, image: [] }] } } }));
      await context.route('**/albums?id=bulk', (route) => route.fulfill({ headers: {'Access-Control-Allow-Origin':'*'}, json: { data: { name: 'Bulk album', songs: Array.from({length:250}, (_, i) => ({ id: 'bulk'+i, name: 'Bulk song '+i, duration:60, album:{id:'bulk',name:'Bulk album'}, artists:{primary:[{name:'Test artist'}]}, downloadUrl:[{quality:'160kbps',url:origin+'/stall.mp3'}] })) } } }));
      await seed(page, []); await page.locator('[data-view="view-search"]').click(); await page.locator('#search-mode [data-mode="albums"]').click(); await page.locator('#search-query').fill('bulk'); await page.locator('#search-query').press('Enter');
      await page.locator('#search-results .album-card').click(); await page.waitForFunction(() => document.querySelectorAll('#ap-tracks .ap-track').length === 100);
      await page.locator('#ap-actions button').first().click();
      assert.equal(await page.locator('#download-queue .queue-item').count(), 20);
      assert.match(await page.locator('#download-queue').textContent(), /more downloads queued/);
      await noErrors(errors);
    } finally { await context.close(); }
  });
  await check('cached offline reload and playback after network loss', async () => {
    const { context, page, errors } = await contextPage();
    try {
      await seed(page, library(3));
      await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true);
      await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#songs .song').length === 3);
      await clickMode(page, 'songs'); await page.locator('.song-main').first().click();
      await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2);
      assert.equal(await page.locator('#mini-art').evaluate((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0), true);
      await page.locator('#mini-next').click(); await page.waitForFunction(() => document.getElementById('mini-title').textContent === 'Song 00001');
      await page.locator('#mini-play').click(); await noErrors(errors);
    } finally { await context.close(); }
  });
}
async function runUpgrades() {
  await check('legacy installed PWA upgrades without losing audio, artwork, playlists, or favorites', async () => {
    release = 'legacy'; version = build; failedAsset = '';
    const { context, page } = await contextPage();
    try {
      await page.goto(origin + '/MusiMe/');
      await page.evaluate(async ({ list, svg }) => {
        try { localStorage.setItem('musime-songs-meta', JSON.stringify(list)); } catch (error) { throw new Error(`Fixture metadata: ${error.name}: ${error.message}; JSON characters ${JSON.stringify(list).length}`); } localStorage.setItem('musime-playlists', '["All songs","Keep me"]');
        const db = await new Promise((resolve) => { const r = indexedDB.open('musime-db', 1); r.onsuccess = () => resolve(r.result); });
        const fixtureAudio = await fetch(new URL("audio.wav", location.href)).then((r) => r.blob());
        await new Promise((resolve) => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').put(fixtureAudio, 's0'); tx.objectStore('songs').put(new Blob([svg], { type: 'image/svg+xml' }), 'art-s0'); tx.oncomplete = resolve; }); db.close();
        await navigator.serviceWorker.ready;
      }, { list: library(1), svg });
      await page.reload();
      const before = await storageSnapshot(page);
      release = 'current';
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
      await page.waitForFunction(() => !!document.getElementById('view-home'), { timeout: 20000 });
      await page.waitForTimeout(500);
      assert.deepEqual(await storageSnapshot(page), before);
      await page.waitForFunction((expected) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 300);
        const listener = (event) => { if (event.data?.type === "MUSIME_VERSION") { clearTimeout(timer); navigator.serviceWorker.removeEventListener("message", listener); resolve(event.data.version === expected); } };
        navigator.serviceWorker.addEventListener("message", listener); navigator.serviceWorker.controller?.postMessage({ type: "GET_VERSION" });
      }), build);
      await page.close();
      await context.setOffline(true);
      const offlinePage = await context.newPage();
      await offlinePage.goto(origin + '/MusiMe/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await offlinePage.waitForFunction(() => document.querySelectorAll('#songs .song').length === 1);
      await clickMode(offlinePage, 'songs'); await offlinePage.locator('.song-main').click(); await offlinePage.waitForFunction(() => !document.getElementById('audio').paused);
    } finally { await context.close(); release = 'current'; }
  });
  await check('failed release stays on last complete shell; two later updates do not interrupt playback', async () => {
    const { context, page, errors } = await contextPage();
    try {
      version = build; await seed(page, library(2)); await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.evaluate(async () => { const c = await caches.open('another-app-cache'); await c.put('/keep', new Response('safe')); });
      const before = await storageSnapshot(page);
      failedAsset = 'styles.css'; version = '2026.10.23.broken';
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); } catch {} });
      await page.waitForTimeout(700);
      await context.setOffline(true); await page.reload(); await page.waitForTimeout(500);
      assert.equal(await page.locator('script[src*="app.js"]').getAttribute('src'), `app.js?v=${build}`);
      assert.deepEqual(await storageSnapshot(page), before);
      // Simulated future releases are derived from the current build so they
      // always differ from it, whatever the real version number is.
      const nextRelease = `${build}-next1`, laterRelease = `${build}-next2`;
      await context.setOffline(false); failedAsset = ''; version = nextRelease;
      await clickMode(page, 'songs'); await page.locator('.song-main').first().click(); await page.waitForFunction(() => !document.getElementById('audio').paused);
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
      await page.locator('#app-update-banner').waitFor({ state: 'visible', timeout: 20000 });
      assert.equal(await page.locator('#apply-app-update').isDisabled(), true);
      assert.equal(await page.locator('#audio').evaluate((a) => a.paused), false);
      await page.locator('#mini-play').click(); assert.equal(await page.locator('#apply-app-update').isEnabled(), true);
      await page.locator('#apply-app-update').click();
      await page.waitForFunction((v) => document.querySelector('script[src*="app.js"]').getAttribute('src').includes(v), nextRelease);
      assert.equal(await page.evaluate(() => caches.has('another-app-cache')), true);
      version = laterRelease;
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
      await page.locator('#app-update-banner').waitFor({ state: 'visible', timeout: 20000 }); await page.locator('#apply-app-update').click();
      await page.waitForFunction((v) => document.querySelector('script[src*="app.js"]').getAttribute('src').includes(v), laterRelease);
      assert.deepEqual((await storageSnapshot(page)).bytes, before.bytes);
      await noErrors(errors);
    } finally { await context.close(); version = build; failedAsset = ''; }
  });
}
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.TEST_BROWSER || 'chromium';
  browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.TEST_CHANNEL ? { channel: process.env.TEST_CHANNEL } : {}) });
  try { await runFrontend(); await runUpgrades(); }
  finally {
    fs.writeFileSync(path.join(output, `${engine}${process.env.TEST_MATCH ? "-focused-"+process.env.TEST_MATCH.replace(/[^a-z0-9]+/gi,"-").slice(0,55) : ""}-results.json`), JSON.stringify({ engine, appVersion: build, results, browserResourceDiagnostics }, null, 2));
    await browser.close(); await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error.stack); server.close(); process.exitCode = 1; });
