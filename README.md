# TV Client

![TV Client banner](docs/banner.jpg)

![TV Client screenshot](docs/screenshot01.jpg)

A replacement GUI for online TV platforms — a lightweight desktop client for Windows.
The design is defined in HTML so parts of the original pages integrate easily.

## Architecture (decided)

| Aspect | Choice |
|---|---|
| Runtime | Tauri v2 + WebView2 |
| Target platform | Windows EXE (portable; identifier `com.tvclient.desktop`, data in `%APPDATA%/com.tvclient.desktop/`; always a single instance — a second launch switches to the running window and exits) |
| UI | HTML/JS in `src/` (based on the v2 prototype) |
| Video | `<video>` + hls.js (HLS), dash.js (DASH + Widevine attempt for Oneplay) |
| Sources | SledováníTV, Oneplay |
| Login | Seamless: e-mail + password are entered once into a modal dialog, then the app logs in by itself (silent refreshes) even after restart. SledováníTV: device pairing → device-login; no profiles. Session policy: the stored session is used while it works — a new one is created only on proven expiry (no pairing/logins on every start). Locked stations are shown with a lock (package vs. parental lock) instead of being silently skipped. Oneplay: login → server profile selection → bearer. Credentials encrypted in the vault (`%APPDATA%/com.tvclient.desktop/vault.dat` + `vault.key`, ChaCha20), regular settings in `settings.json` (store plugin via resource id, including delete permission for one-time cleanup of obsolete keys). Station copies are discarded only on proof of an invalid session (bad login, 401/403, expiry) — outages and HTTP 5xx keep them., username and password are stored right after pressing Login. The frontend calls the backend via `window.__TAURI_INTERNALS__.invoke` (v2 does not inject the v1 `__TAURI__` global). API via the Rust backend with no CORS |
| Empty state | Classic CRT static noise (canvas) instead of a black screen, until any program has run |
| Persistence | `tauri-plugin-store` (`settings.json`: source, station, pause, favorites, sessions, panel widths, window geometry) + `tauri-plugin-window-state` as backup (fallback to default when the monitor is unavailable — see `src-tauri/src/state.rs`). The window is shown only after geometry is restored. |

The main area is a video viewer with no window title and no console (click = pause, double-click = maximize, dragging the area = move the window; minimize/maximize/close in the top-right menu). Settings are saved immediately synchronously + as a backup to disk, so they survive even a quick close. Selecting a channel (row, favorite, EPG program) or switching sources starts it right away and cancels pause (Oneplay stream URL is resolved lazily on play). Each source remembers its own selected station, across switches and restarts. SledováníTV logout/expiry clears only SledováníTV EPG keys; stale Oneplay EPG is refetched automatically (freshness is checked every minute). The project contains no duplicate/temporary files (diagnostics always outside the project or deleted immediately after use). Program times show the start only, single-line in the panel, days separated by a rule. The picture is clean during playback (no captions, no noise bars). With no channel running there is only noise in the middle and the right menu is extended.
The right edge extends a column: sources side by side (icon only + one Login/Logout button) → favorite stations (drag & drop) → source stations. Panels extend when the mouse approaches the edge, no handles, no section headings.
The left edge shows the selected station's program for ~4 days with day separators (weekday, today/tomorrow) and a program filter — it opens on hover only when the station actually has a program (never an empty panel, not even while connecting). Program rows keep the time in a fixed column; titles stay in their own column and never wrap under the time, and the running program's progress bar gets its own full-width row. The selected station and favorites have a red frame. On session expiry the app says why and prompts to log in.

## SledováníTV (verified flow from community integrations)

- Login page `sledovat.tv/welcome/login` (login + password, or Google).
- `GET /api/create-pairing?username=&password=&type=xbmc&product=&serial=` → `deviceId` + `password`.
- `GET /api/device-login?deviceId=&password=&unit=default` → `PHPSESSID` (~24 h).
- `GET /api/playlist?PHPSESSID=&format=m3u8&quality=40&capabilities=h264` → channel JSON (`id`, `name`, `url` HLS, `logoUrl`, `locked`, `type`).
- `GET /api/epg?PHPSESSID=&detail=…&duration=1439&time=…` → EPG.
- Without login the app runs in demo mode with prototype data.

## Oneplay (per the Kodi add-on `waladir/plugin.video.oneplay`)

- Login page `oneplay.cz/prihlaseni` (e-mail / O2 ID + password).
- `POST https://http.cms.jyxo.cz/api/{version}/user.login.step` → `bearerToken` (~4 h) → profile selection → `content.play` with `playbackCapabilities { dash, hls, widevine }`.
- v1 also tries DRM via WebView2 (Widevine); unprotected HLS is a certainty, protected titles show a message instead of video. Verified on a real build.

## Structure

