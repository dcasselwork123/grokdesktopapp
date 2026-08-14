# Grok Desktop — project guide

## READ THIS FIRST (fresh sessions)

**If this is a new or resumed session whose job is to work on the Grok Desktop app itself** (`C:\Dev\GrokDesktop`), **read this entire file before changing code, installing packages, or “fixing” launchers.**

Do not re-scaffold the app from scratch. Do not assume npm-only workflows when the user prefers double-click launchers. Prefer small, targeted edits to the existing Electron + Node server + renderer layout.

### Source of truth (git)

| | |
|--|--|
| **Main / canonical repo** | https://github.com/dcasselwork123/grokdesktopapp |
| **Local workspace** | `C:\Dev\GrokDesktop` (tracks `origin/main` on that repo) |

That GitHub repo is the **main repo** for this project. Treat it as the only remote source of truth unless the user says otherwise.

**Push policy:** After a **decent-sized** change, commit (if needed) and `git push` to `origin/main` without waiting to be asked. After a **small** change, commit locally if that makes sense, then **ask** before pushing.

| Push now | Ask first |
|----------|-----------|
| New feature, user-visible behavior change, or multi-file bugfix | Typos, copy tweaks, one-liner / few-line fixes, docs-only (`AGENTS.md`, `README.md`), or “not sure this is done” |
| The user said “push this” / “push to GitHub” | Anything that rewrites history (`--force`), opens a PR, or publishes to a non-`main` remote |

Never force-push. Never commit secrets (`~/.grok/auth.json`, API keys, `~/.grok-desktop/config.json`). If push is blocked (auth, conflicts), say so and stop.

---

## What this app is

Claude Desktop–style UI for **Grok Build**:

- Left: session list (from `~/.grok/sessions`)
- Center: chat (streams `grok -p` headless output)
- Bottom: model + effort (+ folder on desktop)
- Remote: same UI over Tailscale in mobile Safari while the app is running

No Artifacts / Routines / Customize chrome. Sessions are real Grok sessions (shared with the CLI).

---

## Features (keep these working)

### Working folder (cwd)

