@echo off
title SmileOS 2.0
cd /d "%~dp0"
if not exist "node_modules" (
    echo Electron kuruluyor, bir kez bekleyin...
    call npm install
)
call npm start
