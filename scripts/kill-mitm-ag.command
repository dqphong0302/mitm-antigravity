#!/usr/bin/env bash
# Kill MITM Antigravity proxy/backend processes and anything listening on PORT.
# Usage:
#   sudo bash scripts/kill-mitm-ag.command
#   PORT=8443 sudo bash scripts/kill-mitm-ag.command

set -euo pipefail

PORT="${PORT:-443}"
LABEL="com.phongdang.mitm-antigravity.proxy"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

log()  { printf '[kill-mitm-ag] %s\n' "$*"; }
ok()   { printf '[kill-mitm-ag] ✅ %s\n' "$*"; }
warn() { printf '[kill-mitm-ag] ⚠  %s\n' "$*" >&2; }
err()  { printf '[kill-mitm-ag] ❌ %s\n' "$*" >&2; }

port_pids() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_port_free() {
  local tries=20
  while [[ ${tries} -gt 0 ]]; do
    [[ -z "$(port_pids)" ]] && return 0
    sleep 0.25
    tries=$((tries - 1))
  done
  return 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "Script này dành cho macOS."
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  err "Port ${PORT} thường cần quyền root. Chạy:"
  err "  sudo bash $0"
  exit 1
fi

log "Stopping MITM Antigravity UI apps..."
osascript -e 'tell application "MITM AG" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "MITM Antigravity" to quit' >/dev/null 2>&1 || true

if [[ -f "${PLIST}" ]]; then
  log "Unloading LaunchDaemon ${LABEL}..."
  /bin/launchctl bootout system "${PLIST}" >/dev/null 2>&1 || true
fi

log "SIGTERM known MITM proxy/backend processes..."
pkill -TERM -x "mitm-ag-backend" >/dev/null 2>&1 || true
pkill -TERM -f "mitm-ag-backend start" >/dev/null 2>&1 || true
pkill -TERM -f "node.*index\\.js start" >/dev/null 2>&1 || true
pkill -TERM -f "/MITM AG.app/Contents/MacOS/" >/dev/null 2>&1 || true
pkill -TERM -f "/MITM Antigravity.app/Contents/MacOS/" >/dev/null 2>&1 || true

PIDS="$(port_pids)"
if [[ -n "${PIDS}" ]]; then
  log "Port ${PORT} is held by PID(s): ${PIDS}. Sending SIGTERM..."
  # shellcheck disable=SC2086
  kill -TERM ${PIDS} 2>/dev/null || true
fi

sleep 1

log "SIGKILL remaining known processes if needed..."
pkill -KILL -x "mitm-ag-backend" >/dev/null 2>&1 || true
pkill -KILL -f "mitm-ag-backend start" >/dev/null 2>&1 || true
pkill -KILL -f "node.*index\\.js start" >/dev/null 2>&1 || true
pkill -KILL -f "/MITM AG.app/Contents/MacOS/" >/dev/null 2>&1 || true
pkill -KILL -f "/MITM Antigravity.app/Contents/MacOS/" >/dev/null 2>&1 || true

PIDS="$(port_pids)"
if [[ -n "${PIDS}" ]]; then
  log "Port ${PORT} still held by PID(s): ${PIDS}. Sending SIGKILL..."
  # shellcheck disable=SC2086
  kill -KILL ${PIDS} 2>/dev/null || true
fi

if wait_port_free; then
  ok "Port ${PORT} is free."
else
  warn "Port ${PORT} may still be busy. Current listener(s):"
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
  exit 1
fi

ok "Done."
