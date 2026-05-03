#!/usr/bin/env bash
set -euo pipefail

echo "Stopping MITM AG backend and UI processes..."

osascript -e 'tell application "MITM AG" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "MITM Antigravity" to quit' >/dev/null 2>&1 || true

pkill -TERM -x "mitm-ag-backend" >/dev/null 2>&1 || true
pkill -TERM -f "/MITM AG.app/Contents/MacOS/" >/dev/null 2>&1 || true
pkill -TERM -f "/MITM Antigravity.app/Contents/MacOS/" >/dev/null 2>&1 || true

sleep 1

pkill -KILL -x "mitm-ag-backend" >/dev/null 2>&1 || true
pkill -KILL -f "/MITM AG.app/Contents/MacOS/" >/dev/null 2>&1 || true
pkill -KILL -f "/MITM Antigravity.app/Contents/MacOS/" >/dev/null 2>&1 || true

echo "Done."
