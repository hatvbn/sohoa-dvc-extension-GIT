@echo off
rem ============================================================
rem  HaTools DVCBacNinh - Go chuc nang tu bam "Ky so"
rem ============================================================
set "KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hatools.autokyso"

reg delete "%KEY%" /f >nul 2>&1
if errorlevel 1 (
  echo Khong co gi de go [chua cai, hoac da go truoc do].
) else (
  echo Da go chuc nang tu bam "Ky so".
)
echo.
pause
