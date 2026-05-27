#!/bin/bash
sudo pkill -f "mitm-antigravity-macos-arm64 start" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "Proxy stopped"
else
  echo "Proxy not running"
fi