- `src/index.html`, `src/app.js`, `src/lib/epg.js` (pure EPG logic) — the app: video engine, CRT noise, modal login with profiles, source cards with icons only (`src/assets/*-icon.jpg`), resizable panels (widths in `settings.json`), API clients for both sources, encrypted vault. Below the sources is an activity log across the panel's free height (login progress; hidden when the source works), no automatic window opening. 0–2 hum bars randomly drift across the noise. Favorites are strictly per-source, keyed by stable IDs (`eid:`/`op:`, never bare names, so provider renames can't lose them) with one-time migration of old entries; they use the same rectangular icons as the list (section hidden when empty), reordering is insert-mode (the hole travels, the rest shift together without changing order). EPG stores are strictly per-source too — no cross-source matching, a foreign program is worse than none. Oneplay logos are fetched in the wide 320×196 size (the 256×256 square got cropped by the CDN), the cache stores no volatile EPG fields (program/progress are always recomputed from fresh data) and silent login of both sources runs in parallel at startup, settings are saved serialized with a synchronous backup and read with shape validation (a corrupted file deletes nothing), the station list has a filter with a clear button, program + progress + `HH:MM – HH:MM` times on a row with a bar come from live EPG (SledováníTV matched via playlist `id`, verified 131/131 with no mismatch; Oneplay via `epg.display` with `op:<id>` keys, verified 57/57). The pairing-coverage toast is SledováníTV-only (Oneplay mismatches go to the log, no popup). Station and favorite icons keep an inner margin so edge-to-edge logos don't look cramped. A remembered Oneplay station autoplays after restart too (stream URL is resolved lazily on play). With no data no fake "Živě" label is shown, hovering a station or a favorite icon shows a popup with more programs including the running program's progress, lists have a designed scrollbar. The left menu shows the selected station's program with a program filter (day separators kept) and no explanatory captions, at startup the source card shows the connecting progress instead of a button. Clicking the currently playing station restarts nothing. Top-right row: a `?` on the left (hover = floating help with shortcuts and controls), `— ▢ ✕` on the right. Both sources connect in parallel at startup, each with its own state — Oneplay always shows its connecting state while refreshing channels/EPG. Working keys: Space = pause, `F` = maximize, `↑`/`↓` = station, `Esc` = close (not while typing). The hint bubble is removed. The center above the noise is permanently hidden. The build stamp is in the login dialog footer.
- `src-tauri/` — Rust backend (Tauri v2, opener/store/window-state plugins, window visibility fallback).
- `src-tauri/icons/` — generated icons.
- `prototype-tv-client.html` — interactive HTML behavior prototype (open in a browser). New graphic elements/dialogs from the app are always carried over including demo data; prototype changes go into the app only on explicit request. The prototype is currently ahead: sources as the official app icons only (`src/assets/*-icon.jpg`) with no text, panels resizable by dragging the inner edge (width remembered), login as a standalone modal dialog (name+password → demo profile selection → back), lists have a designed scrollbar and hovering a station shows a popup with more programs to the left of the menu (no scrollbar, always fully visible), the station filter has a clear button. The right menu has a window-button row, a help `?` (shortcuts + controls) and an activity log; Space/F/Esc/arrows work. Favorite reordering is insert-mode (the hole travels, the rest shift together without changing order). The left EPG panel has a program filter with a clear button (day separators kept), in the prototype too (demo).
- `.thinkrail/context/TASK-tv-v1.md` — working task-spec v1 (temporary).

## Development & build

- Requirements: Node 24+, Rust 1.90+, Windows (WebView2).
- `npm install` — install dependencies.
- `npm test` — JS tests (`node --test`), `cargo test` (Rust tests in `src-tauri/src/*`).
- `npm run dev` (`tauri dev`) — development.
- `npm run build` (`tauri build`) — portable EXE + installers in `src-tauri/target/release/bundle/`.
- Login/stream testing happens on a real build with a real account (passwords are never sent anywhere, secrets stay encrypted in the vault).

## Testing with a real account (tester flow)

1. Run `src-tauri/target/release/tv-client.exe` (portable, nothing installs).
2. Open the menu via the right edge → Log in SledováníTV / Log in Oneplay.
3. Click Login — a modal dialog opens, enter e-mail and password (once, stored encrypted). SledováníTV goes directly; for Oneplay pick a server profile. Everything else is automatic including silent refresh after restart.
4. Without login there are no stations, only CRT noise and a login prompt.
5. After login, live stations and the program load. Settings (source, station, pause, favorites, window size/position/fullscreen) save automatically and restore after restart.

## Status

v0.1.0 ready for testing: Tauri skeleton + full v2 prototype behavior + video engine + CRT noise + login dialog + persistence. Build: only `tv-client.exe` (portable, no installers). To verify with a real account: SledováníTV playlist/EPG, Oneplay login and DRM.
