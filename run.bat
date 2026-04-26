@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  npm install
)

node mitm-oneclick.js start %*
