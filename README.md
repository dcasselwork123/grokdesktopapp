# Grok Desktop

A small **Claude Desktop–style** UI for [Grok Build](https://grok.com): session list on the left, chat in the center, model + effort selectors on the bottom. No terminal required for day-to-day use.

Grok still runs on your machine (full tools, same sessions under `~/.grok/sessions`). The app shells out to the `grok` CLI in headless mode and streams the reply into a chat UI.

## Requirements

- **Node.js 18+**
- **Grok CLI** installed and logged in (`grok` on PATH, or `~/.grok/bin/grok.exe`)

On first launch the app checks both:

1. **Is the Grok CLI installed?** If not, it shows **Install Grok CLI** with the official install command (Windows PowerShell / macOS-Linux) and a Recheck button.
2. **Are you signed in?** It looks for a valid `~/.grok/auth.json`. If missing or invalid, it shows **Sign in with Grok**, which runs `grok login --oauth` (same browser OAuth flow as the CLI).

Someone who pulls this repo can use their own Grok account without manual terminal setup beyond installing the CLI (or even that, via the install screen).

## Quick start

```powershell
cd C:\Dev\GrokDesktop
npm.cmd install
npm.cmd start
```

That opens the Electron window. The same UI is also served at **http://127.0.0.1:3847**.

### Server only (no Electron)

```powershell
npm.cmd run server
```

Then open http://127.0.0.1:3847 in a browser.

## Features

| Area | What you get |
|------|----------------|
| **Sessions** | Lists real Grok sessions from `~/.grok/sessions`, grouped by project |
| **Chat** | Clean dark chat UI (styled after Claude Desktop) |
| **New** | Top-left **+ New** starts a fresh session |
| **Model / Effort** | Bottom bar selectors (from Grok’s model cache) |
| **Folder** | Working directory for new sessions |
| **Tools** | Tool calls show as compact chips while Grok works |
| **Stop** | Cancel an in-flight headless run |

## Use from iPhone (recommended)

You do **not** need to use a terminal on the phone. Run the web UI on your PC and open it in Safari over a private mesh network.

### Option A — Tailscale + browser (best)

1. Install [Tailscale](https://tailscale.com/download) on the PC and iPhone; sign into the same account.
2. On the PC, start the server bound to all interfaces with a shared secret:

```powershell
cd C:\Dev\GrokDesktop
$env:GROK_DESKTOP_HOST = "0.0.0.0"
$env:GROK_DESKTOP_TOKEN = "pick-a-long-secret"
$env:GROK_DESKTOP_PORT = "3847"
npm.cmd run server
```

3. On the iPhone, open Tailscale → note your **PC’s Tailscale IP** (e.g. `100.x.y.z`).
4. In Safari open:

```
http://100.x.y.z:3847/?token=pick-a-long-secret
```

Same session list, same chat, same model/effort controls. Grok keeps running on the PC.

### Option B — SSH app (fallback)

If you only want a terminal remote:

1. Enable OpenSSH Server on Windows (optional) or use another SSH host.
2. Install **Termius** or **Blink Shell** on the iPhone.
3. SSH in and run `grok` / `grok --resume <session-id>`.

This works, but you still get a TUI. Prefer Option A.

### Option C — LAN only (home Wi‑Fi)

Same as A without Tailscale, using your PC’s LAN IP. Only safe on a trusted network; always set `GROK_DESKTOP_TOKEN`.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `GROK_DESKTOP_PORT` | `3847` | HTTP port |
| `GROK_DESKTOP_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for remote) |
| `GROK_DESKTOP_TOKEN` | _(none)_ | If set, required as `?token=` or `X-Grok-Token` |
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

- **List / history**: reads `summary.json` + `updates.jsonl` from disk  
- **Send message**: `grok -p "…" --resume <id> --output-format streaming-json --permission-mode bypassPermissions`  
- **New session**: same without `--resume` (or with a fresh UUID)

Sessions created here are the same ones `grok` / Claude-style resume lists use.

## Layout (what we intentionally skipped)

Matching your request: **no** Artifacts, Routines, Customize, or Home/Code chrome from the Claude Desktop screenshot — just sessions, chat, and model/effort.

## Troubleshooting

**“Connected” never appears**  
Check that nothing else owns port 3847, or set `GROK_DESKTOP_PORT`.

**Send fails / empty reply**  
Use **Sign in with Grok** on the setup screen, or run `grok login` in a terminal and Recheck. Confirm with `grok -p "hi" --output-format json`.

**Install / sign-in screen won’t clear**  
- Install: `irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then Recheck.  
- Auth file: `%USERPROFILE%\.grok\auth.json` (Windows) or `~/.grok/auth.json`.

**Sessions missing**  
They live under `%USERPROFILE%\.grok\sessions`. The app only shows folders that have a `summary.json`.

**Phone can’t connect**  
- Host must be `0.0.0.0`  
- Windows Firewall may prompt on first bind — allow private/Tailscale  
- Use the Tailscale IP, not `127.0.0.1`, on the phone  

## License

Private / personal use.
