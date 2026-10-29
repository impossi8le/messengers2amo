@echo off
cd /d "%~dp0"
echo Open http://127.0.0.1:3211 in your browser. Demo only.
node --env-file=.env.demo src/server.mjs
if errorlevel 1 pause
