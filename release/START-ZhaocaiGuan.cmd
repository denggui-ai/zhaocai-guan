@echo off
setlocal
set "APP=%~dp0app\ZhaocaiGuan.exe"
if not exist "%APP%" (
  echo Zhaocai Guan executable was not found.
  echo Keep the complete extracted folder structure and try again.
  pause
  exit /b 1
)
start "" "%APP%"
exit /b 0
