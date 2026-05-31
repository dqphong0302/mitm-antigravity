#!/usr/bin/env bash
# Kill and restart MITM Antigravity proxy.
# Usage:
#   bash scripts/restart-proxy.sh
#   PORT=8443 bash scripts/restart-proxy.sh
#   START_CMD="pnpm start -- --skip-setup" bash scripts/restart-proxy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${PORT:-443}"
START_CMD="${START_CMD:-pnpm start -- --skip-setup}"
LOG_FILE="${LOG_FILE:-${ROOT_DIR}/proxy-restart.log}"

log() { printf '[restart-proxy] %s\n' "$*"; }
ok()  { printf '[restart-proxy] ✅ %s\n' "$*"; }
err() { printf '[restart-proxy] ❌ %s\n' "$*" >&2; }

port_pids() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_health() {
  local tries="${1:-40}"
  while [[ "${tries}" -gt 0 ]]; do
    if curl -sk --max-time 2 "https://daily-cloudcode-pa.googleapis.com/_mitm_health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    tries=$((tries - 1))
  done
  return 1
}

cd "${ROOT_DIR}"

log "Killing existing proxy on port ${PORT}..."
if [[ "$(uname -s)" == "Darwin" && "${PORT}" == "443" ]]; then
  sudo PORT="${PORT}" bash "${SCRIPT_DIR}/kill-mitm-ag.command"
else
  PIDS="$(port_pids)"
  if [[ -n "${PIDS}" ]]; then
    # shellcheck disable=SC2086
    kill -TERM ${PIDS} 2>/dev/null || true
    sleep 1
  fi
  PIDS="$(port_pids)"
  if [[ -n "${PIDS}" ]]; then
    # shellcheck disable=SC2086
    kill -KILL ${PIDS} 2>/dev/null || true
  fi
fi

log "Starting proxy: ${START_CMD}"
: > "${LOG_FILE}"
nohup bash -lc "${START_CMD}" >> "${LOG_FILE}" 2>&1 &
PID="$!"

if wait_health 40; then
  ok "Proxy is healthy. PID=${PID}. Log=${LOG_FILE}"
else
  err "Proxy did not become healthy. Log=${LOG_FILE}"
  tail -80 "${LOG_FILE}" 2>/dev/null || true
  exit 1
fi