| Context | Behavior |
|---------|----------|
| **Desktop (Electron)** | **Folder** uses the native Windows/macOS directory dialog (`dialog.showOpenDialog` via IPC `pick-folder`). Path is read-only in the UI; click path or folder icon to browse. |
| **Browser / `npm run server`** | Free-text path still works (no Electron dialog). |
| **Changing folder** | If the path differs from the open session’s cwd, the app starts a **new draft chat** in that folder (does not resume the old session). |
| **Mobile** | Folder field is hidden in the composer. On **+ New**, a sheet lists **unique project folders** from existing sessions, or the last folder chosen on the desktop (cannot pick an arbitrary `C:\` path from the phone). |
| **First-seen folder** | Desktop: if the cwd is not in `seenFolders` (`~/.grok-desktop/config.json`), show a one-line composer warning that Grok can read and run against this folder. Record the path after the first successful send or dismiss. A newly cloned repo is first-seen. Mobile already picked a known project — no extra nag. |

IPC: `electron/main.js` → `pick-folder`; `electron/preload.js` → `grokDesktop.pickFolder()`.

### Access control (permission mode)

| Context | Mode |
|---------|------|
| **Desktop default** | **Full access** — `--permission-mode bypassPermissions`. Tools run without asking. |
| **Desktop Safer** | `--permission-mode dontAsk`. Tools that need approval are denied and the turn continues. |
| **Remote / phone** | **Never** `bypassPermissions`, regardless of the desktop setting or a `permissionMode` field on the chat body. |

Persist as `permissionMode` in `~/.grok-desktop/config.json`. Do not take a permission mode from remote JSON.

**Honest limit:** a hostile repo can still inject via README / issues / images. Full vs Safer + first-seen warning shrink blast radius. They do **not** delete the agent problem.

### Electron chrome / CSP

- **CSP** in `renderer/index.html` `<head>`: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'`. Keep the critical inline `<style>`; no `unsafe-inline` scripts.
- **`openExternal` / context-menu “Open link”:** only `http:` and `https:` (`server/externalUrl.js` → `isSafeExternalUrl`). Deny `file:`, `javascript:`, `data:`, custom protocols.
- **`will-navigate` / `will-redirect`:** only the API origin (`http://127.0.0.1:<port>` / `localhost`). If the API is not up yet, deny navigation away from the current URL. Always `{ action: "deny" }` for in-window popups.

### Image attachments

- **+** button left of the message box; also **paste** and **drag-and-drop** onto the composer.
- Previews above the input; × removes an attachment (max 8).
- Client re-encodes to **JPEG** (~1280px max edge) before upload.
- Server saves under `~/.grok-desktop/uploads/`, then runs Grok with a normal `-p` prompt that includes absolute image paths so the model can use **`read_file` vision** (do **not** rely on `--prompt-json` for large images on Windows/Electron — it was unreliable).
- Status bar updates during image turns (launching → running → tool/thinking → writing). Client heartbeat + 45s no-output watchdog if Grok stalls.
- Optional debug log: `~/.grok-desktop/debug.log`.

### Slash commands (app-handled)

| Command | Behavior |
|---------|----------|
| `/clear` | Clears the UI and starts a **new** draft session (same folder). Alias of “fresh chat”. |
| `/new` | Same as `/clear`. |
| `/btw [message]` | Opens a **side chat** in a new window (Electron) or browser tab. Forks the current session so the aside has context, without interrupting the main turn. |

Other TUI slash commands (`/compact`, `/theme`, …) are **not** implemented in the desktop app; they would only be sent as plain text if typed.

### Copy transcript text

- Highlight text in the chat and **Ctrl+C** / **Cmd+C** (or right-click **Copy** on desktop).
- A plain click in the transcript still focuses the composer; a drag-select does **not**, so the highlight stays copyable.
- Desktop: Electron Edit menu + native context menu (copy/cut/paste in the composer too).

### In-app updates (GitHub)

If this folder is a git checkout of the app, the sidebar footer can show **Update available** under the account/status row when `origin/main` is ahead.

| | |
|--|--|
| **Check** | `GET /api/update` — `git fetch origin` at most every **30 minutes** (startup + interval + window focus all share that cap). Only show **Update available** when **disk HEAD** is behind `origin/main`. |
| **Confirm** | Button opens a modal with the incoming commit subject(s) |
| **Apply** | `POST /api/update` — `git pull --ff-only`, `npm install` only if `package.json` / lockfile changed, then Electron `app.relaunch()` |
| **Hidden when** | Not a git checkout, git missing, already current, or local branch has diverged / is ahead |
| **Phone** | Can see **Update available** (`GET`). Apply (`POST /api/update`) is PC-only — update and restart on the desktop, then reload Safari |

Do not force-push, reset, or stash local work. If the fast-forward is blocked, show git’s error.

Server: `server/appUpdate.js`. Restart hook: `electron/main.js` → `onAppRestart`.

### Remote (phone)

- Same `renderer/` as desktop. Auth: loopback open. Remote: `?token=` is a **one-time Safari bootstrap**; the server sets an **HttpOnly SameSite=Strict cookie**. The client strips the query from the address bar and does **not** store the token in localStorage. API fetches do **not** put the token in the query string (cookie only).
- `GET /api/health` does **not** return the raw token. `GET /api/remote` returns the copyable phone URL **only on loopback**.
- 📱 **Rotate phone access** (PC modal) mints a new token; existing phone tabs need the new URL.
- Default bind is `127.0.0.1` plus the Tailscale `100.x` address — **not** `0.0.0.0`. LAN is opt-in via 📱 **Allow LAN (trusted network)** (or `GROK_DESKTOP_ALLOW_LAN=1` / `GROK_DESKTOP_HOST=0.0.0.0`).
- Phone cannot `POST /api/update` or start/cancel OAuth (`POST /api/auth/login`). Finish sign-in and apply updates on the PC, then reload Safari / Recheck.
- Mobile: model/effort in composer; folder via **New → project picker** (known project folders or last desktop folder — not a free-form `C:\` path); images via phone file picker / photos.

### Startup setup gate (CLI install + Grok sign-in)

**Why it exists:** Someone else who pulls this repo must use **their** Grok account. Without this gate the app used to fail silently when `grok` was missing or `~/.grok/auth.json` was absent.

**On boot** (`renderer/app.js` → `checkSetupAndBoot`):

1. Call **`GET /api/setup`** (server: `getSetupStatus()` in `grokService.js`).
2. If not ready, show full-screen **`#setup-gate`** (in `renderer/index.html`) over the app — do **not** load chat as if everything is fine.
3. If ready, hide the gate and continue normal boot (models, sessions, empty draft).

| Check | Ready condition | UI if failing |
|-------|-----------------|---------------|
| **Grok CLI installed?** | Binary found via `GROK_BIN`, `~/.grok/bin/grok(.exe)`, `~/.local/bin/grok`, or PATH | **Install Grok CLI** — official install command (Windows PowerShell / Unix curl), copy button, docs link (`https://x.ai/cli`), **Recheck** |
| **Signed in?** | `~/.grok/auth.json` present, parseable, and has usable credentials (`key` and/or `refresh_token`) | **Sign in with Grok** — primary button runs login |

**Never return tokens** from auth APIs (no `key`, no `refresh_token` in JSON to the client). Only safe fields: `present`, `valid`, `reason`, `email`, `userId`.

#### Sign in with Grok (OAuth)

| Step | What happens |
|------|----------------|
| User clicks **Sign in with Grok** | Client `POST /api/auth/login` with `{ "oauth": true }` |
| Server | Spawns **`grok login --oauth`** (same browser OAuth flow as the CLI) |
| UI | Shows “complete sign-in in the browser…”, polls **`GET /api/setup`** every ~1.5s |
| Success | `auth.json` becomes valid → gate hides → app unlocks |
| Cancel | `POST /api/auth/login/cancel` kills the login process |
| Phone / remote | Cannot start OAuth (`POST /api/auth/login` is loopback-only). Finish sign-in on the PC, then Recheck (`GET /api/setup`) on the phone |

Related endpoints:

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/setup` | Full readiness: `ready`, `installed`, `grokBin`, `auth`, `login`, `install` commands |
| `GET` | `/api/health` | Includes `ready`, `installed`, `authenticated`, `authEmail` (plus remote info). Does **not** return the raw phone token. |
| `POST` | `/api/auth/login` | Start `grok login --oauth` |
| `GET` | `/api/auth/login` | Login process status (`running`, exit code, log tail) |
| `POST` | `/api/auth/login/cancel` | Stop in-flight login |

**Do not remove** this gate or replace it with a silent health check. Chat send is also blocked until `state.setupReady` is true.

**After CLI install mid-session:** user hits **Recheck** (server re-resolves binary via `refreshGrokBinary()`).

---

## How to start the app

**Preferred (user-facing):** double-click in Explorer:

| File | Notes |
|------|--------|
| `Start Grok Desktop.vbs` | Opens Electron with no console (usual daily launch) |
| `Start Grok Desktop.bat` | Same app; keeps a console if startup fails |

Both load **current files on disk** — no rebuild step after code edits. Quit the running app and relaunch to pick up changes to `electron/`, `server/`, or `renderer/`.

**Dev / CLI:**

```powershell
cd C:\Dev\GrokDesktop
npm.cmd install          # first time only (or after package.json changes)
npm.cmd start            # electron .
# or server only:
npm.cmd run server       # node server/index.js → http://127.0.0.1:3847
```

**Requirements:** Node 18+. Grok CLI + sign-in are checked at startup (see **Startup setup gate** above). Fresh clones: user installs CLI and/or clicks **Sign in with Grok** — no shared account secrets in the repo.

**Config / remote:** `~/.grok-desktop/config.json` (token, host, port, `allowLan`, `permissionMode`, `seenFolders`, last desktop cwd). Default bind is `127.0.0.1` + Tailscale `100.x` (not `0.0.0.0`). Phone URL = PC Tailscale IP + port + `?token=…` (📱 copies it when Tailscale is up; no LAN fallback unless Allow LAN is on). Auth: loopback open; remote `?token=` is a one-time Safari bootstrap, then an HttpOnly SameSite=Strict cookie. API fetches do not put the token in the query string and do not keep it in localStorage.

**Local data (user machine, not in repo):**

| Path | Purpose |
|------|---------|
| `~/.grok/sessions/` | Real Grok session store (shared with CLI) |
| `~/.grok/auth.json` | Grok OAuth / account credentials (**never commit**; each user signs in locally) |
| `~/.grok-desktop/config.json` | Desktop bind host/port/token/`allowLan`/`permissionMode`/`seenFolders` |
| `~/.grok-desktop/uploads/` | Attached images saved for the current machine |
| `~/.grok-desktop/debug.log` | Optional spawn/stream debug lines |

---

## Codebase map

```
GrokDesktop/
├── AGENTS.md               ← this file (read first for app work)
├── package.json            ← electron app entry: electron/main.js
├── package-lock.json       ← leave in repo; do not touch or nag about it
├── Start Grok Desktop.vbs  ← double-click launcher (no console)
├── Start Grok Desktop.bat  ← double-click launcher (errors visible)
├── README.md               ← longer human docs (remote, env vars)
├── screenshots/            ← e.g. mobileview.png
│
├── electron/
│   ├── main.js             ← BrowserWindow + HTTP API + pick-folder IPC + copy/edit menu + nav lock
│   └── preload.js          ← grokDesktop.isElectron / getApiInfo / pickFolder
│
├── server/
│   ├── index.js            ← standalone server entry (no Electron)
│   ├── httpApi.js          ← REST + SSE chat + static UI + token/cookie auth + /api/setup + /api/auth/login
│   ├── grokService.js      ← sessions, models, spawn grok -p, image save, setup/auth/login
│   ├── appUpdate.js        ← git fetch (30 min) + pull / npm install / restart
│   ├── remoteAccess.js     ← config, token, Tailscale IP, phone URL
│   └── externalUrl.js      ← http(s)-only openExternal; API-origin navigation
│
└── renderer/               ← same UI for desktop window + phone browser
    ├── index.html          ← CSP meta, setup gate, composer, folder control, attach UI, modals
    ├── styles.css          ← desktop + mobile chat layout + setup gate
    └── app.js              ← setup gate boot, sessions, SSE, folder/images, mobile drawer
```

### Data flow (short)

```
UI (Electron or Safari)
  → GET /api/setup  (CLI installed? auth.json valid?)
  → if not ready: setup gate (Install CLI / Sign in with Grok)
  → POST /api/auth/login → spawn grok login --oauth  (browser on host PC)
  → when ready:
       HTTP/SSE  server/httpApi.js
       → (optional) save images → ~/.grok-desktop/uploads/
       → spawn     grok -p --output-format streaming-json [--resume id]
                   (+ image paths embedded in -p text when attachments present)
       → sessions  ~/.grok/sessions/<cwd>/<id>/
```

### Touch these first when…

| Goal | Primary files |
|------|----------------|
| UI look / mobile layout | `renderer/styles.css`, `renderer/index.html`, `renderer/app.js` |
| Chat / sessions / streaming | `server/grokService.js`, `server/httpApi.js`, `renderer/app.js` |
| **Setup gate / install / sign-in** | `server/grokService.js` (`getSetupStatus`, `startGrokLogin`), `server/httpApi.js`, `renderer/app.js`, `renderer/index.html`, `renderer/styles.css` |
| Folder picker (native dialog) | `electron/main.js`, `electron/preload.js`, `renderer/app.js` |
| Access control / first-seen folder | `server/grokService.js` (`buildArgs`), `server/remoteAccess.js`, composer in `renderer/` |
| External links / CSP / will-navigate | `server/externalUrl.js`, `electron/main.js` (`attachCommonWindowHandlers`), `renderer/index.html` `<head>` |
| Images / attachments | `renderer/app.js`, `server/httpApi.js`, `server/grokService.js` |
| Mobile new-session projects | `renderer/app.js`, `renderer/index.html` (folder-picker modal) |
| Tailscale / token / bind | `server/remoteAccess.js`, `electron/main.js`, `server/httpApi.js` |
| Launch / window startup | `electron/main.js`, `Start Grok Desktop.*` |
| **Copy chat text (Ctrl+C)** | `electron/main.js` (Edit menu + context menu), `renderer/app.js`, `renderer/styles.css` |
| **In-app GitHub update** | `server/appUpdate.js`, `server/httpApi.js`, `electron/main.js`, `renderer/app.js` + `index.html` + `styles.css` |
| First-time deps | `package.json` only if needed; prefer existing electron install |

---

## Conventions for agents

1. **Read this file first** on fresh sessions about this app.
2. Keep the stack simple: Electron shell + Node HTTP + vanilla renderer (no React rewrite unless asked).
3. Preserve double-click launchers; don’t force the user into raw npm for daily use.
4. Mobile and desktop share `renderer/` — fix auth/CSS so remote assets work (HttpOnly cookie after the one-time `?token=` bootstrap).
5. Don’t commit secrets; desktop token lives in `~/.grok-desktop/config.json`; **never** commit `~/.grok/auth.json` or API keys.
6. **Images:** save to disk + pass paths via `-p` (vision through tools). Avoid large `--prompt-json` base64 on Windows/Electron.
7. **Folder change = new chat** when cwd differs from the active session — don’t silently resume the old session in a new directory.
8. **Keep the setup gate** (install CLI / Sign in with Grok). Don’t reintroduce silent CLI/auth failures for fresh clones.
9. **Main repo** is https://github.com/dcasselwork123/grokdesktopapp — push decent-sized work to `origin/main`; **ask before pushing small changes.** Never force-push.
10. **`package-lock.json`:** leave it in the repo and **leave it alone**. Do not delete it, restore it, “clean up” uuid/deps noise, or flag local lockfile diffs to the user unless they explicitly asked.

)
