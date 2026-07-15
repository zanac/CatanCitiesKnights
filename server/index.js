// ============================================================
//  SERVER ENTRY POINT  —  server/index.js
//
//  Express + WebSocket server for SuperCatan.
//
//  Architecture overview:
//  ┌─────────────────────────────────────────────────────┐
//  │  REST API  (/api/*)   — room/token management, QR   │
//  │  WebSocket (ws://)    — real-time game state sync   │
//  │  Static               — serves public/ as-is        │
//  │  Skins                — serves skins/ as-is         │
//  └─────────────────────────────────────────────────────┘
//
//  Room lifecycle:
//    POST /api/create-room  → pin
//    WS connect with ?pin=  → room joined as desktop/setup
//    WS START_GAME          → CatanGame created, all clients notified
//    WS END_TURN / BUILD…   → game mutated, broadcastState() sends update
//    Rooms expire after 2h of inactivity (cleaned up every 30min)
//
//  Client roles (ws.role):
//    'setup'   — connected but no room yet (PIN entry screen)
//    'desktop' — admin/web-player view (index.html)
//    'mobile'  — phone player (mobile.html, validated via token)
//
//  Undo: before each mutating action pushUndo() deep-clones the state.
//  popUndo() restores the previous snapshot. Stack capped at 20 entries.
// ============================================================

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const crypto    = require('crypto');
const QRCode    = require('qrcode');
const { CatanGame } = require('./game');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── QR code generation ──────────────────────────────────────────
// Used by the spectator view to generate its own QR for sharing

app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({error:'missing url'});
  try {
    const qr = await QRCode.toDataURL(url, { width:300, margin:2, color:{ dark:'#1a1200', light:'#f0e6c8' } });
    res.json({ qrDataUrl: qr });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Used by the admin QR modal and phone-host mode to generate a player's join link.
// Creates a fresh token each time — tokens don't expire but are room-scoped.
app.post('/api/generate-mobile-qr', async (req, res) => {
  const { pin, playerIndex, playerName, lang } = req.body;
  if (!pin || !rooms.has(pin)) return res.status(404).json({ error: 'Room not found' });
  const room  = rooms.get(pin);
  const token = crypto.randomBytes(12).toString('hex');
  room.mobileTokens.set(token, { playerId: playerIndex, playerName: playerName || `P${playerIndex}`, pin });
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const url   = `${proto}://${host}/mobile?token=${token}&pin=${pin}&lang=${lang||'it'}`;
  try {
    const qr = await QRCode.toDataURL(url, { width:300, margin:2, color:{ dark:'#1a1200', light:'#f0e6c8' } });
    res.json({ mobileUrl: url, qrDataUrl: qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-qr', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const qr = await QRCode.toDataURL(url, { width:300, margin:2, color:{ dark:'#1a1200', light:'#f0e6c8' } });
    res.json({ qrDataUrl: qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Skin discovery ──────────────────────────────────────────────
// Skins are auto-discovered by scanning the skins/ directory.
// Each subfolder with a skin.json is registered automatically —
// no code changes needed to add a new skin.
// The 'standard' skin is always available (no files needed).
const SKINS_DIR = path.join(__dirname, '../skins');
if (require('fs').existsSync(SKINS_DIR)) {
  app.use('/skins', express.static(SKINS_DIR));
  app.get('/api/skins', (req, res) => {
    const fs = require('fs');
    try {
      const skins = [{ id: 'standard', name: 'Standard', preview: null, provides: [] }];
      const dirs = fs.readdirSync(SKINS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      for (const dir of dirs) {
        const jsonPath = path.join(SKINS_DIR, dir, 'skin.json');
        if (fs.existsSync(jsonPath)) {
          const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          meta.preview = meta.preview ? `/skins/${dir}/${meta.preview}` : null;
          skins.push(meta);
        }
      }
      res.json(skins);
    } catch(e) { res.json([{ id:'standard', name:'Standard', preview:null, provides:[] }]); }
  });
}

// ── PWA assets — serve with no-cache so updates propagate immediately
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, '../public/manifest.json'));
});

// ══════════════════════════════════════════════════════════════════
//  ROOM MANAGEMENT
//
//  rooms: Map<pin, { game, undoStack, mobileTokens, createdAt, pendingTrade }>
//    game         — CatanGame instance (null until START_GAME)
//    undoStack    — array of JSON snapshots (capped at 20)
//    mobileTokens — Map<token, { playerId, playerName, pin }>
//    pendingTrade — current player-to-player trade proposal (or null)
// ══════════════════════════════════════════════════════════════════
const rooms = new Map();

function createRoom() {
  let pin;
  do { pin = String(Math.floor(10000 + Math.random() * 90000)); }
  while (rooms.has(pin));
  rooms.set(pin, { game: null, undoStack: [], mobileTokens: new Map(), createdAt: Date.now(), pendingTrade: null });
  console.log(`🎲 Room ${pin} created (total: ${rooms.size})`);
  return pin;
}

// Stale room cleanup — runs every 30min, removes rooms older than 2h
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [pin, room] of rooms) {
    if (room.createdAt < cutoff) {
      rooms.delete(pin);
      console.log(`🗑  Room ${pin} expired`);
    }
  }
}, 30 * 60 * 1000);

// ── Undo stack ──────────────────────────────────────────────────
// pushUndo: save a snapshot before a mutating action.
//   Only allowed after dice roll OR during setup (no dice needed).
// popUndo: restore the latest snapshot and discard it.
function pushUndo(room) {
  const phase = room.game?.phase;
  if (!room.game?.diceRolled && phase !== 'setup1' && phase !== 'setup2') return;
  room.undoStack.push(JSON.stringify(room.game.getSerializableState()));
  if (room.undoStack.length > 20) room.undoStack.shift();
}
function popUndo(room) {
  if (!room.undoStack.length) return false;
  room.game.restoreFromState(JSON.parse(room.undoStack.pop()));
  return true;
}

// ── Broadcast helpers ───────────────────────────────────────────
// toRoom: send a message to every WebSocket in a room
function toRoom(pin, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.pin === pin) ws.send(msg);
  });
}

