# Home and installed-PWA release checks

## iPhone MP3 picker correction (`2026.11.06.2`)

The default audio input uses explicit audio extensions, including `.mp3`.
It intentionally avoids `audio/*`. WebKit's documented
[iOS audio-picker issue](https://bugs.webkit.org/show_bug.cgi?id=242110) can
leave MP3/audio files disabled when `audio/*` is present. Selection now uses
the extension-filtered Files picker. The **MP3 missing? Show all files** option
removes the filter entirely as a fallback. The importer validates selected files
and explains that videos are unsupported rather than silently ignoring them.
MP3 files with missing/generic MIME types are assigned `audio/mpeg` using a
native Blob slice, without reading the recording into JavaScript memory.

The test fixture is a genuine, generated 32,700-byte MP3 tone with
ID3 metadata. Tests activate the file-chooser event from the visible import
label, assert the absence of the problematic audio wildcard, verify that the
fallback removes the filter, import the genuine MP3
both as a normal file and with a generic MIME type, and verify tag persistence.
Edge also verifies playback after an offline reload. Mobile-size WebKit checks
verify import/persistence; they do not operate an actual iPhone Files picker
or verify its audio output. A physical iPhone has not been available for testing.

Unit results: 17 passing checks. Focused browser reports are written to
`test-results/mp3-picker-final-edge/` and `test-results/mp3-picker-final-webkit/`.
These checks ran locally; production deployment must be verified separately.

## Device import — 6 November 2026 (`2026.11.06.1`)

Settings → Import from device accepts MP3 files with missing/generic MIME types,
reads bounded ID3 title/artist/embedded-cover tags, and stores the original File
directly in IndexedDB. Users may choose a cover for a batch; otherwise embedded
artwork or a locally generated cover is saved offline. Imported singles remain
in Home's Songs collection rather than becoming downloaded albums.

Validation for this change:

- 16 unit checks passed (4 import/tag checks and 12 existing search checks).
- The full Edge suite passed all 31 scenarios, including offline playback and
  installed-app upgrades. Additional focused checks passed for safely rejecting
  an unsupported large-Blob fallback and an actual 1,073,741,824-byte WAV file.
- The 1 GiB file survived reload with the exact stored byte count and began
  playback. The test origin's temporary browser quota was explicitly increased
  via CDP to 3 GiB; with the default insufficient quota, import correctly failed
  without adding a song. This is a desktop storage/playback test, not an iPhone
  memory, disk, or audio-output guarantee.
- Five WebKit checks passed: blocked storage/metadata rollback, mixed MP3 import
  and covers, quota failure/retry, safe large-file fallback rejection, and import
  persistence. Physical iPhone Files-picker and large-file tests remain required.

There is no application file-size limit on native Blob storage. Device quota,
free space, and supported audio formats still apply. Engines requiring the
ArrayBuffer compatibility fallback reject device imports over 32 MiB rather
than allocating the full recording in memory. Optional DJ analysis also skips
recordings over 32 MiB; normal playback remains available. Tag reads are capped
at 2 MiB; oversized/unsupported tags fall back to the filename and generated art.

Run `node --test tests/local-import.test.mjs tests/search-engine.test.mjs`.
For browser checks use the existing instructions below with
`TEST_MATCH='device import:|real import|blocked device storage'`.
Set `TEST_LARGE_IMPORT=1` on Edge to include the real 1 GiB fixture; it is deleted
after the scenario. Reports are in `test-results/import-release-edge/`,
`test-results/import-release-webkit/`, `test-results/import-final-edge/`, and
`test-results/import-final-large/`. These changes have not been deployed.

Tested locally on 23 October 2026. Nothing in this report is a production deployment.

## What the automated suite covers

Run `tests/browser-stress.cjs` with Playwright. Each run starts its own HTTP server and isolated browser contexts, without connecting to the user's browser profile or modifying their downloaded music.

- 10,000 song records, 1,000 albums, 400 artists, and 201 playlists. Lists stay bounded to 100 entries per page; playback queues still include the complete selection. Home retains only 12 recent cards and 8 album previews.
- A 205-track downloaded album and a 250-track remote album, including paging, original track numbers, and a bounded bulk-download queue preview.
- Empty and one-song collections, filtering with no results, sorting, favorites, and duplicate download clicks.
- Widths from 280 to 1440 pixels, long unbroken names, emoji, right-to-left text, HTML-like song/playlist names, and a short landscape viewport with reduced motion.
- Damaged metadata, invalid JSON, unavailable IndexedDB, blocked localStorage, metadata quota failures, missing audio, corrupt covers, and corrupt audio.
- Failed searches, offline searches, HTML responses masquerading as audio, empty downloads, failed downloads, and stalled download timeouts.
- Import persistence, locally stored playback, cached covers, next-track controls, and cold offline launches.
- Upgrade from the repository's deployed version (`dd6fb19`, worker v23) to this release at a `/MusiMe/` URL, with audio/cover hashes, metadata, playlists, and favorites retained.
- Failed release installation preserving the last complete app shell. Two successive updates, an update arriving during playback, and preservation of unrelated origin caches.

The bulk library contains synthetic metadata and small placeholder blobs for rendering/storage scale. Playback uses separate valid PCM fixtures; this does not simulate 10,000 full-size recordings or measure an actual phone's available disk space. Importing the fixture is intentionally excluded from application-startup timing. The suite also asserts that startup never reads the entire audio store with `getAll()`.

Results and screenshots are written into ignored `test-results/`. JSON files identify the browser, every passed/failed/skipped scenario, and measured timings. Focused reruns have separate result files.

## Browser limits

Chromium/Edge runs the full PWA, offline, and upgrade tests. WebKit on Windows runs the frontend and storage checks, including a fallback for engines unable to store native Blob values. Its media backend is not treated as an iPhone audio-output test.

Playwright documents its service-worker tooling as Chromium-only. Its WebKit offline emulation also has a known navigation failure. Those service-worker scenarios are explicitly skipped in WebKit, rather than reported as passes. See [Playwright service workers](https://playwright.dev/docs/service-workers) and [WebKit offline-emulation issue](https://github.com/microsoft/playwright/issues/42775).

A physical iPhone remains necessary to verify installed-mode background/lock-screen audio, interruptions from calls, Bluetooth/headphone route changes, low-memory suspension, safe areas, and the on-device update flow. Browser automation cannot prove those OS-level behaviors. Storage eviction or clearing website data can remove locally downloaded files; the app detects missing audio and retains manageable metadata rather than claiming the files are playable.

## Run the suite

Install Playwright locally without changing this static site's build setup:

```powershell
npm install --no-save --package-lock=false playwright
npx playwright install chromium webkit
node tests/browser-stress.cjs
$env:TEST_BROWSER = 'webkit'
node tests/browser-stress.cjs
```

For an existing Playwright installation, set `PLAYWRIGHT_MODULE` to its absolute module directory. `TEST_CHANNEL=msedge` uses installed Edge for Chromium tests. `TEST_MATCH` runs matching scenario names. `TEST_OUTPUT_DIR` changes the artifact folder.

## Updating existing installations

The live Vercel project `musi-me` is connected to `Gacaca6/MusiMe`; its production deployment was verified against `main` at `dd6fb19`. The existing GitHub Pages deployment also serves worker v23. Both URLs were read successfully; this working tree has not been deployed.

Keep the same origins, paths, manifest start URL, database name (`musime-db`), object store (`songs`), and metadata keys. Existing installed apps keep their downloads in that origin's browser storage. A different domain is a different library.

For each subsequent release:

1. Change `APP_VERSION` in `app.js` and `sw.js`, and update the matching script/stylesheet version queries in `index.html`. Never reuse a released version for different app files.
2. Run the suite, including upgrade checks. The worker installs a release only after every shell asset is cached successfully. The previous release remains usable if installation fails.
3. Commit the intended app files, tests, this report, and `vercel.json`; do not sweep unrelated untracked files into the commit.
4. Push to the existing production branch and wait for successful Vercel and GitHub Pages deployments. A Git push by itself is not proof of a successful deployment.
5. Verify the live `sw.js` version and matching versioned HTML/CSS/JS at both existing installation URLs.
6. Existing apps discover the release when online and opened/foregrounded. An open session running this release shows **Update now** after the new shell is ready; updating is disabled during music playback, previews, and downloads. Closing and reopening uses the activated complete release. Older v23 sessions may need a close/reopen, especially if their old update reload guard has already fired.

`vercel.json` requires revalidation of the service worker, app HTML, and manifest. The worker caches a coherent version of HTML, CSS, and JS, bypasses cross-origin APIs/media, and cleans up only MusiMe shell caches. It never deletes IndexedDB downloads during an app update.

The first launch must have internet long enough to install the offline shell. An app that stays offline cannot receive newly published code until it reconnects. This follows the browser's [service-worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
