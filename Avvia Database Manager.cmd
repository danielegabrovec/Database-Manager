@echo off
cd /d "%~dp0"
if exist "releases\0.2.1\Database Manager.exe" (
  start "" "releases\0.2.1\Database Manager.exe"
) else if exist "releases\0.2.0\Database Manager.exe" (
  start "" "releases\0.2.0\Database Manager.exe"
) else if exist "releases\Database Manager.exe" (
  start "" "releases\Database Manager.exe"
) else (
  echo Eseguibile non ancora compilato. Avvio ambiente di sviluppo...
  call npm.cmd run tauri dev
)