// mobileMap: returns { playerId: true } for each connected mobile client
// Used to show the phone icon on the admin player list
function mobileMap(pin) {
  const m = {};
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.pin === pin && ws.role === 'mobile' && ws.playerId != null)
      m[ws.playerId] = true;
  });
  return m;
}

// broadcastState: send the full game state to every client in the room.
// pendingTrade and undoAvailable are injected here (not stored in CatanGame)
// because they are room-level concerns, not game-engine concerns.
function broadcastState(pin) {
  const room = rooms.get(pin);
  if (!room) return;
  if (!room.game) { toRoom(pin, { type: 'STATE_UPDATE', state: null }); return; }
  const state = room.game.getState();
  state.mobileConnected = mobileMap(pin);
  state.undoAvailable   = room.undoStack.length > 0;
  state.pin             = pin;
  state.pendingTrade    = room.pendingTrade || null;
  toRoom(pin, { type: 'STATE_UPDATE', state });
}

// ══════════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════════

// Create a new room — called as soon as the setup screen loads
app.post('/api/create-room', (req, res) => {
  const pin = createRoom();
  res.json({ pin });
});

// Generate a player join token (QR + URL).
// Tokens are single-use identifiers stored per-room — they don't expire
// but are cleared when the room is destroyed or reset.
app.post('/api/generate-token', async (req, res) => {
  const { playerIndex, playerName, pin } = req.body;
  if (!pin || !rooms.has(pin)) return res.status(404).json({ error: 'Room not found' });
  const room  = rooms.get(pin);
  const token = crypto.randomBytes(12).toString('hex');
  room.mobileTokens.set(token, { playerId: playerIndex, playerName: playerName || `P${playerIndex}`, pin });
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const lang  = req.body.lang || 'en';
  const url    = `${proto}://${host}/mobile?token=${token}&pin=${pin}&lang=${lang}`;
  const webUrl = `${proto}://${host}/?token=${token}&pin=${pin}&lang=${lang}`;
  try {
    const qr = await QRCode.toDataURL(url, { width:300, margin:2, color:{ dark:'#1a1200', light:'#f0e6c8' } });
    res.json({ token, mobileUrl: url, webUrl, qrDataUrl: qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rejoin by PIN only — used when the token has expired but the game is still running.
// Returns player list so the client can let the user pick their slot.
app.get('/api/rejoin-by-pin', (req, res) => {
  const { pin, lang } = req.query;
  if (!pin || !rooms.has(pin)) return res.status(404).json({ error: 'room not found' });
  const room = rooms.get(pin);
  if (!room.game) return res.status(404).json({ error: 'game not started' });
  const players = room.game.getState().players.map((p, i) => ({ id: i, name: p.name, color: p.color }));
  res.json({ players, pin });
});

// Issue a fresh token for a specific player in an existing game (rejoin flow)
app.post('/api/rejoin-token', async (req, res) => {
  const { pin, playerIndex, lang } = req.body;
  if (!pin || !rooms.has(pin)) return res.status(404).json({ error: 'room not found' });
  const room = rooms.get(pin);
  if (!room.game) return res.status(404).json({ error: 'game not started' });
  const players = room.game.getState().players;
  if (playerIndex < 0 || playerIndex >= players.length) return res.status(400).json({ error: 'invalid player' });
  const token = crypto.randomBytes(12).toString('hex');
  room.mobileTokens.set(token, { playerId: playerIndex, playerName: players[playerIndex].name, pin });
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const url = `${proto}://${host}/mobile?token=${token}&pin=${pin}&lang=${lang||'it'}`;
  res.json({ token, url });
});

// Validate a token — called by mobile.html on load to confirm identity.
// Also returns gameActive so the client knows whether to wait or play.
app.get('/api/validate-token', (req, res) => {
  const { token, pin } = req.query;
  if (!pin || !rooms.has(pin)) return res.status(404).json({ error: 'room not found' });
  const info = rooms.get(pin).mobileTokens.get(token);
  if (!info) return res.status(404).json({ error: 'invalid token' });
  res.json({ ...info, gameActive: !!rooms.get(pin).game });
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mobile.html'));
});

app.get('/spectator', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/spectator.html'));
});

// ══════════════════════════════════════════════════════════════════
//  WEBSOCKET CONNECTION HANDLING
// ══════════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const pin   = url.searchParams.get('pin');
  const token = url.searchParams.get('token');

  if (token && pin) {
    // Mobile player — validated by token
    const room = rooms.get(pin);
    if (!room) { ws.close(4004, 'room not found'); return; }
    const info = room.mobileTokens.get(token);
    if (!info) { ws.close(4001, 'invalid token'); return; }
    ws.role = 'mobile'; ws.playerId = info.playerId; ws.pin = pin;
    console.log(`📱 Mobile p${info.playerId} in room ${pin}`);
  } else if (pin && rooms.has(pin)) {
    // Desktop/admin client with a known PIN
    ws.role = 'desktop'; ws.pin = pin;
    console.log(`🖥  Desktop room ${pin}`);
  } else {
    // Setup screen — no room yet
    ws.role = 'setup'; ws.pin = null;
    if (pin) ws.send(JSON.stringify({ type: 'ROOM_NOT_FOUND', pin }));
  }

  // Send current state and mobile connection map immediately on connect
  if (ws.pin) broadcastState(ws.pin);
  if (ws.pin) toRoom(ws.pin, { type:'MOBILE_STATUS', connected: mobileMap(ws.pin) });

  ws.on('message', raw => {
    try { handle(JSON.parse(raw), ws); } catch(e) { console.error(e); }
  });
  ws.on('close', () => {
    // Notify others when a mobile client disconnects
    if (ws.pin) toRoom(ws.pin, { type:'MOBILE_STATUS', connected: mobileMap(ws.pin) });
  });
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
//
//  All game-mutating messages follow the same pattern:
//    1. pushUndo(room)           — snapshot before mutation
//    2. room.game.<action>()     — mutate the game engine
//    3. broadcastState(pin)      — push new state to all clients
//
//  Exceptions:
//    SETUP_END_TURN — clears undoStack (no undo after confirming setup)
//    END_TURN       — clears undoStack and pendingTrade
//    UNDO           — pops the stack instead of pushing
//    TRADE_PLAYER   — proposal is stored in room.pendingTrade, not in
//                     the game engine, so the proposer can cancel it
//                     without an undo entry
// ══════════════════════════════════════════════════════════════════
function handle(msg, ws) {
  const pin  = ws.pin;
  const room = pin ? rooms.get(pin) : null;

  switch (msg.type) {

    case "PING": return; // keep-alive heartbeat, no response needed

    case 'START_GAME':
      if (!room) return;
      room.game = new CatanGame(msg.players, {
        desertCenter:      !!msg.desertCenter,
        zeroResources:     msg.zeroResources !== false, // default ON
        randomPorts:       !!msg.randomPorts,
        randomNumbers:     !!msg.randomNumbers,
        skinId:            msg.skinId || 'standard',
        debugDevCard:      msg.debugDevCard || null,
        debugResources:    !!msg.debugResources,
        debugForceDice:    msg.debugForceDice || null,
        quickGame:         !!msg.quickGame,
        unlimitedDev:      msg.unlimitedDev !== false, // default ON
        instantDev:        !!msg.instantDev,
        hiddenResources:   !!msg.hiddenResources,
        balancedResources: !!msg.balancedResources,
      });
      room.undoStack = [];
      broadcastState(pin);
      break;

    case 'RESET_GAME':
      if (room) { room.game = null; room.undoStack = []; room.mobileTokens.clear(); }
      broadcastState(pin);
      break;

    case 'PLACE_INITIAL_SETTLEMENT':
      if (room?.game) { pushUndo(room); room.game.placeInitialSettlement(msg.vertexId); broadcastState(pin); } break;
    case 'PLACE_INITIAL_ROAD':
      if (room?.game) { pushUndo(room); room.game.placeInitialRoad(msg.edgeId); broadcastState(pin); } break;

    // SETUP_END_TURN clears the undo stack — no going back after confirming placement
    case 'SETUP_END_TURN':
      if (room?.game) { room.game.setupEndTurn(); room.undoStack = []; broadcastState(pin); } break;

    case 'ROLL_DICE':
      if (room?.game) { room.game.rollDice(); broadcastState(pin); } break;

    case 'BUILD_SETTLEMENT':
      if (room?.game) { pushUndo(room); room.game.buildSettlement(msg.vertexId); broadcastState(pin); } break;
    case 'BUILD_CITY':
      if (room?.game) { pushUndo(room); room.game.buildCity(msg.vertexId); broadcastState(pin); } break;
    case 'BUILD_ROAD':
      if (room?.game) { pushUndo(room); room.game.buildRoad(msg.edgeId); broadcastState(pin); } break;
    case 'BUY_DEV_CARD':
      if (room?.game) { pushUndo(room); room.game.buyDevCard(); broadcastState(pin); } break;
    case 'PLAY_DEV_CARD':
      if (room?.game) { pushUndo(room); room.game.playDevCard(msg.cardType, msg.params); broadcastState(pin); } break;
    case 'TRADE_BANK':
      if (room?.game) { pushUndo(room); room.game.tradeWithBank(msg.give, msg.receive); broadcastState(pin); } break;

    case 'TRADE_PLAYER':
      if (!room?.game) break;
      if (msg.accepted) {
        // Target accepted — execute the trade.
        // In hiddenResources mode the proposer may have specified more than
        // the target actually has; tradeOffer() validates both sides first
        // and returns an error object instead of executing if validation fails.
        pushUndo(room);
        const tradeResult = room.game.tradeOffer(msg);
        room.pendingTrade = null;
        if (tradeResult?.error) {
          // Trade failed — broadcast updated state and send error to proposer
          broadcastState(pin);
          wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.pin === pin && c.playerId === msg.fromId) {
              c.send(JSON.stringify({ type: 'ACTION_ERROR', error: tradeResult.error, context: 'trade' }));
            }
          });
          break;
        }
      } else if (msg.rejected) {
        // Target rejected — clear proposal, no game state change
        room.pendingTrade = null;
      } else {
        // Proposer sending offer — store in room (not in game engine)
        // so it can be cancelled without consuming an undo slot
        room.pendingTrade = { fromId: msg.fromId, toId: msg.toId, offer: msg.offer, want: msg.want };
      }
      broadcastState(pin);
      break;

    case 'MOVE_ROBBER':
      if (room?.game) { pushUndo(room); room.game.moveRobber(msg.hexId); broadcastState(pin); } break;
    case 'STEAL_RESOURCE':
      if (room?.game) { pushUndo(room); room.game.stealResource(msg.targetPlayerId); broadcastState(pin); } break;

    // Discard does not push undo — there's no valid reason to undo a discard
    case 'DISCARD_RESOURCES':
      if (room?.game) { room.game.discardResources(msg.playerId, msg.resources); broadcastState(pin); } break;

    case 'END_TURN':
      if (room?.game) {
        const result = room.game.endTurn();
        if (result?.error) {
          // Tell the sender why the end-turn failed (e.g. others still discarding)
          const pendingNames = (room.game.pendingDiscard || [])
            .map(id => room.game.players[id]?.name).filter(Boolean);
          ws.send(JSON.stringify({
            type: 'ACTION_ERROR',
            error: result.error,
            context: 'end_turn',
            pendingDiscard: pendingNames
          }));
        } else {
          // Successful end-turn clears undo stack and pending trade
          room.undoStack = [];
          room.pendingTrade = null;
          broadcastState(pin);
        }
      }
      break;

    case 'UNDO':
      if (room && popUndo(room)) broadcastState(pin); break;

    case 'RENAME_PLAYER':
      if (room?.game) {
        const p = room.game.players[msg.playerId];
        if (p && msg.name) {
          p.name = String(msg.name).slice(0, 30); // cap at 30 chars
          broadcastState(pin);
        }
      }
      break;

    // Relay build-mode changes from mobile to desktop so the admin board
    // can highlight valid placement spots for the active mobile player
    case 'SET_BUILD_MODE': {
      if (!pin) return;
      const relay = JSON.stringify({ type:'SET_BUILD_MODE', mode:msg.mode, playerId:ws.playerId });
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.role === 'desktop' && c.pin === pin) c.send(relay);
      });
      break;
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏝️  Catan → http://localhost:${PORT}`);
});
