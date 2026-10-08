@echo off
setlocal
title Office Inventory - Launcher
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
exit /b 0
