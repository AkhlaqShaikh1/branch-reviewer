@echo off
cd /d "%~dp0"
start "" http://localhost:4777
node server.js
