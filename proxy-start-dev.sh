#!/bin/bash
# Kill existing proxy if running
sudo pkill -f "mitm-antigravity-macos-arm64 start" 2>/dev/null
sudo pkill -f "node.*mitm-antigravity.*start" 2>/dev/null
sleep 1

# Start proxy from source directly (not pkg binary)
sudo rm -f /tmp/mitm-antigravity-proxy.log
sudo -E node /Volumes/DATA/workspace/mitm-antigravity/index.js start --skip-setup \
  > /tmp/mitm-antigravity-proxy.log 2>&1 &

echo "Proxy started from source (PID: $!)"
echo "Log: /tmp/mitm-antigravity-proxy.log"
