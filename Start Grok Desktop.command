#!/bin/bash
# Double-click in Finder to start Grok Desktop (Terminal stays open if startup fails).
cd "$(dirname "$0")" || exit 1
exec /bin/bash "./scripts/start-macos.sh"
