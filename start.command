#!/bin/bash
# Double-click this file in Finder to start the Toll Card Scanner.
# (First time: right-click → Open, because macOS asks before running scripts.)
cd "$(dirname "$0")" || exit 1

pause() { read -n 1 -s -r -p "Press any key to close this window…"; echo; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS version from https://nodejs.org, then double-click start.command again."
  open "https://nodejs.org/en/download"
  pause
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $(node -v) is too old. Install the LTS version (22 or newer) from https://nodejs.org"
  open "https://nodejs.org/en/download"
  pause
  exit 1
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing components (first run only, needs internet)…"
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "Installation failed - check the internet connection and try again."
    pause
    exit 1
  fi
fi

# keep the Mac awake while scanning; opens the portal in the browser
exec caffeinate -i node server/index.js --open
