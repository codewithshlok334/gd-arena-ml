@echo off
setlocal
cd /d "%~dp0"
title GD Arena - Local practice demo
where py >nul 2>nul
if not errorlevel 1 (
  py -3 launch.py
  goto done
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" launch.py
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python launch.py
  goto done
)
echo Install Python 3.12 from python.org, enable Add Python to PATH, then run this file again.
pause
exit /b 1
:done
if errorlevel 1 pause
endlocal
