@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -File "scripts\Launch-Workbench.ps1"
if errorlevel 3 call npm.cmd run tauri dev
