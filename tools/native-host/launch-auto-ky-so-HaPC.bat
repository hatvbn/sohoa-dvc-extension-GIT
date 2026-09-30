@echo off
rem HaTools - Chrome goi file nay qua Native Messaging de bat script tu bam "Ky so".
rem
rem QUAN TRONG: KHONG chay PowerShell truc tiep o day. Chrome dat native host vao
rem mot "job object" co KILL_ON_JOB_CLOSE; khi Chrome ngat ket noi, moi tien trinh
rem con (ke ca PowerShell mo bang 'start') bi giet ngay -> khong bam ky duoc.
rem Vi vay spawn qua WMI (Win32_Process.Create): tien trinh moi thuoc dich vu WMI,
rem KHONG nam trong job cua Chrome, nen song sot va tu bam ky binh thuong.
setlocal
set "PS1=%~dp0..\auto-ky-so.ps1"
set "CMD=powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%PS1%" -IdleMinutes 5"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CMD } | Out-Null"
exit /b 0
