@echo off
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-environment.ps1"
set "result=%errorlevel%"
echo.
if not "%result%"=="0" (
  echo Installation failed. Review errors above.
  pause
  exit /b %result%
)
echo Installation complete. Run the startup CMD next.
pause
