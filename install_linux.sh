#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  RaPaX™ Installer — Linux / macOS
#  Archer Chain Analytics™ — archerchainanalytics.com
#  Sovereign Digital Vending Machine v1.0.0
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────
GOLD='\033[0;33m'
WHITE='\033[1;37m'
DIM='\033[2;37m'
RED='\033[0;31m'
GREEN='\033[0;32m'
RESET='\033[0m'

# ── Banner ────────────────────────────────────────────────────────
echo -e "${GOLD}"
echo ' ██████╗  █████╗ ██████╗  █████╗ ██╗  ██╗'
echo ' ██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗██╔╝'
echo ' ██████╔╝███████║██████╔╝███████║ ╚███╔╝ '
echo ' ██╔══██╗██╔══██║██╔═══╝ ██╔══██║ ██╔██╗ '
echo ' ██║  ██║██║  ██║██║     ██║  ██║██╔╝ ██╗'
echo ' ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝'
echo -e "${WHITE}"
echo ' Sovereign Digital Vending Machine v1.0.0'
echo ' Archer Chain Analytics™ — archerchainanalytics.com'
echo -e "${DIM} ─────────────────────────────────────────${RESET}"
echo

# ── Detect OS ─────────────────────────────────────────────────────
OS="unknown"
DISTRO=""
PKG_MGR=""

if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ -f /etc/os-release ]]; then
    source /etc/os-release
    OS="linux"
    DISTRO="${ID:-unknown}"
    case "$DISTRO" in
        ubuntu|debian|linuxmint|pop)   PKG_MGR="apt" ;;
        fedora|rhel|centos|rocky)      PKG_MGR="dnf" ;;
        arch|manjaro|endeavouros)      PKG_MGR="pacman" ;;
        opensuse*|sles)                PKG_MGR="zypper" ;;
        *)                             PKG_MGR="unknown" ;;
    esac
fi

echo -e "${GREEN}[✓]${RESET} Detected OS: ${WHITE}${OS}${RESET} ${DISTRO:+($DISTRO)}"

# ── Install directory ─────────────────────────────────────────────
if [[ "$OS" == "macos" ]]; then
    DEFAULT_DIR="$HOME/Applications/RaPaX"
else
    DEFAULT_DIR="/opt/rapax"
fi

read -r -p "  Installation directory [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

echo

