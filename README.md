# MusiMe PWA

MusiMe is an iPhone-friendly progressive web app for saving songs you have rights to and playing them offline.

## Features

Built offline-first for people with little or expensive internet: download once, play forever with no connection.

**Home: your music, always available offline**
- Opens to your own collection: recently added songs, a recently added album mosaic, and downloaded songs
- Filters for All, Songs, Albums and Artists; album and artist pages play in the right order
- Shuffle all, Create Playlist, favorites, sorting, and edit song info (title, artist, album, track number)
- Floating mini player with previous, play/pause and next

**Search: find and download**
- Search songs and full albums (JioSaavn, with mirror fallback)
- Album pages show track list, length and download size before you download
- Tap any result to hear a short preview first (low-bitrate to save data)
- **Data Saver**: choose Data Saver, Normal (default) or High download quality, with sizes shown

**Playing**
- Lock-screen controls on iPhone (play/pause, previous/next), including resume while locked
- Offline lyrics: synced, Spotify-style, saved on the phone with each song
- Album-colored player, playback speed (0.75×–2×), sleep timer, queue, repeat
- DJ Mix: on-device analysis orders songs by energy and skips silent intros/outros

**Your library, safe**
- Playlists with ordering, plus Import a Song List (paste a list, MusiMe finds and downloads it)
- Library Sync file (metadata only, small) and full backup export/import
- Import from device files or direct audio links
- Installable PWA; updates arrive safely without touching downloaded music

## Important legal note

Only download or import audio you own or are licensed to use (for example: your own files, public-domain audio, or properly licensed links).

This app intentionally avoids DRM bypassing, ripping from protected streaming services, or piracy-only sources.

## Run locally

Service workers need an HTTP server (not `file://`). From this folder:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080` in Safari (or desktop browser for testing).

## Install on iPhone

1. Open the app URL in Safari.
2. Tap Share.
3. Tap **Add to Home Screen**.
4. Launch MusiMe from your Home Screen.

## Storage note

Songs are saved in browser storage (IndexedDB). Clearing Safari website data removes them.

The Home redesign uses the existing `musime-db` database and library metadata keys. Existing downloads and cached covers remain in place when updating the app at the same URL. Album groups use each song's saved album metadata; edit that metadata in Home when imported tracks need organizing. Missing covers use a music placeholder.

## Backup and restore

- Tap **Export backup** to download a full `.json` backup file.
- Use **Import backup** to restore your complete library (songs, playlists, favorites, play history).
- Import replaces current local data.

## Testing and releases

See [TESTING.md](TESTING.md) for the stress-test suite, browser limits, existing-install upgrade checks, and the release procedure. Large collections use 100-item pages. Startup indexes stored file keys and loads artwork on demand, rather than reading every downloaded audio file.

App releases use matching versions in `app.js`, `sw.js`, and the script/stylesheet URLs in `index.html`. Existing installations discover updates when online and reopened or foregrounded; an active session offers **Update now** after playback and downloads finish. Updating the app shell keeps the existing music database and playlists.
