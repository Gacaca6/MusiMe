# MusiMe PWA

MusiMe is an iPhone-friendly progressive web app for saving songs you have rights to and playing them offline.

## Features

- Save songs from direct audio links (`.mp3`, `.m4a`, etc.)
- Search legal sources in-app (Internet Archive + iTunes previews)
- Auto-ranked results with "Save best match"
- Import songs from your device files
- Offline playback via IndexedDB
- Favorites toggle
- Custom playlists with management (rename/delete)
- Playlist track ordering (select playlist + choose `Playlist order` sort, then use arrows)
- Search by title/artist and sorting options (newest, title, artist, recently played)
- Recently played quick-launch pills
- Cover art + album metadata in search and library
- Background download queue with progress bars and auto-fallback attempts
- Full backup export/import (JSON with song files + metadata)
- Installable PWA shell with service worker caching

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

## Backup and restore

- Tap **Export backup** to download a full `.json` backup file.
- Use **Import backup** to restore your complete library (songs, playlists, favorites, play history).
- Import replaces current local data.
