@echo off
rem HaTools - Chrome goi file nay qua Native Messaging de bat script tu bam "Ky so".
rem Khong in gi ra man hinh: Chrome doc stdout theo giao thuc rieng.
start "HaTools - tu bam Ky so" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\auto-ky-so.ps1" -IdleMinutes 5
exit /b 0
