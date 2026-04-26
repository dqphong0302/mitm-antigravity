@echo off
setlocal
cd /d "%~dp0"

node mitm-oneclick.js stop %*
