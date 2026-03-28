@echo off
setlocal
cd /d "%~dp0"
echo Starting Research Records sync server...
echo Open http://localhost:8735 on this computer.
echo Open the same server URL on your iPad while both devices are on the same Wi-Fi.
py -3 sync_server.py --host 0.0.0.0 --port 8735
