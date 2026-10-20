@echo off
setlocal enabledelayedexpansion
title RaPaX™ Installer — Archer Chain Analytics™

color 0E
echo.
echo  ██████╗  █████╗ ██████╗  █████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗██╔╝
echo  ██████╔╝███████║██████╔╝███████║ ╚███╔╝
echo  ██╔══██╗██╔══██║██╔═══╝ ██╔══██║ ██╔██╗
echo  ██║  ██║██║  ██║██║     ██║  ██║██╔╝ ██╗
echo  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo  Sovereign Digital Vending Machine v1.0.0
echo  Archer Chain Analytics™ — archerchainanalytics.com
echo  ─────────────────────────────────────────
echo.

:: ── Check Administrator privileges ───────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] This installer requires Administrator privileges.
    echo  Right-click install-windows.bat and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  [✓] Running as Administrator
echo.

:: ── Check Node.js ─────────────────────────────────────────────────
echo  [*] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js not found. Opening download page...
    echo      Required: Node.js 18 LTS or higher
    echo      https://nodejs.org/en/download/
    echo.
    start https://nodejs.org/en/download/
    echo  After installing Node.js, run this installer again.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [✓] Node.js found: %NODE_VER%

:: ── Set installation directory ────────────────────────────────────
set INSTALL_DIR=%ProgramFiles%\RaPaX
echo.
echo  [*] Installation directory: %INSTALL_DIR%
echo.

if exist "%INSTALL_DIR%" (
    echo  [!] Existing installation found at %INSTALL_DIR%
    set /p OVERWRITE="  Overwrite? [Y/N]: "
    if /i "!OVERWRITE!" neq "Y" (
        echo  Installation cancelled.
        pause
        exit /b 0
    )
    echo  [*] Removing existing installation...
    rmdir /s /q "%INSTALL_DIR%"
)

:: ── Create directories ────────────────────────────────────────────
echo  [*] Creating directories...
mkdir "%INSTALL_DIR%"
mkdir "%INSTALL_DIR%\storage\products"
mkdir "%INSTALL_DIR%\storage\fingerprinted"
mkdir "%INSTALL_DIR%\logs"
mkdir "%INSTALL_DIR%\dashboard\dist"
echo  [✓] Directories created

:: ── Copy application files ────────────────────────────────────────
echo  [*] Copying application files...
xcopy /E /I /Q /Y "%~dp0src" "%INSTALL_DIR%\src\" >nul
xcopy /E /I /Q /Y "%~dp0dashboard" "%INSTALL_DIR%\dashboard\" >nul
copy /Y "%~dp0package.json" "%INSTALL_DIR%\" >nul
copy /Y "%~dp0.env.example" "%INSTALL_DIR%\.env.example" >nul
copy /Y "%~dp0README.md" "%INSTALL_DIR%\" >nul 2>&1

:: Copy legal documents
if exist "%~dp0legal" (
    xcopy /E /I /Q /Y "%~dp0legal" "%INSTALL_DIR%\legal\" >nul
    echo  [✓] Legal documents installed
)

echo  [✓] Application files copied

:: ── Install npm dependencies ──────────────────────────────────────
echo  [*] Installing dependencies (this may take a minute)...
cd /d "%INSTALL_DIR%"
call npm install --silent 2>nul
if %errorlevel% neq 0 (
    echo  [!] npm install encountered issues. Trying with --legacy-peer-deps...
    call npm install --legacy-peer-deps --silent
)
echo  [✓] Dependencies installed

:: ── Configure environment ─────────────────────────────────────────
echo.
echo  ─────────────────────────────────────────
echo  CONFIGURATION
echo  ─────────────────────────────────────────
echo.

