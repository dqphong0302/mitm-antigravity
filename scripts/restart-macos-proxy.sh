#!/usr/bin/env bash
set -euo pipefail

LABEL="com.phongdang.mitm-antigravity.proxy"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
APP_BUNDLE="/Volumes/DATA/workspace/mitm-antigravity/src-tauri/target/release/bundle/macos/MITM AG.app"
BACKEND="${APP_BUNDLE}/Contents/Resources/resources/mitm-ag-backend"
PROXY_LOG="${TMPDIR:-/tmp}/mitm-antigravity-proxy.log"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is macOS-only." >&2
  exit 1
fi

if [[ ! -x "${BACKEND}" ]]; then
  echo "Backend not found or not executable: ${BACKEND}" >&2
  echo "Run: npm run tauri:build:macos" >&2
  exit 1
fi

if [[ -f "${PLIST}" ]]; then
  /usr/bin/osascript -e "do shell script \"/bin/launchctl bootout system ${PLIST} >/dev/null 2>&1 || true\" with administrator privileges"
fi

# Kill stale root/user backend processes that can keep port 443 busy.
while read -r pid; do
  [[ -n "${pid}" ]] || continue
  /usr/bin/osascript -e "do shell script \"/bin/kill ${pid} >/dev/null 2>&1 || true\" with administrator privileges" || true
done < <(/usr/bin/pgrep -f "mitm-ag-backend start --skip-setup --port 443" || true)

/bin/sleep 1

if [[ -f "${PLIST}" ]]; then
  /usr/bin/osascript -e "do shell script \"/bin/launchctl bootstrap system ${PLIST}\" with administrator privileges"
else
  /usr/bin/osascript -e "do shell script \"${BACKEND} start --skip-setup --port 443 >> ${PROXY_LOG} 2>&1 &\" with administrator privileges"
fi

/bin/sleep 2
/bin/ps -axo pid=,user=,ppid=,lstart=,command= -ww | /usr/bin/awk '/mitm-ag-backend start --skip-setup --port 443/ && !/awk/ {print}'
