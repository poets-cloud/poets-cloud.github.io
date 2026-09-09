@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "API_PORT=8765"
set "FRONTEND_PORT=5173"
set "API_URL=http://127.0.0.1:%API_PORT%"
set "FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"
set "API_STARTED=0"
set "FRONTEND_STARTED=0"

title Poets Cloud Launcher
echo ========================================
echo   Poets Cloud - Frontend + Backend
echo ========================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js and npm were not found in PATH.
  pause
  exit /b 1
)

python -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Installing Python packages...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [ERROR] Failed to install Python packages.
    pause
    exit /b 1
  )
)

if not exist "node_modules\vite\bin\vite.js" (
  echo [SETUP] Installing frontend packages...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Failed to install frontend packages.
    pause
    exit /b 1
  )
)

echo [1/3] Checking backend...
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%API_URL%/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } } catch {}; exit 1"
if errorlevel 1 (
  powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %API_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
  if errorlevel 1 (
    echo [ERROR] Backend port %API_PORT% is occupied by another application.
    pause
    exit /b 1
  )

  echo       Starting FastAPI at %API_URL% ...
  start "Poets Cloud API" /min cmd /k "cd /d ""%~dp0"" && python -m uvicorn api:app --host 127.0.0.1 --port %API_PORT% --reload"
  set "API_STARTED=1"
) else (
  echo       Backend is already running.
)

echo [2/3] Checking frontend...
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%FRONTEND_URL%' -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } } catch {}; exit 1"
if errorlevel 1 (
  powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %FRONTEND_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
  if errorlevel 1 (
    echo [ERROR] Frontend port %FRONTEND_PORT% is occupied by another application.
    pause
    exit /b 1
  )

  echo       Starting Vite at %FRONTEND_URL% ...
  start "Poets Cloud Frontend" /min cmd /k "cd /d ""%~dp0"" && call npm run dev -- --host 127.0.0.1 --port %FRONTEND_PORT% --strictPort"
  set "FRONTEND_STARTED=1"
) else (
  echo       Frontend is already running.
)

echo [3/3] Waiting for both services...
powershell -NoProfile -Command "$url='%API_URL%/api/health'; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Backend did not become ready. Check the Poets Cloud API window.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$url='%FRONTEND_URL%'; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Frontend did not become ready. Check the Poets Cloud Frontend window.
  pause
  exit /b 1
)

echo.
echo [READY] Frontend: %FRONTEND_URL%
echo [READY] Backend:  %API_URL%
echo [READY] API docs: %API_URL%/docs
echo.
start "" "%FRONTEND_URL%"

if "%API_STARTED%%FRONTEND_STARTED%"=="00" (
  echo Both services were already running.
) else (
  echo Close the two minimized service windows to stop the project.
)

endlocal
exit /b 0
