@echo off
chcp 65001 >nul
title Quark Share Downloader
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js not found.
  echo     Please install Node.js 18+ from https://nodejs.org and run again.
  echo.
  pause
  exit /b 1
)
echo Starting... browser will open automatically.
node "%~dp0quark-dl.js"
if errorlevel 1 pause
