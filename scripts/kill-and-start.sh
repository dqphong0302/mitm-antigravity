#!/usr/bin/env bash
# kill-and-start.sh
# Kill mọi tiến trình proxy cũ → khởi động proxy MỚI chạy NGẦM (nohup+disown).
# Log → /tmp/mitm-proxy.log
#
# Cách dùng:
#   sudo bash scripts/kill-and-start.sh              # kill + start ngầm
#   sudo bash scripts/kill-and-start.sh --kill-only  # chỉ kill, không start
#   PORT=8443 sudo bash scripts/kill-and-start.sh    # dùng port khác
#   LOG_FILE=/var/log/mitm.log sudo bash ...         # đổi log path
set -euo pipefail

PORT="${PORT:-443}"
LOG_FILE="${LOG_FILE:-/tmp/mitm-proxy.log}"
KILL_ONLY=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

for arg in "$@"; do
  [[ "${arg}" == "--kill-only" ]] && KILL_ONLY=true
done

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '[kill-and-start] %s\n' "$*"; }
ok()   { printf '[kill-and-start] ✅ %s\n' "$*"; }
warn() { printf '[kill-and-start] ⚠  %s\n' "$*" >&2; }
err()  { printf '[kill-and-start] ❌ %s\n' "$*" >&2; }

port_pids() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_port_free() {
  local tries=20
  while [[ ${tries} -gt 0 ]]; do
    [[ -z "$(port_pids)" ]] && return 0
    sleep 0.3
    tries=$(( tries - 1 ))
  done
  return 1
}

wait_port_up() {
  local tries=30   # tối đa 9 giây
  while [[ ${tries} -gt 0 ]]; do
    [[ -n "$(port_pids)" ]] && return 0
    sleep 0.3
    tries=$(( tries - 1 ))
  done
  return 1
}

# ── Bước 0: Phải chạy với root (port 443 cần root) ───────────────────────────

if [[ "$(id -u)" -ne 0 ]]; then
  err "Port ${PORT} yêu cầu quyền root. Chạy lại với sudo:"
  err "  sudo bash ${BASH_SOURCE[0]} $*"
  exit 1
fi

# ── Bước 1: Gỡ LaunchDaemon nếu có (macOS) ───────────────────────────────────

LABEL="com.phongdang.mitm-antigravity.proxy"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
if [[ "$(uname -s)" == "Darwin" ]] && [[ -f "${PLIST}" ]]; then
  log "Gỡ LaunchDaemon ${LABEL} ..."
  /bin/launchctl bootout system "${PLIST}" >/dev/null 2>&1 || true
  sleep 0.5
fi

# ── Bước 2: SIGTERM các process cũ ───────────────────────────────────────────

log "SIGTERM mitm-ag-backend + node index.js ..."
pkill -TERM -x  "mitm-ag-backend"        2>/dev/null || true
pkill -TERM -f  "mitm-ag-backend start"  2>/dev/null || true
pkill -TERM -f  "node.*index\\.js start" 2>/dev/null || true

# Kill bất kỳ process nào đang giữ port
PIDS="$(port_pids)"
if [[ -n "${PIDS}" ]]; then
  log "Port ${PORT} đang bị giữ bởi PID: ${PIDS} — SIGTERM ..."
  # shellcheck disable=SC2086
  kill -TERM ${PIDS} 2>/dev/null || true
fi

sleep 0.8

# ── Bước 3: SIGKILL nếu vẫn còn ─────────────────────────────────────────────

pkill -KILL -x  "mitm-ag-backend"        2>/dev/null || true
pkill -KILL -f  "mitm-ag-backend start"  2>/dev/null || true
pkill -KILL -f  "node.*index\\.js start" 2>/dev/null || true

PIDS="$(port_pids)"
if [[ -n "${PIDS}" ]]; then
  log "SIGKILL ${PIDS} ..."
  # shellcheck disable=SC2086
  kill -KILL ${PIDS} 2>/dev/null || true
fi

# ── Bước 4: Xác nhận port đã free ────────────────────────────────────────────

if wait_port_free; then
  ok "Port ${PORT} đã free."
else
  warn "Port ${PORT} có thể vẫn bận — tiếp tục ..."
fi

# ── Bước 4b: Kiểm tra DNS /etc/hosts ────────────────────────────────────────
# DNS entries persist qua restart — script KHÔNG cần re-apply, chỉ cần check.
# Nếu thiếu → cảnh báo; muốn fix thì chạy: sudo node index.js setup

HOSTS_FILE="/etc/hosts"
DNS_TARGETS=(
  "daily-cloudcode-pa.googleapis.com"
  "cloudcode-pa.googleapis.com"
  "daily-cloudaicompanion.googleapis.com"
  "cloudaicompanion.googleapis.com"
  "daily-cloudaicompanion.sandbox.googleapis.com"
  "cloudaicompanion.sandbox.googleapis.com"
  "daily-cloudcode-pa.sandbox.googleapis.com"
  "cloudcode-pa.sandbox.googleapis.com"
)
# Proxy thêm cả IPv4 (127.0.0.1) lẫn IPv6 (::1) để block cả A và AAAA records
DNS_IPS=("127.0.0.1" "::1")
DNS_OK=true
for host in "${DNS_TARGETS[@]}"; do
  for ip in "${DNS_IPS[@]}"; do
    if ! grep -qP "^${ip}\s+.*\b${host}\b" "${HOSTS_FILE}" 2>/dev/null; then
      warn "DNS thiếu: ${ip} ${host} không có trong ${HOSTS_FILE}"
      DNS_OK=false
    fi
  done
done
if [[ "${DNS_OK}" == "true" ]]; then
  ok "DNS /etc/hosts ✓ (IPv4 + IPv6 cho cả 2 target hosts)"
else
  warn "DNS chưa đủ — chạy lệnh sau để setup:"
  warn "  sudo node ${PROJECT_DIR}/index.js setup --password '<sudo-pass>'"
  warn "Proxy vẫn sẽ start nhưng Antigravity có thể bypass qua IPv6."
fi

[[ "${KILL_ONLY}" == "true" ]] && { log "Kill-only xong."; exit 0; }

# ── Bước 5: Start proxy ngầm (nohup + disown) ────────────────────────────────

log "Khởi động proxy trên port ${PORT} (nền) ..."
log "Log → ${LOG_FILE}"

cd "${PROJECT_DIR}"

# Truncate log file cũ để tail -f không lẫn output session trước
: > "${LOG_FILE}"

# nohup: thoát khỏi SIGHUP khi terminal đóng
# disown: tách process khỏi job table của shell hiện tại
nohup node index.js start --skip-setup >> "${LOG_FILE}" 2>&1 &
PROXY_PID=$!
disown "${PROXY_PID}" 2>/dev/null || true

log "Proxy PID: ${PROXY_PID}"

# ── Bước 6: Chờ port lên ─────────────────────────────────────────────────────

log "Chờ port ${PORT} active ..."
if wait_port_up; then
  ACTUAL_PID="$(port_pids | head -1)"
  ok "Proxy đang chạy trên port ${PORT} (PID ${ACTUAL_PID})"
  ok "Xem log: tail -f ${LOG_FILE}"
else
  err "Port ${PORT} không lên sau 9 giây!"
  err "Kiểm tra log: cat ${LOG_FILE}"
  # In 20 dòng cuối log để debug ngay
  echo "--- tail ${LOG_FILE} ---" >&2
  tail -20 "${LOG_FILE}" >&2 || true
  exit 1
fi
