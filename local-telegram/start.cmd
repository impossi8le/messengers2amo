@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is required. Install it and run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:3210 in your browser.
echo Keep this window open. Press Ctrl+C to stop.
node --env-file-if-exists=.env src/server.mjs
if errorlevel 1 pause
