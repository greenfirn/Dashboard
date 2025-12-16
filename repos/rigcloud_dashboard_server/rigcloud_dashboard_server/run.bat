@echo off
cd /d "%~dp0"

powershell -NoProfile -Command ^
  "Start-Process python -ArgumentList 'rigcloud_dashboard_server.py' -WindowStyle Hidden"

exit
