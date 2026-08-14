# Grok Desktop

A **Claude Desktop–style** UI for [Grok Build](https://grok.com): sessions on the left, chat in the center, model + effort on the bottom. Day-to-day use does not need a terminal.

Grok still runs on **your** machine (full tools, same sessions under `~/.grok/sessions`). The app shells out to the `grok` CLI in headless mode and streams the reply into a chat UI.

The same UI works in the Electron window and in mobile Safari over Tailscale while the app is running.

![Grok Desktop on iPhone](screenshots/mobileview.png)

## Requirements

- **Node.js 18+**
- A **Grok** account ([x.ai](https://x.ai) / [grok.com](https://grok.com))

You do **not** need to install the Grok CLI or sign in from a terminal first. On launch the app checks both and walks you through it.

## First launch

```powershell
git clone https://github.com/dcasselwork123/grokdesktopapp.git
cd grokdesktopapp
npm install
```

Then either:

| How | Notes |
|-----|--------|
| Double-click **`Start Grok Desktop.vbs`** | Normal daily launch (no console) |
| Double-click **`Start Grok Desktop.bat`** | Same app; keeps a console if startup fails |
| `npm start` | Electron from a terminal |

The first window is a **setup gate**, not the chat:

1. **Install Grok CLI** — if `grok` is missing, the app shows the official install command ([x.ai/cli](https://x.ai/cli)) for Windows PowerShell or macOS/Linux, plus **Copy** and **Recheck**.
2. **Sign in** — pick **Sign in with X** or **Sign in with email**, matching the Grok account you actually use. That starts `grok login --oauth` and opens the Grok sign-in page in your browser. Finish there; the app polls until `~/.grok/auth.json` is valid, then the gate hides.

Each clone uses **your** Grok account. Nothing in this repo is a shared login.

Later you can switch or leave from the **account bubble** in the sidebar footer: Sign in with X, Sign in with email, or **Log out**.

### Server only (browser, no Electron)

```powershell
npm run server
```

Then open http://127.0.0.1:3847. The setup gate is the same.

## Features

| Area | What you get |
|------|----------------|
| **Setup gate** | Install CLI + Sign in with X or email before chat unlocks |
| **Account** | Sidebar avatar: who you’re signed in as, switch X/email, log out |
| **Sessions** | Real Grok sessions from `~/.grok/sessions`, grouped by project. Right-click to rename; Select to archive/delete |
| **Chat** | Dark chat UI; markdown tables; tool-call chips while Grok works |
| **Background turns** | Switching chats does not kill a run that is still going |
| **Queue** | Type a follow-up while a turn is running; it sends when Grok is free |
| **`/btw`** | Side chat in a new window (or tab) with a fork of the current session |
| **`/clear` / `/new`** | Fresh draft in the same folder |
| **Images** | **+**, paste, or drag-and-drop (max 8). Re-encoded to JPEG on the client |
| **Model / Effort** | Composer selectors, including a custom model picker |
| **Usage** | Weekly usage pie in the composer; click for session context |
| **Folder** | Desktop: native folder dialog. Phone: pick a project from existing sessions |
| **Stop** | Cancel an in-flight run |
| **Phone** | Same UI in Safari; reconnects if iOS drops the stream |
| **Updates** | **Update available** in the sidebar when GitHub has a new commit. Confirm, then the app pulls and restarts (checks at most every 30 minutes) |

## Use from iPhone

Keep Grok Desktop running on the PC. On the PC, click **📱** in the sidebar footer and **Copy phone URL**. That link includes the access token.

1. Install [Tailscale](https://tailscale.com/download) on the PC and iPhone; sign into the same account.
2. On the phone, open the copied URL in Safari (`http://100.x.y.z:3847/?token=…`).

The app already binds to `0.0.0.0:3847` and stores a random token in `~/.grok-desktop/config.json`. You do not need to set env vars for the usual case.

Loopback (`127.0.0.1`) does not need a token. Anything remote does — after the first `?token=` load, a cookie keeps CSS/JS working.

If you sign in from the phone, the OAuth browser still opens **on the PC**. Finish login there.

**LAN only (no Tailscale):** same URL with your PC’s LAN IP. Only do this on a trusted network.

## Environment variables (optional)

Defaults live in `~/.grok-desktop/config.json`. Env vars override the file.

| Variable | Default | Meaning |
|----------|---------|---------|
| `GROK_DESKTOP_PORT` | `3847` | HTTP port |
| `GROK_DESKTOP_HOST` | `0.0.0.0` | Bind address |
| `GROK_DESKTOP_TOKEN` | auto-generated | Required as `?token=` or `X-Grok-Token` for non-loopback |
| `GROK_BIN` | auto | Path to `grok` / `grok.exe` |
| `GROK_HOME` | `~/.grok` | Grok config/sessions root |

## How it works

```
┌─────────────────┐     HTTP / SSE      ┌──────────────────┐     spawn      ┌─────────────┐
│  Electron /     │ ──────────────────► │  Node API        │ ────────────► │ grok -p …   │
│  Safari (phone) │ ◄────────────────── │  server/httpApi  │ ◄──────────── │ streaming-  │
└─────────────────┘   chat events       └──────────────────┘   NDJSON      │ json        │
                                                      │                     └─────────────┘
                                                      ▼
                                            ~/.grok/sessions/*
```

- **Setup:** `GET /api/setup` — CLI present? `auth.json` valid?
- **Sign-in:** `POST /api/auth/login` → `grok login --oauth` (X or email in the browser)
- **Send:** `grok -p "…" --output-format streaming-json` (plus `--resume` when continuing)
- **Images:** saved under `~/.grok-desktop/uploads/`; absolute paths go in the `-p` prompt so Grok can `read_file` them

Sessions created here are the same ones the Grok CLI uses.

## Data on your machine (not in this repo)

| Path | Purpose |
|------|---------|
| `~/.grok/sessions/` | Real Grok session store (shared with the CLI) |
| `~/.grok/auth.json` | Your Grok credentials — **never commit** |
| `~/.grok-desktop/config.json` | Bind host/port and the phone-access token |
| `~/.grok-desktop/uploads/` | Attached images |
| `~/.grok-desktop/debug.log` | Optional spawn/stream debug lines |

## Working on the app

[`AGENTS.md`](AGENTS.md) is the project brief: layout, features to keep working, setup-gate rules, and how to start it. Read that before changing code.

There is no compile step. Launchers load the files on disk — quit and relaunch after edits.

## Troubleshooting

**Setup gate won’t go away**
- Install: `irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then **Recheck**.
- Sign-in: use **Sign in with X** or **Sign in with email**, then finish in the browser that opened on the PC. You can also run `grok login --oauth` in a terminal and Recheck.
- Auth file: `%USERPROFILE%\.grok\auth.json` (Windows) or `~/.grok/auth.json`.

**Send fails / empty reply**  
Confirm you’re signed in (account bubble in the sidebar). In a terminal: `grok -p "hi" --output-format json`.

**Phone can’t connect**
- App must be running on the PC
- Use the **📱 Copy phone URL** link (includes `?token=`)
- Use the Tailscale IP, not `127.0.0.1`, on the phone
- Windows Firewall may prompt on first bind — allow private/Tailscale

**Sessions missing**  
They live under `%USERPROFILE%\.grok\sessions`. The app lists folders that have a `summary.json`.

**Port already in use**  
Set `GROK_DESKTOP_PORT`, or quit the other process on 3847.

## License

Source is public so you can run and modify it. No warranty. You need your own Grok account; this repo does not ship credentials.
