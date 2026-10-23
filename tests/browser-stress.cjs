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
const build = '2026.10.23.1';
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
async function runFrontend() {
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
      await seed(page, library(1)); assert.equal(await page.locator('.home-album').count(), 1);
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
      await page.waitForFunction(() => document.getElementById('search-results').textContent.includes('No results'));
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
      await page.waitForFunction(() => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 300);
        const listener = (event) => { if (event.data?.type === "MUSIME_VERSION") { clearTimeout(timer); navigator.serviceWorker.removeEventListener("message", listener); resolve(event.data.version === "2026.10.23.1"); } };
        navigator.serviceWorker.addEventListener("message", listener); navigator.serviceWorker.controller?.postMessage({ type: "GET_VERSION" });
      }));
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
      await context.setOffline(false); failedAsset = ''; version = '2026.10.23.2';
      await clickMode(page, 'songs'); await page.locator('.song-main').first().click(); await page.waitForFunction(() => !document.getElementById('audio').paused);
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
      await page.locator('#app-update-banner').waitFor({ state: 'visible', timeout: 20000 });
      assert.equal(await page.locator('#apply-app-update').isDisabled(), true);
      assert.equal(await page.locator('#audio').evaluate((a) => a.paused), false);
      await page.locator('#mini-play').click(); assert.equal(await page.locator('#apply-app-update').isEnabled(), true);
      await page.locator('#apply-app-update').click();
      await page.waitForFunction(() => document.querySelector('script[src*="app.js"]').getAttribute('src').includes('2026.10.23.2'));
      assert.equal(await page.evaluate(() => caches.has('another-app-cache')), true);
      version = '2026.10.23.3';
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
      await page.locator('#app-update-banner').waitFor({ state: 'visible', timeout: 20000 }); await page.locator('#apply-app-update').click();
      await page.waitForFunction(() => document.querySelector('script[src*="app.js"]').getAttribute('src').includes('2026.10.23.3'));
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
