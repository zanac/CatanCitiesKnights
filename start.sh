#!/bin/bash
# ============================================================
#  CATAN WEB - Script di avvio
# ============================================================

PORT=${PORT:-3000}

echo ""
echo "  ⚔️  I Coloni di Catan - Web Edition"
echo "  ====================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  ❌ Node.js non trovato!"
    echo "  Installa Node.js: https://nodejs.org"
    exit 1
fi

NODE_VER=$(node -v)
echo "  ✅ Node.js: $NODE_VER"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  📦 Installazione dipendenze..."
    npm install
fi

echo "  🚀 Avvio server sulla porta $PORT..."
echo ""
echo "  🌐 Apri nel browser: http://localhost:$PORT"
echo "  🌐 Da altri PC sulla rete: http://$(hostname -I | awk '{print $1}'):$PORT"
echo ""
echo "  Premi CTRL+C per fermare il server"
echo ""

PORT=$PORT node server/index.js
