#!/bin/bash
# Shared macOS launcher for Grok Desktop (Finder or Terminal).
# --quiet: no Terminal (used by Start Grok Desktop.app). On first run, opens
#          the .command so npm install progress is visible — same idea as the .vbs.

set -u

quiet=0
if [ "${1:-}" = "--quiet" ]; then
  quiet=1
fi

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  echo "This launcher is for macOS. On Windows, double-click Start Grok Desktop.vbs" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
COMMAND_FILE="$ROOT/Start Grok Desktop.command"
LOG_OUT="${TMPDIR:-/tmp}/grok-desktop-out.log"
LOG_ERR="${TMPDIR:-/tmp}/grok-desktop-err.log"

chmod +x "$SCRIPT_DIR/start-macos.sh" "$COMMAND_FILE" 2>/dev/null || true

prepend_path() {
  dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) PATH="$dir:$PATH" ;;
  esac
}

# Finder-launched apps get a skinny PATH. Put Homebrew, grok, Tailscale, and
# common Node version managers first so electron / grok / git / npm resolve.
prepend_path "/opt/homebrew/bin"
prepend_path "/opt/homebrew/sbin"
prepend_path "/usr/local/bin"
prepend_path "/usr/local/sbin"
prepend_path "$HOME/.local/bin"
prepend_path "$HOME/.grok/bin"
prepend_path "$HOME/.volta/bin"
prepend_path "$HOME/.asdf/shims"
prepend_path "/Applications/Tailscale.app/Contents/MacOS"

if [ -f "$HOME/.nvm/alias/default" ]; then
  nvm_default="$(cat "$HOME/.nvm/alias/default" 2>/dev/null || true)"
  prepend_path "$HOME/.nvm/versions/node/$nvm_default/bin"
fi
if [ -d "$HOME/.nvm/versions/node" ]; then
  nvm_latest="$(ls -1d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1 || true)"
  prepend_path "${nvm_latest:-}/bin"
fi
prepend_path "$HOME/.local/share/fnm/aliases/default/bin"

export PATH

if [ -z "${TAILSCALE_BIN:-}" ]; then
  if [ -x /opt/homebrew/bin/tailscale ]; then
    export TAILSCALE_BIN=/opt/homebrew/bin/tailscale
  elif [ -x /usr/local/bin/tailscale ]; then
    export TAILSCALE_BIN=/usr/local/bin/tailscale
  elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
    export TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  fi
fi

pause() {
  if [ -t 0 ]; then
    echo
    # shellcheck disable=SC2162
    read -r -p "Press Return to close this window..." _
  fi
}

open_verbose() {
  if [ -f "$COMMAND_FILE" ]; then
    open "$COMMAND_FILE"
    exit 0
  fi
  echo "Could not find Start Grok Desktop.command" >&2
  exit 1
}

# First-time install needs a Terminal. The .app just hands off.
if [ "$quiet" -eq 1 ] && [ ! -x "$ELECTRON_BIN" ]; then
  open_verbose
fi

cd "$ROOT" || exit 1

if [ "$quiet" -eq 0 ]; then
  echo "Grok Desktop"
  echo "Folder: $ROOT"
  echo
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH." >&2
  echo "Install from https://nodejs.org (or: brew install node), then try again." >&2
  if [ "$quiet" -eq 1 ]; then
    open_verbose
  fi
  pause
  exit 1
fi

if [ ! -x "$ELECTRON_BIN" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm was not found. Install Node.js from https://nodejs.org then try again." >&2
    pause
    exit 1
  fi
  echo "First run: installing dependencies..."
  echo
  if ! npm install; then
    echo >&2
    echo "npm install failed." >&2
    pause
    exit 1
  fi
  echo
fi

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron is still missing after npm install." >&2
  echo "Expected: $ELECTRON_BIN" >&2
  pause
  exit 1
fi

if [ "$quiet" -eq 1 ]; then
  exec "$ELECTRON_BIN" .
fi

echo "Starting Grok Desktop..."
echo "If a window does not appear, read any error below."
echo

"$ELECTRON_BIN" . >"$LOG_OUT" 2>"$LOG_ERR"
code=$?

if [ "$code" -ne 0 ]; then
  echo >&2
  echo "Grok Desktop exited with code $code." >&2
  echo >&2
  [ -f "$LOG_ERR" ] && cat "$LOG_ERR" >&2
  [ -f "$LOG_OUT" ] && cat "$LOG_OUT" >&2
  pause
  exit "$code"
fi

exit 0
