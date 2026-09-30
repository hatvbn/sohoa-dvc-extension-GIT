@echo off
rem ============================================================
rem  HaTools DVCBacNinh - Cai dat chuc nang tu bam "Ky so"
rem  (noi dung khong dau de cmd chay dung tren moi may;
rem   ten file van co dau cho de tim)
rem ============================================================
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NH=%ROOT%\tools\native-host"
set "BAT=%NH%\launch-auto-ky-so.bat"
set "JSON=%NH%\com.hatools.autokyso.json"
set "EXTID=hobkbfcjeepcjlbhgbabealmllifjlgn"
set "KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hatools.autokyso"

if not exist "%BAT%" (
  echo [LOI] Khong tim thay: "%BAT%"
  echo Hay giai nen DAY DU thu muc, va de file nay o thu muc goc extension.
  echo.
  pause
  exit /b 1
)

set "BATJSON=%BAT:\=\\%"

rem 1) Ghi manifest host, tro dung duong dan launcher tren may nay
> "%JSON%" echo {"name":"com.hatools.autokyso","description":"HaTools tu bam Ky so","path":"%BATJSON%","type":"stdio","allowed_origins":["chrome-extension://%EXTID%/"]}

rem 2) Dang ky khoa Registry (chi trong tai khoan nguoi dung)
reg add "%KEY%" /ve /t REG_SZ /d "%JSON%" /f >nul
if errorlevel 1 (
  echo [LOI] Khong ghi duoc Registry.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   DA CAI DAT XONG chuc nang tu bam "Ky so".
echo.
echo   Buoc cuoi [lam 1 lan]:
echo   Mo  chrome://extensions  roi bam Tai lai [Reload]
echo   tren tien ich "HaTools DVCBacNinh".
echo ============================================================
echo.
pause