if not exist "%INSTALL_DIR%\.env" (
    copy "%INSTALL_DIR%\.env.example" "%INSTALL_DIR%\.env" >nul

    :: Generate a random operator secret
    for /f "tokens=*" %%r in ('node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"') do set RAND_SECRET=%%r
    powershell -Command "(Get-Content '%INSTALL_DIR%\.env') -replace 'change_this_to_a_long_random_string', '%RAND_SECRET%' | Set-Content '%INSTALL_DIR%\.env'"

    :: Set DB and storage paths for Windows
    powershell -Command "(Get-Content '%INSTALL_DIR%\.env') -replace './rapax.db', '%INSTALL_DIR:\=\\%\\rapax.db' | Set-Content '%INSTALL_DIR%\.env'"

    echo  [✓] .env configured with generated operator secret
    echo.
    echo  [!] IMPORTANT: Your operator secret has been auto-generated.
    echo      Record it now — it will not be shown again:
    echo.
    echo      %RAND_SECRET%
    echo.
    echo  Save this to a secure location before continuing.
    echo.
    pause
) else (
    echo  [✓] Existing .env preserved
)

:: ── Initialize database ───────────────────────────────────────────
echo  [*] Initializing database...
cd /d "%INSTALL_DIR%"
node -e "import('./src/utils/initDb.js').then(m=>m.initDb()).then(()=>process.exit(0))" 2>nul
if %errorlevel% equ 0 (
    echo  [✓] Database initialized
) else (
    echo  [!] Database will initialize on first startup
)

:: ── Create Windows Service wrapper ───────────────────────────────
echo  [*] Creating startup script...
(
echo @echo off
echo cd /d "%INSTALL_DIR%"
echo node src/server.js
) > "%INSTALL_DIR%\rapax-start.bat"

:: ── Create Desktop shortcut ───────────────────────────────────────
echo  [*] Creating shortcuts...
set SHORTCUT_PATH=%PUBLIC%\Desktop\RaPaX Dashboard.url
(
echo [InternetShortcut]
echo URL=http://localhost:4000/dashboard
echo IconFile=%SystemRoot%\System32\shell32.dll
echo IconIndex=14
) > "%SHORTCUT_PATH%"
echo  [✓] Desktop shortcut created: RaPaX Dashboard

:: ── Create Start Menu entry ───────────────────────────────────────
set START_DIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\RaPaX
mkdir "%START_DIR%" 2>nul
(
echo [InternetShortcut]
echo URL=http://localhost:4000/dashboard
) > "%START_DIR%\RaPaX Dashboard.url"

powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%START_DIR%\Start RaPaX.lnk');$s.TargetPath='%INSTALL_DIR%\rapax-start.bat';$s.WorkingDirectory='%INSTALL_DIR%';$s.Save()"
echo  [✓] Start Menu entries created

:: ── Add to PATH ───────────────────────────────────────────────────
setx PATH "%PATH%;%INSTALL_DIR%" /M >nul 2>&1
echo  [✓] Added to system PATH

:: ── Firewall rule ─────────────────────────────────────────────────
netsh advfirewall firewall add rule name="RaPaX Server Port 4000" dir=in action=allow protocol=TCP localport=4000 >nul 2>&1
echo  [✓] Firewall rule added for port 4000

:: ── Installation complete ─────────────────────────────────────────
echo.
echo  ─────────────────────────────────────────
echo  [✓] RaPaX™ INSTALLATION COMPLETE
echo  ─────────────────────────────────────────
echo.
echo  To start RaPaX™:
echo    Run: %INSTALL_DIR%\rapax-start.bat
echo    Or:  node src/server.js  (from %INSTALL_DIR%)
echo.
echo  Dashboard: http://localhost:4000/dashboard
echo  API:       http://localhost:4000/api
echo.
echo  Next step: Edit %INSTALL_DIR%\.env
echo  with your blockchain provider keys.
echo.
echo  Documentation: %INSTALL_DIR%\README.md
echo  Legal:         %INSTALL_DIR%\legal\
echo.

set /p START_NOW="  Start RaPaX™ now? [Y/N]: "
if /i "%START_NOW%"=="Y" (
    echo  Starting RaPaX™...
    start "RaPaX™" cmd /k "cd /d %INSTALL_DIR% && node src/server.js"
    timeout /t 3 /nobreak >nul
    start http://localhost:4000/dashboard
)

echo.
echo  © Archer Chain Analytics™ — Sovereign. Zero-Trust. Zero Compromise.
echo.
pause
endlocal