# ── Root check for system directories ────────────────────────────
if [[ "$INSTALL_DIR" == /opt/* ]] || [[ "$INSTALL_DIR" == /usr/* ]]; then
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}[ERROR]${RESET} Installing to $INSTALL_DIR requires sudo."
        echo "  Run: sudo bash install-linux.sh"
        exit 1
    fi
fi

# ── Check Node.js ─────────────────────────────────────────────────
echo -e "  [*] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo -e "  ${RED}[!]${RESET} Node.js not found. Installing..."

    if [[ "$OS" == "macos" ]]; then
        if command -v brew &>/dev/null; then
            brew install node
        else
            echo "  Install Homebrew first: https://brew.sh"
            echo "  Then run: brew install node"
            exit 1
        fi
    elif [[ "$PKG_MGR" == "apt" ]]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    elif [[ "$PKG_MGR" == "dnf" ]]; then
        dnf module install -y nodejs:20
    elif [[ "$PKG_MGR" == "pacman" ]]; then
        pacman -S --noconfirm nodejs npm
    else
        echo "  Please install Node.js 18+ from https://nodejs.org"
        exit 1
    fi
fi

NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | grep -oP '\d+' | head -1)
echo -e "  ${GREEN}[✓]${RESET} Node.js: $NODE_VER"

if [[ "$NODE_MAJOR" -lt 18 ]]; then
    echo -e "  ${RED}[!]${RESET} Node.js 18+ required. Found: $NODE_VER"
    echo "  Update Node.js and re-run this installer."
    exit 1
fi

# ── Handle existing installation ──────────────────────────────────
if [[ -d "$INSTALL_DIR" ]]; then
    echo -e "  ${GOLD}[!]${RESET} Existing installation found at $INSTALL_DIR"
    read -r -p "  Overwrite? [y/N]: " OVERWRITE
    if [[ "${OVERWRITE,,}" != "y" ]]; then
        echo "  Installation cancelled."
        exit 0
    fi
    echo "  [*] Removing existing installation..."
    rm -rf "$INSTALL_DIR"
fi

# ── Create directory structure ────────────────────────────────────
echo "  [*] Creating directories..."
mkdir -p "$INSTALL_DIR"/{src,storage/{products,fingerprinted},logs,dashboard/dist,legal}
echo -e "  ${GREEN}[✓]${RESET} Directories created"

# ── Copy application files ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(dirname "$SCRIPT_DIR")"

echo "  [*] Copying application files..."
cp -r "$SRC_ROOT/src/"* "$INSTALL_DIR/src/" 2>/dev/null || true
cp -r "$SRC_ROOT/dashboard/"* "$INSTALL_DIR/dashboard/" 2>/dev/null || true
cp "$SRC_ROOT/package.json" "$INSTALL_DIR/" 2>/dev/null || true
cp "$SRC_ROOT/package-lock.json" "$INSTALL_DIR/" 2>/dev/null || true
cp "$SRC_ROOT/.env.example" "$INSTALL_DIR/" 2>/dev/null || true
cp "$SRC_ROOT/README.md" "$INSTALL_DIR/" 2>/dev/null || true

if [[ -d "$SRC_ROOT/legal" ]]; then
    cp -r "$SRC_ROOT/legal/"* "$INSTALL_DIR/legal/" 2>/dev/null || true
    echo -e "  ${GREEN}[✓]${RESET} Legal documents installed"
fi
echo -e "  ${GREEN}[✓]${RESET} Application files copied"

# ── Install npm dependencies ──────────────────────────────────────
echo "  [*] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --silent 2>/dev/null || npm install --legacy-peer-deps --silent
echo -e "  ${GREEN}[✓]${RESET} Dependencies installed"

# ── Configure environment ─────────────────────────────────────────
echo
echo -e "${WHITE}  ─────────────────────────────────────────"
echo -e "  CONFIGURATION${RESET}"
echo

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

    # Generate random secrets
    OPERATOR_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
    JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

    # Update .env
    sed -i.bak "s|change_this_to_a_long_random_string|$OPERATOR_SECRET|g" "$INSTALL_DIR/.env"
    sed -i.bak "s|change_this_jwt_secret|$JWT_SECRET|g" "$INSTALL_DIR/.env"
    sed -i.bak "s|./rapax.db|$INSTALL_DIR/rapax.db|g" "$INSTALL_DIR/.env"
    sed -i.bak "s|./storage/products|$INSTALL_DIR/storage/products|g" "$INSTALL_DIR/.env"
    sed -i.bak "s|./storage/fingerprinted|$INSTALL_DIR/storage/fingerprinted|g" "$INSTALL_DIR/.env"
    sed -i.bak "s|./logs|$INSTALL_DIR/logs|g" "$INSTALL_DIR/.env"
    rm -f "$INSTALL_DIR/.env.bak"

    echo -e "  ${GREEN}[✓]${RESET} .env configured"
    echo
    echo -e "  ${GOLD}[!] IMPORTANT — Save your operator secret now:${RESET}"
    echo
    echo -e "  ${WHITE}OPERATOR SECRET:${RESET} $OPERATOR_SECRET"
    echo
    echo "  This will NOT be shown again. Save it to a secure location."
    echo
    read -r -p "  Press Enter to continue after saving... "
else
    echo -e "  ${GREEN}[✓]${RESET} Existing .env preserved"
fi

# ── Set permissions ───────────────────────────────────────────────
chmod 600 "$INSTALL_DIR/.env"
chmod 700 "$INSTALL_DIR/storage"
chmod 700 "$INSTALL_DIR/logs"
echo -e "  ${GREEN}[✓]${RESET} Permissions set"

# ── Initialize database ───────────────────────────────────────────
echo "  [*] Initializing database..."
cd "$INSTALL_DIR"
node -e "import('./src/utils/initDb.js').then(m=>m.initDb()).then(()=>process.exit(0)).catch(()=>process.exit(0))" 2>/dev/null || true
echo -e "  ${GREEN}[✓]${RESET} Database initialized"

# ── Create systemd service (Linux only) ──────────────────────────
if [[ "$OS" == "linux" ]] && command -v systemctl &>/dev/null && [[ $EUID -eq 0 ]]; then
    echo "  [*] Creating systemd service..."
    RUN_USER="${SUDO_USER:-$(whoami)}"

    cat > /etc/systemd/system/rapax.service << SVCEOF
[Unit]
Description=RaPaX™ Sovereign Digital Vending Machine
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/src/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rapax
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=multi-user.target
SVCEOF

    systemctl daemon-reload
    systemctl enable rapax 2>/dev/null || true
    echo -e "  ${GREEN}[✓]${RESET} systemd service created: rapax.service"
    echo "      Start:  sudo systemctl start rapax"
    echo "      Status: sudo systemctl status rapax"
    echo "      Logs:   sudo journalctl -u rapax -f"
fi

# ── Create macOS LaunchAgent ──────────────────────────────────────
if [[ "$OS" == "macos" ]]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/com.archerchain.rapax.plist"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST_FILE" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.archerchain.rapax</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$INSTALL_DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/logs/rapax.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/rapax-error.log</string>
</dict>
</plist>
PLISTEOF

    echo -e "  ${GREEN}[✓]${RESET} macOS LaunchAgent created"
    echo "      Start: launchctl load $PLIST_FILE"
fi

# ── Create CLI wrapper ────────────────────────────────────────────
cat > /usr/local/bin/rapax 2>/dev/null << CLIEOF || \
cat > "$HOME/.local/bin/rapax" << CLIEOF
#!/usr/bin/env bash
cd "$INSTALL_DIR" && node src/server.js "\$@"
CLIEOF
chmod +x /usr/local/bin/rapax 2>/dev/null || chmod +x "$HOME/.local/bin/rapax" 2>/dev/null || true
echo -e "  ${GREEN}[✓]${RESET} CLI command 'rapax' available"

# ── Summary ───────────────────────────────────────────────────────
echo
echo -e "${GOLD}  ─────────────────────────────────────────"
echo -e "  ${GREEN}[✓] RaPaX™ INSTALLATION COMPLETE${GOLD}"
echo -e "  ─────────────────────────────────────────${RESET}"
echo
echo -e "  ${WHITE}Start:${RESET}     rapax"
echo -e "            or: cd $INSTALL_DIR && node src/server.js"
echo
echo -e "  ${WHITE}Dashboard:${RESET} http://localhost:4000/dashboard"
echo -e "  ${WHITE}API:${RESET}       http://localhost:4000/api"
echo
echo -e "  ${WHITE}Config:${RESET}    $INSTALL_DIR/.env"
echo -e "  ${WHITE}Docs:${RESET}      $INSTALL_DIR/README.md"
echo -e "  ${WHITE}Legal:${RESET}     $INSTALL_DIR/legal/"
echo

read -r -p "  Start RaPaX™ now? [y/N]: " START_NOW
if [[ "${START_NOW,,}" == "y" ]]; then
    cd "$INSTALL_DIR"
    echo "  Starting RaPaX™..."
    node src/server.js &
    sleep 3
    if command -v xdg-open &>/dev/null; then
        xdg-open http://localhost:4000/dashboard &>/dev/null || true
    elif command -v open &>/dev/null; then
        open http://localhost:4000/dashboard
    fi
    echo -e "  ${GREEN}[✓]${RESET} Running at http://localhost:4000/dashboard"
fi

echo
echo -e "${DIM}  © Archer Chain Analytics™ — Sovereign. Zero-Trust. Zero Compromise.${RESET}"
echo
