#!/bin/bash
# Kill existing proxy if running
sudo pkill -f "mitm-antigravity-macos-arm64 start" 2>/dev/null
sleep 1

# Start proxy in background with logging
sudo nohup /Volumes/DATA/workspace/mitm-antigravity/dist/mitm-antigravity-macos-arm64 start --skip-setup \
  > /tmp/mitm-antigravity-proxy.log 2>&1 &

echo "Proxy started (PID: $!)"
echo "Log: /tmp/mitm-antigravity-proxy.log"
