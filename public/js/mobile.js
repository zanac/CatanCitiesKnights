// ===================================================================
//  CATAN MOBILE CLIENT  —  public/js/mobile.js
//
//  Handles the phone player view (mobile.html).
//
//  Key responsibilities:
//    • Token validation on load (validate-token API)
//    • Canvas board with touch pan/pinch-zoom
//    • Bottom sheet UI: build buttons, trade, dev cards, discard
//    • showSetupPanel(): setup flow with explicit button→board tap
//    • MY_PLAYER_ID: the player this phone represents (set from token)
//    • window.SKIN: must be window.SKIN (not let) so i18n.js can read it
//
//  Build mode flow (setup):
//    1. Player presses settlement or road button → mobBuildMode set
//    2. Sheet collapses, board expands
//    3. Player taps board → piece placed, sheet re-expands
//    4. After road: pendingSetupEndTurn → End Turn button appears
//
//  Build mode flow (main game):
//    Same pattern but with real resource checks via updateBuildButtons().
//
//  Hidden resources:
//    state.hiddenResources ?? false is the default — other players'
//    resources are shown as '?' only when the option is explicitly on.
// ===================================================================

const RES_EMOJI  = { wood:'🪵', brick:'🧱', sheep:'🐑', wheat:'🌾', ore:'🪨', desert:'🏜' };
window.SKIN = null; // loaded skin for mobile — must be global for i18n.js

const DEV_CARD_DESC = {
  knight:       () => skinLabel('devcard_knight_desc', t('devcard_knight_desc')  || 'Sposta il brigante e ruba una risorsa'),
  victoryPoint: () => t('devcard_vp_desc') || '+1 Punto Vittoria (segreto)',
  roadBuilding: () => skinLabel('devcard_road_desc',   t('devcard_road_desc')    || 'Costruisci 2 strade gratis'),
  yearOfPlenty: () => skinLabel('devcard_yop_desc',    t('devcard_yop_desc')     || 'Prendi 2 risorse dalla banca'),
  monopoly:     () => skinLabel('devcard_mono_desc',   t('devcard_mono_desc')    || 'Tutti ti danno le loro carte di un tipo'),
};

const VP_CLASSIC_MOB = {
  chapel:     { name: '⛪ Cappella',    emoji: '⛪', desc: 'Un luogo di preghiera che porta prosperità al villaggio' },
  library:    { name: '📚 Biblioteca',  emoji: '📚', desc: 'La conoscenza è potere' },
  market:     { name: '🏪 Mercato',     emoji: '🏪', desc: 'Il cuore pulsante del commercio della colonia' },
  university: { name: '🎓 Università',  emoji: '🎓', desc: 'Menti brillanti che fanno prosperare la comunità' },
  palace:     { name: '🏰 Sala Grande', emoji: '🏰', desc: 'Il simbolo del potere e della grandezza del tuo regno' },
};

function getVPCardInfo(subtype) {
  const skinVP = SKIN?.vpCards?.[subtype];
  if (skinVP) return skinVP;
  return VP_CLASSIC_MOB[subtype] || { name: '⭐ Punto Vittoria', emoji: '⭐', desc: '' };
}

function getDevCardEmoji(card, subtype) {
  const map = {
    knight:       skinLabel('devname_knight',     '⚔️').split(' ')[0],
    victoryPoint: (subtype ? getVPCardInfo(subtype).emoji : '⭐'),
    roadBuilding: skinLabel('devname_road_build', '🛤').split(' ')[0],
    yearOfPlenty: skinLabel('devname_yop',        '🌻').split(' ')[0],
    monopoly:     skinLabel('devname_monopoly',   '👑').split(' ')[0],
  };
  return map[card] || '🃏';
}

let _skinLoadPromise = Promise.resolve();

async function loadMobileSkin(skinId) {
  if (!skinId || skinId === 'standard') { SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} }; return; }
  if (SKIN?.id === skinId) return; // already loaded
  try {
    const res = await fetch(`/skins/${skinId}/skin.json`);
    if (!res.ok) { SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} }; return; }
    const meta = await res.json();
    const hexImages = {};
    if (meta.provides?.includes('hex') && meta.hex) {
      await Promise.all(Object.entries(meta.hex).map(([type, path]) =>
        new Promise(resolve => {
          const img = new window.Image();
          img.onload  = () => { hexImages[type] = img; resolve(); };
          img.onerror = () => resolve();
          img.src = `/skins/${skinId}/${path}`;
        })
      ));
    }
    // Load robber image
    let robberImage = null;
    if (meta.provides?.includes('robber') && meta.robber) {
      robberImage = await new Promise(resolve => {
        const img = new window.Image();
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `/skins/${skinId}/${meta.robber}`;
      });
    }
    const buildingImages = {};
    if (meta.provides?.includes('buildings') && meta.buildings) {
      for (const [btype, colors] of Object.entries(meta.buildings)) {
        buildingImages[btype] = {};
        await Promise.all(Object.entries(colors).map(([color, path]) =>
          new Promise(resolve => {
            const img = new window.Image();
            img.onload  = () => { buildingImages[btype][color] = img; resolve(); };
            img.onerror = () => resolve();
            img.src = `/skins/${skinId}/${path}`;
          })
        ));
      }
    }
    const roadImages = {};
    if (meta.provides?.includes('roads') && meta.roads) {
      await Promise.all(Object.entries(meta.roads).map(([color, path]) =>
        new Promise(resolve => {
          const img = new window.Image();
          img.onload  = () => { roadImages[color] = img; resolve(); };
          img.onerror = () => resolve();
          img.src = `/skins/${skinId}/${path}`;
        })
      ));
    }
    const resourceNames = {};
    if (meta.resource_names) {
      for (const [res, name] of Object.entries(meta.resource_names)) {
        if (name) resourceNames[res] = name;
      }
    }
    const resourceEmojis = {};
    if (meta.resource_emojis) {
      for (const [res, emoji] of Object.entries(meta.resource_emojis)) {
        if (emoji) resourceEmojis[res] = emoji;
      }
    }
    // Load generic label overrides from skin (optional)
    const labels = meta.labels || {};
    const vpCards = meta.vp_cards || {};
    const devCards = meta.dev_cards || {};

    const vpImages = {};
    await Promise.all(Object.entries(vpCards).map(([subtype, info]) => {
      if (!info.image) return Promise.resolve();
      return new Promise(resolve => {
        const img = new window.Image();
        img.onload  = () => { vpImages[subtype] = img; resolve(); };
        img.onerror = () => resolve();
        img.src = `/skins/${skinId}/${info.image}`;
      });
    }));

    const devImages = {};
    await Promise.all(Object.entries(devCards).map(([card, info]) => {
      if (!info.image) return Promise.resolve();
      return new Promise(resolve => {
        const img = new window.Image();
        img.onload  = () => { devImages[card] = img; resolve(); };
        img.onerror = () => resolve();
        img.src = `/skins/${skinId}/${info.image}`;
      });
    }));

    SKIN = { id: skinId, hexImages, robberImage, buildingImages, roadImages, resourceNames, resourceEmojis, labels, vpCards, vpImages, devCards, devImages };
    applyMobileTranslations(); // re-apply skin label overrides to static DOM
    renderBoardCanvas();
    if (state) render(); // re-render dynamic labels/banners with new skin
    // If a dev card was drawn while skin was loading, re-show popup with correct image
    if (state?.lastDrawnCard) {
      const drawn = state.lastDrawnCard;
      if (drawn.playerId === MY_PLAYER_ID) showMobDevCardPopup(drawn);
    }
  } catch(e) { SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} }; }
}

function skinColorKey(hexColor) {
  if (!hexColor) return 'red';
  const h = hexColor.toLowerCase();
  const r=parseInt(h.slice(1,3),16)||0, g=parseInt(h.slice(3,5),16)||0, b=parseInt(h.slice(5,7),16)||0;
  if (r>150&&g>100&&b<80) return 'yellow';
  if (r>180&&g<120&&b<120) return 'red';
  if (b>150&&r<150) return 'blue';
  if (g>150&&r<120) return 'green';
  return 'red';
}
function skinBuildingImg(type, playerColor) {
  return SKIN?.buildingImages?.[type]?.[skinColorKey(playerColor)] || null;
}
function skinRoadImg(playerColor) {
  return SKIN?.roadImages?.[skinColorKey(playerColor)] || null;
}

const RES_COLORS = { wood:'#2d7a2d', brick:'#a03010', sheep:'#70c040', wheat:'#c8a020', ore:'#607090', desert:'#c8b070' };
const RES_LIST   = ['wood','brick','sheep','wheat','ore'];
function DEV_NAMES_MAP() { return {
  knight:       skinLabel('knight',       t('devname_knight')     || '⚔️ Knight'),
  victoryPoint: t('devname_vp')                                   || '⭐ Victory Point',
  roadBuilding: skinLabel('road_building', t('devname_road_build') || '🛤 Road Building'),
  yearOfPlenty: skinLabel('year_of_plenty',t('devname_yop')        || '🌻 Year of Plenty'),
  monopoly:     skinLabel('monopoly',      t('devname_monopoly')   || '👑 Monopoly'),
}; }
const DEV_NAMES = new Proxy({}, { get: (_,k) => DEV_NAMES_MAP()[k] });

// ── Identity ──────────────────────────────────────────────────────
const urlParams  = new URLSearchParams(location.search);
const MY_TOKEN   = urlParams.get('token');
const MY_PIN     = urlParams.get('pin');
let MY_PLAYER_ID = null;
let state        = null;

// ── Board viewport (pinch/pan transform) ──────────────────────────
// We keep a logical transform: scale + translation in canvas pixels
let cam = { scale:1, tx:0, ty:0 };
let BASE_HEX_SIZE = 1; // unit size from board coords
let boardMinCX, boardMaxCX, boardMinCY, boardMaxCY;
// pinch state
let pinchStart   = null; // {dist, cx, cy, camScale, camTx, camTy}
let panStart     = null; // {x, y, camTx, camTy}
let lastTapTime  = 0;

// ── Build mode ────────────────────────────────────────────────────
let mobBuildMode = null; // 'road'|'settlement'|'city'|'robber'|'knight'|'knight_move_target'|'knight_chase_target'|'knight_displace_target'|null
let knightActionFrom = null; // vertexId of the knight performing move/chase/displace, while targeting

// ── WebSocket ─────────────────────────────────────────────────────
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/?token=${MY_TOKEN}&pin=${MY_PIN}`);
  ws.onopen    = () => { console.log('Mobile WS connected'); document.body.classList.remove('gain-blocking'); const b=document.getElementById('mob-gain-banner'); if(b) b.style.display='none'; };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose   = (e) => {
    if (e.code === 4001) {
      setLoading(t('err_token_invalid') || '❌ QR scaduto — il server è stato riavviato.');
      // Prefill PIN from URL so user just needs to tap "Inserisci PIN" → "Entra"
      const pinFromUrl = new URLSearchParams(location.search).get('pin');
      if (pinFromUrl) {
        const pinInput = document.getElementById('pin-input');
        if (pinInput) pinInput.value = pinFromUrl;
      }
      showScanActions();
      // Auto-trigger PIN rejoin if we have the PIN
      if (pinFromUrl) { setTimeout(() => joinByPIN(), 300); }
      return;
    }
    if (e.code === 4004) { setLoading(t('err_room_not_found') || '❌ Partita non trovata.'); showScanActions(); return; }
    // Transient disconnect — retry
    setLoading(t('ws_reconnecting') || 'Riconnessione…');
    setTimeout(connectWS, 1500);
  };
  ws.onerror   = () => setLoading('Errore di connessione…');
}
function send(data) { if (ws?.readyState===1) ws.send(JSON.stringify(data)); }

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  if (!MY_TOKEN) { setLoading(t('err_token_missing')||'❌ Token mancante.'); showScanActions(); return; }
  setLoading(t('loading_token')||'Verifica token…');
  try {
    const res  = await fetch(`/api/validate-token?token=${MY_TOKEN}&pin=${MY_PIN}`);
    const info = await res.json();
    if (!res.ok) { setLoading(t('err_token_invalid')||'QR non valido.'); return; }
    MY_PLAYER_ID = info.playerId;
    const langParam = new URLSearchParams(location.search).get('lang');
    if (langParam && ['en','it','fr','de'].includes(langParam)) setLang(langParam);
    applyMobileTranslations();
    setLoading(t('loading_game'));
    connectWS();
  } catch(e) { setLoading(t('err_no_server')||'Server non raggiungibile.'); }
}

// ── Message handling ──────────────────────────────────────────────
function onMessage(data) {
  if (data.type === 'ACTION_ERROR') {
    if (data.context === 'end_turn' && data.pendingDiscard?.length) {
      const names = data.pendingDiscard.join(', ');
      showMobToast(`⏳ ${names} ${t('must_discard_first')||'must discard first'}`, 4000, 'toast-ko');
    } else {
      showMobToast(`⚠️ ${data.error}`, 3000, 'toast-ko');
    }
    return;
  }
  if (data.type !== 'STATE_UPDATE') return;
  const isFirstUpdate = (state === null);
  const prevRolled        = state?.diceRolled;
  const prevPendingTrade  = state?.pendingTrade || null;
  const prevPendingSteal  = state?.pendingSteal || false;
  const prevPendingRobber = state?.pendingRobber || false;
  const prevResources     = state ? state.players.map(p => ({...p.resources})) : null;
  const prevLastDrawn    = state?.lastDrawnCard || null;
  const prevMaxProgressSeq = Math.max(0, ...((state?.lastDrawnProgressCards)||[]).map(d => d.seq||0));
  const prevSpecials     = state ? state.players.map(p => ({
    hasLongestRoad: p.hasLongestRoad, hasLargestArmy: p.hasLargestArmy
  })) : null;
  const prevPoints       = state ? state.players.map(p => p.points) : null;
  state = data.state;
  if (!state) { setLoading(t('waiting_game')||'In attesa…'); return; }

  // Detect Longest Road / Largest Army badge changes
  if (!isFirstUpdate && prevSpecials && state) {
    for (const p of state.players) {
      const prev = prevSpecials[p.id];
      if (!prev) continue;
      if (p.hasLongestRoad && !prev.hasLongestRoad)
        showMobToast(`${skinLabel('longest_road_emoji','🛤')} ${escHtml(p.name)} — ${skinLabel('longest_road','Longest Road')}!`, 4000, 'toast-special');
      if (!p.hasLongestRoad && prev.hasLongestRoad)
        showMobToast(`${skinLabel('longest_road_emoji','🛤')} ${escHtml(p.name)} — ${t('log_lost_longest_road')||'lost Longest Road'}`, 4000, 'toast-special');
      if (p.hasLargestArmy && !prev.hasLargestArmy)
        showMobToast(`${skinLabel('largest_army_emoji','⚔️')} ${escHtml(p.name)} — ${skinLabel('largest_army','Largest Army')}!`, 4000, 'toast-special');
      if (!p.hasLargestArmy && prev.hasLargestArmy)
        showMobToast(`${skinLabel('largest_army_emoji','⚔️')} ${escHtml(p.name)} — ${t('log_lost_largest_army')||'lost Largest Army'}`, 4000, 'toast-special');
    }
  }

  // Cities & Knights: progress-card draw notifications — one per draw in the
  // roll (several players can draw), identified by a monotonic seq. The card
  // NAME is secret: only the owner sees it; everyone else sees just the color.
  const drawnProgress = state?.lastDrawnProgressCards || [];
  if (!isFirstUpdate) {
    for (const d of drawnProgress.filter(d => (d.seq||0) > prevMaxProgressSeq)) {
      const pName = state.players[d.playerId]?.name || '';
      const icon = PROGRESS_COLOR_ICON[d.color] || '📗';
      const what = d.playerId === MY_PLAYER_ID
        ? (PROGRESS_CARD_NAMES[d.type] || d.type)
        : (t('ck_progress_card_hidden') || 'una carta progresso');
      showMobToast(`${icon} ${escHtml(pName)} pesca: ${what}`, 3500);
    }
  }

  // Detect point gains — show to everyone
  if (prevPoints && state) {
    const gainers = state.players.filter(p => p.points > (prevPoints[p.id]||0));
    if (gainers.length > 0) {
      setTimeout(() => {
        for (const p of gainers) {
          const delta = p.points - (prevPoints[p.id]||0);
          showMobToast(
            `${escHtml(p.name)}  +${delta}⭐  →  ${p.points} pts`,
            2800 + gainers.indexOf(p) * 400,
            'toast-points'
          );
        }
      }, 300);
    }
  }

  // Detect dev card drawn (for any player — show to the drawer)
  const newDrawn = state?.lastDrawnCard;
  if (!isFirstUpdate && newDrawn && (!prevLastDrawn || prevLastDrawn.card !== newDrawn.card ||
      prevLastDrawn.subtype !== newDrawn.subtype ||
      prevLastDrawn.playerId !== newDrawn.playerId)) {
    if (newDrawn.playerId === MY_PLAYER_ID) {
      showMobDevCardPopup(newDrawn);
    } else {
      // Other player drew a card — brief toast only
      const cardEmoji = (newDrawn.card === 'victoryPoint' && newDrawn.subtype)
        ? getVPCardInfo(newDrawn.subtype).emoji : '🃏';
      const cardName = DEV_NAMES[newDrawn.card] || newDrawn.card;
      showMobToast(`${cardEmoji} ${cardName}`, 2000, 'toast-dev');
    }
  }

  // Detect trade resolution: I was the proposer, pendingTrade just cleared
  // Detect steal resolution — show resource changes to all players
  const stealJustResolved = !isFirstUpdate && (
    (prevPendingSteal  && !state.pendingSteal) ||
    (prevPendingRobber && !state.pendingRobber && !state.pendingSteal)
  );
  if (stealJustResolved && prevResources && state) {
    try {
      const deltas = {};
      let anyChange = false;
      for (const p of state.players) {
        deltas[p.id] = {};
        for (const res of ['wood','brick','sheep','wheat','ore']) {
          const diff = (p.resources[res]||0) - (prevResources[p.id][res]||0);
          if (diff !== 0) { deltas[p.id][res] = diff; anyChange = true; }
        }
      }
      if (anyChange) showMobStealDelta(deltas);
    } catch(e) { console.warn('steal delta error:', e); }
  }

  if (!isFirstUpdate && prevPendingTrade && !state.pendingTrade &&
      prevPendingTrade.fromId === MY_PLAYER_ID && prevResources) {
    const toPlayer = state.players[prevPendingTrade.toId];
    // Check if resources actually changed (accepted) or not (rejected)
    let changed = false;
    for (const res of ['wood','brick','sheep','wheat','ore']) {
      if ((state.players[MY_PLAYER_ID]?.resources[res]||0) !== (prevResources[MY_PLAYER_ID]?.[res]||0)) {
        changed = true; break;
      }
    }
    if (changed) {
      showMobToast(t('trade_accepted_toast', escHtml(toPlayer?.name||'?')), 2500, 'toast-ok');
    } else {
      showMobToast(t('trade_rejected_toast', escHtml(toPlayer?.name||'?')), 2500, 'toast-ko');
    }
  }

  // Load skin if changed
  if (state?.skinId && state.skinId !== (SKIN?.id ?? 'standard')) {
    _skinLoadPromise = loadMobileSkin(state.skinId);
  }
  render(prevRolled);
}

// ── Screens ───────────────────────────────────────────────────────
function showMobPlayersSummary() {
  if (!state) return;
  const popup = document.getElementById('mob-players-summary-popup');
  const content = document.getElementById('mob-players-summary-content');
  if (!popup || !content) return;

  const curIdx = state.phase === 'main' ? state.currentPlayerIndex
               : (state.setupOrder?.[state.setupStep] ?? 0);

  const hidden = state.hiddenResources ?? false;

  content.innerHTML = state.players.map(p => {
    const isMe = p.id === MY_PLAYER_ID;
    const isCur = p.id === curIdx;
    const totalCards = Object.values(p.resources).reduce((a,b) => a+b, 0);
    const devCount = p.devCards?.length || 0;

    // Badges
    const badges = [
      p.hasLongestRoad ? `<span style="font-size:.85rem">${skinLabel('longest_road_emoji','🛤')}🥇</span>` : '',
      p.hasLargestArmy ? `<span style="font-size:.85rem">${skinLabel('largest_army_emoji','⚔️')}🥇</span>` : '',
    ].join('');

    // Resources: show own always, others only if !hidden
    const resRow = isMe || !hidden
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${
          ['wood','brick','sheep','wheat','ore'].map(r => {
            const n = p.resources[r] || 0;
            return `<span style="background:rgba(255,255,255,.08);border-radius:6px;padding:2px 7px;font-size:.82rem">${resEmoji(r)} ${n}</span>`;
          }).join('')
        }</div>`
      : `<div style="color:#888;font-size:.82rem;margin-top:4px">🃏 ${totalCards} ${t('cards')||'carte'}</div>`;

    return `<div style="
        border:1.5px solid ${isCur ? p.color : 'rgba(255,255,255,.1)'};
        border-radius:12px;padding:10px 12px;margin-bottom:10px;
        background:${isCur ? 'rgba(255,255,255,.05)' : 'transparent'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
        <span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block;flex-shrink:0"></span>
        <span style="color:${p.color};font-weight:bold;font-size:.95rem">${escHtml(p.name)}</span>
        ${isMe ? '<span style="font-size:.7rem;color:#888;background:rgba(255,255,255,.1);border-radius:8px;padding:1px 6px">Tu</span>' : ''}
        ${isCur ? '<span style="font-size:.7rem;color:#f0c040;background:rgba(200,164,74,.15);border-radius:8px;padding:1px 6px">▶</span>' : ''}
        <span style="margin-left:auto;color:#f0c040;font-weight:bold">⭐ ${p.points}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;font-size:.82rem;color:#aaa;margin-top:3px">
        ${devCount > 0 ? `<span>🃏 ${devCount}</span>` : ''}
        ${badges}
        ${(p.knightsPlayed||0) > 0 ? `<span>${skinLabel('largest_army_emoji','⚔️')}×${p.knightsPlayed}</span>` : ''}
      </div>
      ${resRow}
    </div>`;
  }).join('');

  popup.style.display = 'flex';
}

async function showMobGuide() {
  // Wait for skin to finish loading before rendering
  await _skinLoadPromise;
  const popup = document.getElementById('mob-guide-popup');
  const content = document.getElementById('mob-guide-content');
  const title = document.getElementById('mob-guide-title');
  if (!popup || !content) return;

  title.textContent = t('guide_title') || 'Guida Rapida';

  const r = resEmoji;
  const sl = skinLabel;

  const row = (icon, name, cost) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.07);">
      <span style="font-size:1.1rem">${icon}</span>
      <span style="flex:1;color:#e0d0a0">${name}</span>
      <span style="color:#c8b080;font-size:.85rem">${cost}</span>
    </div>`;

  const section = (label) =>
    `<div style="color:#c8a84b;font-weight:bold;margin:12px 0 4px;font-size:.85rem;text-transform:uppercase;letter-spacing:.5px">${label}</div>`;

  let html = section(t('guide_build') || 'Costruzioni');
  html += row('🛤', sl('road', t('guide_road')||'Strada'),           `${r('wood')}+${r('brick')}`);
  html += row('🏠', sl('settlement', t('guide_settlement')||'Villaggio'), `${r('wood')}+${r('brick')}+${r('sheep')}+${r('wheat')}`);
  html += row('🏙', sl('city', t('guide_city')||'Città'),            `${r('wheat')}${r('wheat')}+${r('ore')}${r('ore')}${r('ore')}`);
  html += row('🃏', t('guide_dev')||'Sviluppo',                      `${r('sheep')}+${r('wheat')}+${r('ore')}`);

  html += section(t('guide_specials') || 'Speciali');
  html += row('🛤🥇', sl('longest_road', t('guide_longest_road')||'Longest Road'), t('guide_longest_road_desc')||'5+ strade → +2⭐');
  html += row('⚔️🥇', sl('largest_army', t('guide_largest_army')||'Largest Army'), t('guide_largest_army_desc')||'3+ cavalieri → +2⭐');

  html += section(t('guide_ports') || 'Porti');
  // 2:1 ports for each resource
  for (const res of ['wood','brick','sheep','wheat','ore']) {
    html += row(r(res), `2:1 ${sl(`port_${res}`, r(res))}`, `2${r(res)} = 1 qualsiasi`);
  }
  html += row('🎲', t('guide_port_generic')||'3:1 generico', '');

  content.innerHTML = html;
  popup.style.display = 'flex';

  // Close on backdrop tap
  popup.onclick = () => { popup.style.display = 'none'; };
}

function restartMobile() {
  // Navigate to root setup screen
  window.location.href = '/';
}

function showScanActions() {
  const el = document.getElementById('loading-actions');
  const spinner = document.getElementById('loading-spinner');
  if (el) el.style.display = 'flex';
  if (spinner) spinner.style.display = 'none';

  // Show camera button only on HTTPS
  const scanBtn = document.getElementById('btn-scan-qr');
  if (scanBtn) {
    scanBtn.style.display = location.protocol === 'https:' ? 'block' : 'none';
  }
}

function hideScanActions() {
  const el = document.getElementById('loading-actions');
  const spinner = document.getElementById('loading-spinner');
  if (el) el.style.display = 'none';
  if (spinner) spinner.style.display = '';
  const pinEntry = document.getElementById('pin-entry');
  if (pinEntry) pinEntry.style.display = 'none';
}

function startQRScan() {
  document.getElementById('qr-file-input')?.click();
}

function loadJsQR() {
  return new Promise((resolve) => {
    if (window.jsQR) { resolve(); return; }
    // Try multiple CDNs
    const cdns = [
      '/js/jsQR.js',  // local — always available
      'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
      'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js',
    ];
    let i = 0;
    function tryNext() {
      if (i >= cdns.length) { resolve(); return; }
      const s = document.createElement('script');
      s.src = cdns[i++];
      s.onload = resolve;
      s.onerror = tryNext;
      document.head.appendChild(s);
    }
    tryNext();
  });
}

async function handleQRFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  setLoading('🔍 Lettura QR…');
  document.getElementById('loading-spinner').style.display = 'none';

  await loadJsQR();

  if (!window.jsQR) {
    setLoading('❌ Libreria QR non disponibile. Inserisci il PIN manualmente.');
    showScanActions();
    return;
  }

  // Timeout — if stuck for 8s show error
  const timeout = setTimeout(() => {
    setLoading('❌ Lettura QR troppo lenta. Usa il PIN manualmente.');
    showScanActions();
  }, 8000);

  const reader = new FileReader();
  reader.onload = (e) => { clearTimeout(timeout); decodeQRFromDataURL(e.target.result); };
  reader.onerror = () => { clearTimeout(timeout); setLoading('❌ Errore lettura file.'); showScanActions(); };
  reader.readAsDataURL(file);
}

function decodeQRFromDataURL(dataURL) {
  const img = new Image();
  img.onload = () => {
    // Try multiple resolutions to handle low-res or large camera images
    const sizes = [
      [img.width, img.height],
      [800, Math.round(800 * img.height / img.width)],
      [400, Math.round(400 * img.height / img.width)],
    ];
    for (const [w, h] of sizes) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
      if (code?.data) {
        hideScanActions();
        if (code.data.startsWith('http')) {
          // Try to extract PIN from URL and do rejoin flow instead of direct nav
          const scannedUrl = new URL(code.data);
          const scannedPin = scannedUrl.searchParams.get('pin');
          const scannedToken = scannedUrl.searchParams.get('token');
          if (scannedPin && scannedToken) {
            // First try direct navigation — if token is still valid it works
            // If not, the error handler will show scan actions with PIN prefilled
            const pinInput = document.getElementById('pin-input');
            if (pinInput) pinInput.value = scannedPin;
            window.location.href = code.data;
          } else {
            window.location.href = code.data;
          }
        } else {
          const pinInput = document.getElementById('pin-input');
          if (pinInput) pinInput.value = code.data.replace(/[^0-9]/g,'').slice(0,5);
          joinByPIN();
        }
        return;
      }
    }
    setLoading('❌ QR non riconosciuto. Prova ad inquadrarlo meglio o inserisci il PIN manualmente.');
    showScanActions();
  };
  img.src = dataURL;
}

function showPINEntry() {
  const el = document.getElementById('pin-entry');
  if (el) el.style.display = 'flex';
}

async function joinByPIN() {
  const pin = document.getElementById('pin-input')?.value?.trim();
  if (!pin || !/^\d{5}$/.test(pin)) {
    setLoading('❌ PIN non valido — deve essere 5 cifre.');
    showScanActions();
    return;
  }
  hideScanActions();
  setLoading('🔍 Cerco la partita…');
  try {
    const res = await fetch(`/api/rejoin-by-pin?pin=${pin}`);
    if (!res.ok) { setLoading('❌ Partita non trovata con questo PIN.'); showScanActions(); return; }
    const data = await res.json();
    showPlayerSelection(pin, data.players);
  } catch(e) {
    setLoading('❌ Server non raggiungibile.');
    showScanActions();
  }
}

function showPlayerSelection(pin, players) {
  const lang = new URLSearchParams(location.search).get('lang') || 'it';
  const el = document.getElementById('loading-actions');
  if (!el) return;
  el.style.display = 'flex';
  el.innerHTML = `
    <p style="color:#c8a84b;font-weight:bold;margin-bottom:8px">Sei:</p>
    ${players.map(p => `
      <button onclick="selectPlayer(${p.id}, '${pin}', '${lang}')"
        style="padding:10px 24px;margin:4px;font-size:1rem;border-radius:10px;
               border:2px solid ${p.color};background:rgba(0,0,0,.3);color:${p.color};font-weight:bold;">
        ${p.name}
      </button>`).join('')}
    <button onclick="showScanActions()" style="margin-top:10px;padding:8px 20px;font-size:.9rem;
      border-radius:8px;border:1px solid #555;background:transparent;color:#aaa;">↩ Indietro</button>`;
}

async function selectPlayer(playerIndex, pin, lang) {
  setLoading('🔗 Connessione…');
  try {
    const res = await fetch('/api/rejoin-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, playerIndex, lang })
    });
    if (!res.ok) { setLoading('❌ Errore nella connessione.'); showScanActions(); return; }
    const data = await res.json();
    window.location.href = data.url;
  } catch(e) {
    setLoading('❌ Server non raggiungibile.');
    showScanActions();
  }
}

function setLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
  showScreen('screen-loading');
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Dev card drawn popup ──────────────────────────────────────────
function showMobDevCardPopup(drawn) {
  const player = state?.players[drawn.playerId];
  if (!player) return;

  const card    = drawn.card;
  const subtype = drawn.subtype || null;
  const emoji   = getDevCardEmoji(card, subtype);
  const name    = (card === 'victoryPoint' && subtype)
    ? getVPCardInfo(subtype).name
    : (DEV_NAMES[card] || card);
  const vpInfo  = (card === 'victoryPoint' && subtype) ? getVPCardInfo(subtype) : null;
  const desc    = vpInfo?.desc || DEV_CARD_DESC[card]?.() || '';
  const isVP    = card === 'victoryPoint';

  let el = document.getElementById('mob-modal-dev-drawn');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mob-modal-dev-drawn';
    el.className = 'mob-modal open';
    document.body.appendChild(el);
  }

  const vpImg  = (isVP && subtype) ? SKIN?.vpImages?.[subtype] : null;
  const devImg  = (!isVP) ? SKIN?.devImages?.[card] : null;
  const cardImg = vpImg || devImg || null;

  const emojiHtml = cardImg
    ? `<img src="${cardImg.src}" style="width:120px;height:120px;object-fit:cover;border-radius:12px;margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;">`
    : `<div class="dev-drawn-emoji">${emoji}</div>`;

  el.innerHTML = `
    <div class="mob-modal-inner" style="text-align:center;padding:28px 20px;" onclick="document.getElementById('mob-modal-dev-drawn').classList.remove('open')">
      <div class="mob-modal-drag"></div>
      ${emojiHtml}
      <div class="dev-drawn-name">${name}</div>
      <div class="dev-drawn-player" style="color:${player.color}">${player.name}</div>
      <div class="dev-drawn-desc">${desc}</div>
      ${isVP ? '' : `<p class="dev-drawn-hint">(${t('next_turn_badge')||'prossimo turno'})</p>`}
      <button class="mob-big-btn primary" onclick="document.getElementById('mob-modal-dev-drawn').classList.remove('open')">OK</button>
    </div>`;

  el.classList.add('open');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('open'), 30000);
}

// ── Master render ─────────────────────────────────────────────────
let lastPhase = null; // track phase changes to reset build mode

function render(prevRolled) {
  if (!state) return;



  const isSetup = state.phase==='setup1' || state.phase==='setup2';
  const curIdx  = isSetup ? (state.setupOrder?.[state.setupStep]??0) : state.currentPlayerIndex;
  const isMyTurn = curIdx === MY_PLAYER_ID;

  // Reset build mode when phase transitions (setup → main, or turn changes)
  const phaseKey = state.phase + ':' + curIdx + ':' + state.waitingForRoad;
  if (phaseKey !== lastPhase) {
    if (mobBuildMode && (mobBuildMode.endsWith('_initial') || mobBuildMode === 'robber')) {
      setMobBuildMode(null);
    }
    lastPhase = phaseKey;
  }

  updateMyResources();
  if (state.winner !== null) { showWinner(); return; }


  // ── Proposta di scambio in arrivo per ME — mostra modale SEMPRE,
  //    anche se non è il mio turno
  const pt = state.pendingTrade;
  if (pt && pt.toId === MY_PLAYER_ID) {
    const modal = document.getElementById('mob-modal-accept');
    if (!modal.classList.contains('open')) showTradeAccept(pt);
  } else {
    // Chiudi modale se la proposta è stata risolta
    const modal = document.getElementById('mob-modal-accept');
    if (modal.classList.contains('open') && !pt) closeMobModal('mob-modal-accept');
  }

  // ── Discard richiesto a ME anche se non è il mio turno ──────────
  const myDiscard = state.pendingDiscard?.includes(MY_PLAYER_ID);
  if (myDiscard) {
    // Show the active screen so the discard panel is accessible
    showScreen('screen-active');
    hideWaitOverlay();
    renderTopBar(curIdx);
    const wrap0 = document.getElementById('mob-board-wrap');
    if (!boardCanvas.width || !BASE_HEX_SIZE ||
        (wrap0.clientWidth && boardCanvas.width !== wrap0.clientWidth)) {
      fitBoardToScreen();
    }
    renderBoardCanvas();
    renderActionPanel(); // will call showDiscardPanel()
    return;
  }

  // ── Cities & Knights: knight-displacement retreat choice required from
  //    ME (the player whose knight was displaced), even if it's not my turn —
  //    resolved by tapping the highlighted vertex on the board (see
  //    handleBoardTap), not through a modal.
  const myKnightDisplace = state.citiesKnights && state.pendingKnightDisplace?.playerId === MY_PLAYER_ID;
  if (myKnightDisplace) {
    showScreen('screen-active');
    hideWaitOverlay();
    renderTopBar(curIdx);
    const banner=document.getElementById('mob-build-banner');
    banner.textContent = t('mob_build_label_knight_retreat') || 'Tocca dove ritirare il tuo cavaliere';
    banner.classList.remove('hidden');
    renderBoardCanvas();
    return;
  }

  // ── Cities & Knights: barbarian city-loss choice required from ME,
  //    even if it's not my turn (the attack can happen on anyone's roll) ──
  const myBarbarianChoice = state.citiesKnights && state.pendingBarbarianChoices?.length > 0 &&
    state.pendingBarbarianChoices[0].playerId === MY_PLAYER_ID;
  if (myBarbarianChoice) {
    showScreen('screen-active');
    hideWaitOverlay();
    renderTopBar(curIdx);
    showBarbarianCityChoice(state.pendingBarbarianChoices[0]);
    return;
  } else {
    const modal = document.getElementById('mob-modal-barbarian-choice');
    if (modal.classList.contains('open')) closeMobModal('mob-modal-barbarian-choice');
  }

  // ── Cities & Knights: progress-card hand-limit discard required from ME,
  //    even if it's not my turn ──
  const myProgressDiscard = state.citiesKnights && state.pendingProgressDiscard?.includes(MY_PLAYER_ID);
  if (myProgressDiscard) {
    showScreen('screen-active');
    hideWaitOverlay();
    renderTopBar(curIdx);
    showProgressDiscardChoice(MY_PLAYER_ID);
    return;
  } else {
    const modal = document.getElementById('mob-modal-progress-discard');
    if (modal.classList.contains('open')) closeMobModal('mob-modal-progress-discard');
  }

  // ── Cities & Knights: tied Defender of Catan — MY color pick is required,
  //    even if it's not my turn (the attack can happen on anyone's roll) ──
  const myDefenderChoice = state.citiesKnights && state.pendingDefenderCardChoice?.includes(MY_PLAYER_ID);
  if (myDefenderChoice) {
    showScreen('screen-active');
    hideWaitOverlay();
    renderTopBar(curIdx);
    showDefenderColorChoice(MY_PLAYER_ID);
    return;
  } else {
    const modal = document.getElementById('mob-modal-defender-choice');
    if (modal.classList.contains('open')) closeMobModal('mob-modal-defender-choice');
  }

  // Cities & Knights: keep the knights/improvements modals in sync with the
  // server on every broadcast (never optimistically from local state — the
  // improvements dots were lagging one purchase behind before this fix).
  if (document.getElementById('mob-modal-knights')?.classList.contains('open')) {
    renderMobKnightsList();
  }
  if (document.getElementById('mob-modal-improvements')?.classList.contains('open')) {
    renderMobImprovementsList();
  }

  if (!isMyTurn) { renderWaitScreen(curIdx); return; }

  showScreen('screen-active');
  hideWaitOverlay();  // ensure wait overlay is hidden when it's my turn
  renderTopBar(curIdx);
  // Init board transform if not yet done or board size changed
  const wrap = document.getElementById('mob-board-wrap');
  if (!boardCanvas.width || !BASE_HEX_SIZE ||
      (wrap.clientWidth && boardCanvas.width !== wrap.clientWidth)) {
    fitBoardToScreen();
  }
  renderBoardCanvas();
  renderActionPanel();

  if (!prevRolled && state.diceRolled && state.diceValues?.[0]) {
    document.body.classList.add("gain-blocking"); // block actions during dice anim
    playDiceAnim(state.diceValues[0], state.diceValues[1]);
  }
}

// ── Wait screen ───────────────────────────────────────────────────
function renderWaitScreen(curIdx) {
  // Use screen-active so board stays visible — but show wait overlay
  showScreen('screen-active');
  const p  = state.players[curIdx];
  const me = state.players[MY_PLAYER_ID];

  // Top bar: whose turn
  const badge = document.getElementById('mob-player-badge');
  badge.textContent = p.name;
  badge.style.color = badge.style.borderColor = p.color;
  document.getElementById('mob-phase-label').textContent =
    state.phase==='main'
      ? (state.diceRolled ? t('phase_building',p.name) : t('phase_rolling',p.name))
      : t('phase_placing',p.name);
  // Show current player's medals
  let pMedals = document.getElementById('mob-wait-medals');
  const pMedalHTML = [
    p.hasLongestRoad ? `<span class="mob-medal road-medal" title="${skinLabel('longest_road','Longest Road')}">${skinLabel('longest_road_emoji','🛤')}🥇</span>` : '',
    p.hasLargestArmy ? `<span class="mob-medal army-medal" title="${skinLabel('largest_army','Largest Army')}">${skinLabel('largest_army_emoji','⚔️')}🥇</span>` : '',
    (p.knightsPlayed||0)>0 && !p.hasLargestArmy ? `<span class="mob-medal knight-count">⚔️×${p.knightsPlayed}</span>` : '',
    state.citiesKnights && ['trade','politics','science'].some(tr=>state.metropolises?.[tr]?.playerId===p.id)
      ? `<span class="mob-medal ck-metro-medal">🏛️</span>` : '',
  ].join('');
  if (pMedalHTML) {
    if (!pMedals) {
      pMedals = document.createElement('div');
      pMedals.id = 'mob-wait-medals';
      pMedals.style.cssText='display:flex;gap:4px;flex-shrink:0;';
      document.getElementById('mob-sheet-header').appendChild(pMedals);
    }
    pMedals.innerHTML = pMedalHTML;
  } else if (pMedals) pMedals.innerHTML = '';

  // Dice
  const d1=document.getElementById('mob-die1'), d2=document.getElementById('mob-die2');
  d1.textContent = state.diceValues?.[0] ? dieChar(state.diceValues[0]) : '?';
  d2.textContent = state.diceValues?.[1] ? dieChar(state.diceValues[1]) : '?';

  // Resources (mine)
  if (me) {
    const ckPills = state.citiesKnights ? [
      `<div class="mob-res-pill"><span>📜</span><span class="n">${me.commodities?.paper||0}</span></div>`,
      `<div class="mob-res-pill"><span>🧵</span><span class="n">${me.commodities?.cloth||0}</span></div>`,
      `<div class="mob-res-pill"><span>🪙</span><span class="n">${me.commodities?.coin||0}</span></div>`,
    ].join('') : '';
    document.getElementById('mob-resources').innerHTML =
      RES_LIST.map(r=>`<div class="mob-res-pill"><span>${resEmoji(r)}</span><span class="n">${me.resources[r]||0}</span></div>`).join('') + ckPills;
  }

  // Board
  const wrap = document.getElementById('mob-board-wrap');
  if (!boardCanvas.width || !BASE_HEX_SIZE ||
      (wrap.clientWidth && boardCanvas.width !== wrap.clientWidth)) {
    fitBoardToScreen();
  }
  renderBoardCanvas();

  // Hide all panels — board + resources are visible, no overlay text needed
  document.querySelectorAll('.mob-panel').forEach(el => el.classList.remove('active'));
  hideWaitOverlay(); // no blocking overlay — player can see the board freely
}

function hideWaitOverlay() {
  const el = document.getElementById('mob-wait-overlay');
  if (el) el.style.display = 'none';
}

// ── Top bar (active turn) ─────────────────────────────────────────
function renderTopBar(curIdx) {
  const me = state.players[MY_PLAYER_ID];
  const badge = document.getElementById('mob-player-badge');
  badge.textContent = me.name;
  badge.style.color = badge.style.borderColor = me.color;

  const isSetup = state.phase==='setup1'||state.phase==='setup2';
  document.getElementById('mob-phase-label').textContent = isSetup
    ? (state.waitingForRoad ? skinLabel('road', t('phase_place_road')) : skinLabel('settlement', t('phase_place_sett')))
    : (state.diceRolled ? t('phase_build') : t('phase_roll'));

  // Show knight counter if I have played any


  const d1=document.getElementById('mob-die1'), d2=document.getElementById('mob-die2');
  d1.textContent = state.diceValues?.[0] ? dieChar(state.diceValues[0]) : '?';
  d2.textContent = state.diceValues?.[1] ? dieChar(state.diceValues[1]) : '?';
}

function updateMyResources() {
  const me = state?.players?.[MY_PLAYER_ID];
  const el = document.getElementById('mob-resources');
  if (!me||!el) return;
  const pills = RES_LIST.map(r=>{
    const n=me.resources[r]||0;
    return `<div class="mob-res-pill"><span>${resEmoji(r)}</span><span class="n">${n}</span></div>`;
  }).join('');
  // Medal badges
  const medals = [
    me.hasLongestRoad ? `<span class="mob-medal road-medal" title="${skinLabel('longest_road','Longest Road')}">${skinLabel('longest_road_emoji','🛤')}🥇</span>` : '',
    me.hasLargestArmy ? `<span class="mob-medal army-medal" title="${skinLabel('largest_army','Largest Army')}">${skinLabel('largest_army_emoji','⚔️')}🥇</span>` : '',
    (me.knightsPlayed||0)>0 && !me.hasLargestArmy ? `<span class="mob-medal knight-count">⚔️×${me.knightsPlayed}</span>` : '',
  ].join('');
  el.innerHTML = pills + (medals ? `<div class="mob-medals-row">${medals}</div>` : '');
}

// ── Action panel ──────────────────────────────────────────────────
function renderActionPanel() {
  document.querySelectorAll('.mob-panel').forEach(p=>p.classList.remove('active'));

  const isSetup = state.phase==='setup1'||state.phase==='setup2';
  const pending = state.pendingRobber||state.pendingSteal;
  const discard = state.pendingDiscard?.includes(MY_PLAYER_ID);

  // Reset panel flag if no longer in pendingDiscard
  if (!discard && discardPanelBuilt) discardPanelBuilt = false;

  if (discard)                                    { showDiscardPanel(); return; }
  if (state.pendingSteal&&state.robberCandidates?.length>1) { showStealPanel(); return; }
  if (pending)                                    { showRobberPanel(); return; }
  // Remove panels BEFORE expanding sheet to prevent touch interception
  document.getElementById('mob-robber-panel')?.classList.remove('active');
  document.getElementById('mob-steal-panel')?.classList.remove('active');
  // Don't expand sheet during setup if build mode is active (board should stay large)
  if (!isSetup || !mobBuildMode) expandSheet();
  // Hide setup header buttons when not in setup
  document.getElementById('mob-setup-header-btns')?.classList.add('hidden');
  if (isSetup) { showSetupPanel(); return; }
  if (!state.diceRolled) {
    document.getElementById('mob-roll-panel').classList.add('active');
    // Also show dev card btn in roll panel if knight is available
    const me2  = state.players[MY_PLAYER_ID];
    const hasK = !state.citiesKnights && (me2?.devCards||[]).some(c=>!c.new&&c.type==='knight');
    let knightBtn = document.getElementById('mob-knight-shortcut');
    if (hasK && !knightBtn) {
      knightBtn = document.createElement('button');
      knightBtn.id = 'mob-knight-shortcut';
      knightBtn.className = 'mob-big-btn knight-btn';
      knightBtn.innerHTML = '⚔️ ' + (DEV_NAMES.knight || 'Knight');
      knightBtn.onclick = () => {
        send({ type:'PLAY_DEV_CARD', cardType:'knight', params:{} });
        knightBtn.remove();
      };
      document.getElementById('mob-roll-panel').appendChild(knightBtn);
    } else if (!hasK && knightBtn) {
      knightBtn.remove();
    }
    return;
  }

  document.getElementById('mob-main-panel').classList.add('active');
  updateBuildButtons();
  // Auto-activate road build mode for Road Building card
  if (state.pendingRoadBuilding > 0 && mobBuildMode !== 'road') {
    setMobBuildMode('road');
  }
}

function showSetupPanel() {
  // ── Header: phase label + undo/endturn buttons ──
  document.getElementById('mob-phase-label').textContent =
    state.waitingForRoad
      ? skinLabel('road', t('phase_place_road'))
      : skinLabel('settlement', t('phase_place_sett'));

  const hdrBtns = document.getElementById('mob-setup-header-btns');
  const hdrUndo = document.getElementById('mob-hdr-undo');
  const hdrEnd  = document.getElementById('mob-hdr-end-turn');
  if (hdrBtns) hdrBtns.classList.remove('hidden');
  if (hdrUndo) hdrUndo.disabled = !state.undoAvailable;
  if (hdrEnd)  hdrEnd.disabled  = !state.pendingSetupEndTurn;

  // ── Clear stale build mode if sub-step changed ──
  if (state.waitingForRoad  && mobBuildMode === 'settlement_initial') mobBuildMode = null;
  if (!state.waitingForRoad && mobBuildMode === 'road_initial')       mobBuildMode = null;

  // ── Sheet + banner ──
  const banner = document.getElementById('mob-build-banner');

  if (state.pendingSetupEndTurn) {
    // Road placed — expand sheet, show end-turn confirmation
    mobBuildMode = null;
    expandSheet();
    banner.classList.add('hidden');
    document.getElementById('mob-setup-panel').classList.add('active');
    document.getElementById('mob-setup-place-btns').style.display   = 'none';
    document.getElementById('mob-setup-confirm-btns').style.display = '';

  } else if (mobBuildMode) {
    // User pressed a button — board large, show placement hint
    collapseSheet();
    document.getElementById('mob-setup-place-btns').style.display   = 'flex';
    document.getElementById('mob-setup-confirm-btns').style.display = 'none';
    banner.textContent = mobBuildMode === 'road_initial'
      ? skinLabel('road',       t('mob_build_label_road')       || 'Tap an edge for the road')
      : skinLabel('settlement', t('mob_build_label_settlement') || 'Tap a vertex for the settlement');
    banner.classList.remove('hidden');

  } else {
    // Waiting for button press — sheet open, show road/settlement buttons
    expandSheet();
    banner.classList.add('hidden');
    document.getElementById('mob-setup-panel').classList.add('active');
    document.getElementById('mob-setup-place-btns').style.display   = 'flex';
    document.getElementById('mob-setup-confirm-btns').style.display = 'none';
    const settBtn = document.getElementById('mob-setup-btn-settlement');
    const roadBtn = document.getElementById('mob-setup-btn-road');
    const settLbl = document.getElementById('mob-setup-sett-label');
    const roadLbl = document.getElementById('mob-setup-road-label');
    if (settLbl) settLbl.textContent = skinLabel('settlement', t('btn_settlement') || 'Villaggio');
    if (roadLbl) roadLbl.textContent = skinLabel('road',       t('btn_road')       || 'Strada');
    if (settBtn) settBtn.disabled = state.waitingForRoad;
    if (roadBtn) roadBtn.disabled = !state.waitingForRoad;
    updateBuildButtons();
  }

  renderBoardCanvas();
}

function showRobberPanel() {
  document.getElementById('mob-robber-panel').classList.add('active');
  collapseSheet();
  setMobBuildMode('robber');
}

function showStealPanel() {
  document.getElementById('mob-steal-panel').classList.add('active');
  document.getElementById('mob-steal-targets').innerHTML =
    state.robberCandidates.map(id=>{
      const p=state.players[id];
      return `<button class="mob-steal-btn" style="border-color:${p.color}"
               onclick="send({type:'STEAL_RESOURCE',targetPlayerId:${id}})">
        <span style="color:${p.color}">●</span> ${escHtml(p.name)}
      </button>`;
    }).join('');
}

let discardPanelBuilt = false; // flag: form built for current discard session
let discardAmounts = {};

function showDiscardPanel() {
  const panel = document.getElementById('mob-discard-panel');
  const me    = state.players[MY_PLAYER_ID];
  const ckOn  = !!state.citiesKnights;
  const tot   = Object.values(me.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(me.commodities||{}).reduce((a,b)=>a+b,0) : 0);
  const must  = Math.floor(tot/2);

  document.getElementById('mob-discard-title').textContent = t('mob_discard_title');

  // Only build the form once per discard session — NOT every render
  if (!discardPanelBuilt) {
    discardPanelBuilt = true;
    discardAmounts = {wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
    const resRows = RES_LIST.map(r=>`
      <div class="mob-discard-row">
        <label>${resEmoji(r)} (${me.resources[r]||0})</label>
        <div class="mob-stepper">
          <button onclick="changeDiscard('${r}',-1)">−</button>
          <span id="mdisc-${r}">0</span>
          <button onclick="changeDiscard('${r}',1)">+</button>
        </div>
      </div>`).join('');
    const comRows = ckOn ? MOB_CK_COMMODITIES.map(c=>`
      <div class="mob-discard-row">
        <label>${MOB_CK_COMMODITY_ICON[c]} (${me.commodities?.[c]||0})</label>
        <div class="mob-stepper">
          <button onclick="changeDiscard('${c}',-1)">−</button>
          <span id="mdisc-${c}">0</span>
          <button onclick="changeDiscard('${c}',1)">+</button>
        </div>
      </div>`).join('') : '';
    document.getElementById('mob-discard-resources').innerHTML = resRows + comRows;
  }
  // Always update the info text
  const currentSum = Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  document.getElementById('mob-discard-info').textContent =
    t('mob_discard_info', tot, must) + (currentSum > 0 ? ` (${currentSum}/${must})` : '');

  panel.classList.add('active');
}

window.changeDiscard=(res,d)=>{
  const me   = state.players[MY_PLAYER_ID];
  const ckOn = !!state.citiesKnights;
  const tot  = Object.values(me.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(me.commodities||{}).reduce((a,b)=>a+b,0) : 0);
  const must = Math.floor(tot/2);
  const currentSum = Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  const pool = mobTradePool(me, res);

  if (d > 0) {
    // Block if already at limit OR would exceed this card's stock
    if (currentSum >= must) return;
    if ((discardAmounts[res]||0) >= (pool[res]||0)) return;
  }
  discardAmounts[res] = Math.max(0, (discardAmounts[res]||0) + d);
  document.getElementById(`mdisc-${res}`).textContent = discardAmounts[res];

  // Update counter in title
  const newSum = Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  document.getElementById('mob-discard-info').textContent =
    t('mob_discard_info', tot, must) + ` (${newSum}/${must})`;

  // Visually disable all + buttons when limit reached
  const atLimit = newSum >= must;
  document.querySelectorAll('.mob-stepper button:last-child').forEach(btn => {
    btn.style.opacity  = atLimit ? '.3' : '1';
    btn.style.pointerEvents = atLimit ? 'none' : '';
  });
};
document.getElementById('mob-btn-discard-confirm').addEventListener('click',()=>{
  const me=state.players[MY_PLAYER_ID];
  const ckOn = !!state.citiesKnights;
  const tot=Object.values(me.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(me.commodities||{}).reduce((a,b)=>a+b,0) : 0);
  const must=Math.floor(tot/2);
  if(Object.values(discardAmounts).reduce((a,b)=>a+b,0)!==must){alert(t('discard_error',must));return;}
  discardPanelBuilt = false; // reset so next discard session builds fresh form
  send({type:'DISCARD_RESOURCES',playerId:MY_PLAYER_ID,resources:discardAmounts});
});

function updateBuildButtons() {
  const me=state.players[MY_PLAYER_ID], res=me.resources;
  const isSetup = state.phase==='setup1'||state.phase==='setup2';
  const setupPid = isSetup ? (state.setupOrder?.[state.setupStep]??0) : -1;
  const isMySetupTurn = isSetup && setupPid===MY_PLAYER_ID && !state.pendingSetupEndTurn;
  const canSetupRoad = isMySetupTurn && state.waitingForRoad;
  const canSetupSett = isMySetupTurn && !state.waitingForRoad;
  const othersPendingDiscard2 = (state.pendingDiscard||[]).filter(id=>id!==MY_PLAYER_ID);
  const hasPendingTrade = !!state.pendingTrade;
  const ca=state.diceRolled&&!state.pendingRobber&&!state.pendingSteal&&!(state.pendingDiscard||[]).includes(MY_PLAYER_ID)&&othersPendingDiscard2.length===0&&!hasPendingTrade;
  const rb=state.pendingRoadBuilding>0;
  setBB('mob-btn-road', ca?(rb||(res.wood>=1&&res.brick>=1)):canSetupRoad, ca||rb||canSetupRoad);
  const mobHasSettSpot = mobHasValidSettlementSpot(isSetup ? MY_PLAYER_ID : state.currentPlayerIndex);
  setBB('mob-btn-settlement',
    canSetupSett || (ca && mobHasSettSpot && res.wood>=1&&res.brick>=1&&res.sheep>=1&&res.wheat>=1),
    ca&&mobHasSettSpot || canSetupSett);
  setBB('mob-btn-city',       ca&&res.wheat>=2&&res.ore>=3&&me.settlements.length>0,     ca);
  // Official C&K has no development cards: hide the button entirely
  document.getElementById('mob-btn-devcard').style.display = state.citiesKnights ? 'none' : '';
  setBB('mob-btn-devcard',    !state.citiesKnights&&ca&&res.sheep>=1&&res.wheat>=1&&res.ore>=1&&state.devDeckSize>0
    &&(state.unlimitedDev||!state.devCardBoughtThisTurn), ca);
  const othersPendingDiscard = (state.pendingDiscard||[]).filter(id=>id!==MY_PLAYER_ID);
  const isMySetupEndTurn = (state.phase==='setup1'||state.phase==='setup2') && state.pendingSetupEndTurn &&
    (state.setupOrder?.[state.setupStep]??0)===MY_PLAYER_ID;
  const endTurnBlocked = !isMySetupEndTurn && (!ca || othersPendingDiscard.length > 0 || hasPendingTrade);
  const etBtn = document.getElementById('mob-btn-end-turn');
  etBtn.disabled = endTurnBlocked;
  // Debug — visible on screen so we can diagnose without DevTools
  etBtn.title = `ca=${ca} diceRolled=${state.diceRolled} pendingRobber=${state.pendingRobber} pendingSteal=${state.pendingSteal} myDiscard=${(state.pendingDiscard||[]).includes(MY_PLAYER_ID)} otherDiscard=${othersPendingDiscard.length} pendingTrade=${hasPendingTrade} blocked=${endTurnBlocked}`;
  if (othersPendingDiscard.length > 0) {
    const names = othersPendingDiscard.map(id=>state.players[id]?.name).filter(Boolean).join(', ');
    etBtn.title = names + ' must discard';
  } else {
    etBtn.title = '';
  }
  const isSetupPhase = state.phase==='setup1'||state.phase==='setup2';
  const mobUndo=document.getElementById('mob-btn-undo');
  if(mobUndo) mobUndo.disabled=(!ca && !isSetupPhase)||!state.undoAvailable;
  document.getElementById('mob-btn-bank').disabled=!ca;
  document.getElementById('mob-btn-player').disabled=!ca;
  const hasDev    = !state.citiesKnights && (me.devCards||[]).some(c=>!c.new);
  const hasKnight = !state.citiesKnights && (me.devCards||[]).some(c=>!c.new&&c.type==='knight');
  // Knight can be played before dice; other cards need dice rolled
  const canPlayNow = ca || (state.phase==='main' && !state.pendingRobber && hasKnight && !state.diceRolled);
  const hasPlayable= state.diceRolled ? hasDev : hasKnight;
  // Official C&K has no development cards: hide this button entirely for now
  // (it becomes the progress-card play button once that's implemented)
  document.getElementById('mob-btn-play-dev').style.display = state.citiesKnights ? 'none' : '';
  setBB('mob-btn-play-dev', hasPlayable, canPlayNow);
  // Visual hint: knight available pre-roll
  const devBtn = document.getElementById('mob-btn-play-dev');
  if (hasKnight && !state.diceRolled && state.phase==='main') {
    devBtn.classList.add('knight-ready');
  } else {
    devBtn.classList.remove('knight-ready');
  }

  // ── Cities & Knights: knight recruitment + city improvements ──
  document.querySelectorAll('.mob-ck-only').forEach(el => el.classList.toggle('hidden', !state.citiesKnights));
  if (state.citiesKnights) {
    const hasKnightRes = res.sheep>=1 && res.ore>=1;
    const basicKnights = (me.knights||[]).filter(k=>k.rank==='basic').length;
    setBB('mob-btn-knight', hasKnightRes && basicKnights<2, ca);
    const commodities = me.commodities || {};
    const hasAnyCommodity = (commodities.paper||0)>0 || (commodities.cloth||0)>0 || (commodities.coin||0)>0;
    const hasCity = (me.cities?.length||0) > 0;
    setBB('mob-btn-improve', hasCity && hasAnyCommodity, ca);
  }

  // Keep active-mode highlight
  ['road','settlement','city'].forEach(m=>{
    document.getElementById(`mob-btn-${m}`)
      .classList.toggle('active-mode', mobBuildMode===m||mobBuildMode===m+'_initial');
  });
  document.getElementById('mob-btn-knight')?.classList.toggle('active-mode',
    ['knight','knight_move_target','knight_chase_target','knight_displace_target'].includes(mobBuildMode));
}
function setBB(id,canAfford,canAct){
  const b=document.getElementById(id);
  b.disabled=!canAct;
  b.classList.toggle('cant-afford',canAct&&!canAfford);
}

// ── Build mode ────────────────────────────────────────────────────
function setMobBuildMode(mode) {
  mobBuildMode=mode;
  const banner=document.getElementById('mob-build-banner');
  const labels={
    road:                 skinLabel('mob_build_label_road',       skinLabel('road', t('mob_build_label_road')       || 'Tap an edge for the road')),
    settlement:           skinLabel('mob_build_label_settlement', skinLabel('settlement', t('mob_build_label_settlement') || 'Tap a vertex for the settlement')),
    city:                 skinLabel('mob_build_label_city',       skinLabel('city', t('mob_build_label_city')       || 'Tap your settlement to upgrade')),
    robber:               skinLabel('mob_build_label_robber',     skinLabel('robber', t('mob_build_label_robber')   || 'Tap a hex for the robber')),
    road_initial:         skinLabel('mob_build_label_road',       skinLabel('road', t('mob_build_label_road')       || 'Tap an edge for the road')),
    settlement_initial:   skinLabel('mob_build_label_settlement', skinLabel('settlement', t('mob_build_label_settlement') || 'Tap a vertex for the settlement')),
    knight:               t('mob_build_label_knight')            || 'Tocca un incrocio collegato a una tua strada',
    knight_move_target:   t('ck_pick_destination')                || 'Scegli la destinazione sulla mappa',
    knight_chase_target:  t('ck_pick_hex')                        || "Scegli l'esagono su cui spostare il brigante",
    knight_displace_target: t('ck_pick_enemy')                    || 'Scegli il cavaliere nemico da respingere',
  };
  if(mode){
    banner.textContent=labels[mode]||'';
    banner.classList.remove('hidden');
    collapseSheet();
  } else {
    banner.classList.add('hidden');
    expandSheet();
  }
  renderBoardCanvas();
}

function collapseSheet() {
  const sheet = document.getElementById('mob-sheet');
  const board = document.getElementById('mob-board-wrap');
  if (!sheet || !board || sheet.classList.contains('sheet-collapsed')) return;
  sheet.classList.add('sheet-collapsed');
  board.classList.add('board-expanded');
  setTimeout(() => { fitBoardToScreen(); renderBoardCanvas(); }, 280);
}

function expandSheet() {
  const sheet = document.getElementById('mob-sheet');
  const board = document.getElementById('mob-board-wrap');
  if (!sheet || !board || !sheet.classList.contains('sheet-collapsed')) return;
  sheet.classList.remove('sheet-collapsed');
  board.classList.remove('board-expanded');
  setTimeout(() => { fitBoardToScreen(); renderBoardCanvas(); }, 280);
}

function toggleBuildMode(mode) {
  setMobBuildMode(mobBuildMode===mode ? null : mode);
  ['road','settlement','city'].forEach(m=>{
    document.getElementById(`mob-btn-${m}`)?.classList.toggle('active-mode', mobBuildMode===m);
  });
}

function mobSetupPressSettlement() {
  if (state?.phase!=='setup1'&&state?.phase!=='setup2') return;
  if (state?.waitingForRoad || state?.pendingSetupEndTurn) return;
  mobBuildMode = 'settlement_initial';
  renderActionPanel();
}
function mobSetupPressRoad() {
  if (state?.phase!=='setup1'&&state?.phase!=='setup2') return;
  if (!state?.waitingForRoad || state?.pendingSetupEndTurn) return;
  mobBuildMode = 'road_initial';
  renderActionPanel();
}

document.getElementById('mob-btn-road').addEventListener('click',()=>{
  const isSetup=state?.phase==='setup1'||state?.phase==='setup2';
  if (isSetup && state?.waitingForRoad) {
    mobBuildMode='road_initial';
    const banner=document.getElementById('mob-build-banner');
    banner.textContent=skinLabel('road', t('mob_build_label_road')||'Tap an edge for the road');
    banner.classList.remove('hidden');
    renderBoardCanvas();
  } else { toggleBuildMode('road'); }
});
document.getElementById('mob-btn-settlement').addEventListener('click',()=>{
  const isSetup=state?.phase==='setup1'||state?.phase==='setup2';
  if (isSetup && !state?.waitingForRoad && !state?.pendingSetupEndTurn) {
    mobBuildMode='settlement_initial';
    const banner=document.getElementById('mob-build-banner');
    banner.textContent=skinLabel('settlement', t('mob_build_label_settlement')||'Tap a vertex for the settlement');
    banner.classList.remove('hidden');
    renderBoardCanvas();
  } else { toggleBuildMode('settlement'); }
});
document.getElementById('mob-btn-city')      .addEventListener('click',()=>toggleBuildMode('city'));
document.getElementById('mob-btn-devcard')   .addEventListener('click',()=>send({type:'BUY_DEV_CARD'}));
document.getElementById('mob-btn-knight')?.addEventListener('click', showMobKnightsModal);
document.getElementById('mob-btn-improve')?.addEventListener('click', showMobImprovementsModal);
document.getElementById('mob-btn-roll')      .addEventListener('click',()=>send({type:'ROLL_DICE'}));
document.getElementById('mob-btn-end-turn')  .addEventListener('click',()=>{
  setMobBuildMode(null);
  if (state?.pendingSetupEndTurn) send({type:'SETUP_END_TURN'});
  else send({type:'END_TURN'});
});
document.getElementById('mob-btn-undo')?.addEventListener('click', () => {
  send({ type: 'UNDO' });
});

// ================================================================
//  INTERACTIVE BOARD CANVAS
// ================================================================

const boardCanvas = document.getElementById('mob-board-canvas');
const bctx        = boardCanvas.getContext('2d');

function getBoardWrapSize() {
  const wrap = document.getElementById('mob-board-wrap');
  return { w: wrap.clientWidth, h: wrap.clientHeight };
}

function fitBoardToScreen() {
  if (!state) return;
  let {w,h} = getBoardWrapSize();
  // Fallback if wrap not laid out yet
  if (!w || !h) {
    w = window.innerWidth;
    h = Math.floor(window.innerHeight * 0.55);
  }
  boardCanvas.width  = w;
  boardCanvas.height = h;

  const hexes = state.board.hexes;
  const CXS=hexes.map(h=>h.cx), CYS=hexes.map(h=>h.cy);
  boardMinCX=Math.min(...CXS); boardMaxCX=Math.max(...CXS);
  boardMinCY=Math.min(...CYS); boardMaxCY=Math.max(...CYS);
  const bw=(boardMaxCX-boardMinCX)+2.2, bh=(boardMaxCY-boardMinCY)+1.8;
  // Scale to fit with small padding
  const scale = Math.min(w/bw, h/bh) * 0.90;
  BASE_HEX_SIZE = scale;
  cam.scale = 1;
  cam.tx = w/2 - ((boardMinCX+boardMaxCX)/2)*scale;
  cam.ty = h/2 - ((boardMinCY+boardMaxCY)/2)*scale;
}

// Canvas coords from board coords
function bpx(x) { return x * BASE_HEX_SIZE * cam.scale + cam.tx; }
function bpy(y) { return y * BASE_HEX_SIZE * cam.scale + cam.ty; }
function HS()   { return BASE_HEX_SIZE * cam.scale; }

function renderBoardCanvas() {
  if (!state || !boardCanvas.width) return;
  bctx.clearRect(0,0,boardCanvas.width,boardCanvas.height);

  // Sea bg
  const sg=bctx.createRadialGradient(boardCanvas.width/2,boardCanvas.height/2,20,boardCanvas.width/2,boardCanvas.height/2,boardCanvas.width*.7);
  sg.addColorStop(0,'#1a3a6a'); sg.addColorStop(1,'#0a1a2a');
  bctx.fillStyle=sg; bctx.fillRect(0,0,boardCanvas.width,boardCanvas.height);

  // Sea hexagon border (like the box game)
  drawMobileSeaHexagon();

  drawBoardHexes();
  drawBoardEdges();
  drawBoardVertices();
  drawBoardKnights();
  drawBoardPorts();
  drawBoardRobber();
}

function drawMobileSeaHexagon() {
  const hexes = state.board.hexes;
  const boardCx = hexes.reduce((s,h)=>s+bpx(h.cx),0)/hexes.length;
  const boardCy = hexes.reduce((s,h)=>s+bpy(h.cy),0)/hexes.length;
  const R = Math.max(...hexes.map(h=>Math.hypot(bpx(h.cx)-boardCx, bpy(h.cy)-boardCy))) + HS()*1.75;
  bctx.beginPath();
  for (let i=0;i<6;i++) {
    const a=Math.PI/3*i-Math.PI/6;
    i===0 ? bctx.moveTo(boardCx+R*Math.cos(a), boardCy+R*Math.sin(a))
           : bctx.lineTo(boardCx+R*Math.cos(a), boardCy+R*Math.sin(a));
  }
  bctx.closePath();
  const sf=bctx.createRadialGradient(boardCx,boardCy,R*.1,boardCx,boardCy,R);
  sf.addColorStop(0,'rgba(60,120,200,.35)');
  sf.addColorStop(1,'rgba(30,70,140,.55)');
  bctx.fillStyle=sf; bctx.fill();
  bctx.strokeStyle='rgba(100,160,240,.45)';
  bctx.lineWidth=HS()*.18; bctx.stroke();
}

function drawBoardHexes() {
  const hs=HS();
  for (const hex of state.board.hexes) {
    bctx.beginPath();
    for(let i=0;i<6;i++){
      const a=Math.PI/3*i-Math.PI/6;
      const vx=bpx(hex.cx)+hs*.95*Math.cos(a), vy=bpy(hex.cy)+hs*.95*Math.sin(a);
      i===0?bctx.moveTo(vx,vy):bctx.lineTo(vx,vy);
    }
    bctx.closePath();
    const col=RES_COLORS[hex.resource]||'#888';
    const skinImg = SKIN?.hexImages?.[hex.resource];
    const isRobber = hex.id===state.robberHexId;
    if (skinImg) {
      bctx.save();
      bctx.beginPath();
      for(let i=0;i<6;i++){const a=Math.PI/3*i-Math.PI/6;const vx=bpx(hex.cx)+hs*.95*Math.cos(a),vy=bpy(hex.cy)+hs*.95*Math.sin(a);i===0?bctx.moveTo(vx,vy):bctx.lineTo(vx,vy);}
      bctx.closePath(); bctx.clip();
      const sw=hs*2.05, sh=hs*2.35;
      bctx.drawImage(skinImg, bpx(hex.cx)-sw/2, bpy(hex.cy)-sh/2, sw, sh);
      bctx.restore();
      if (isRobber) { bctx.beginPath(); for(let i=0;i<6;i++){const a=Math.PI/3*i-Math.PI/6;const vx=bpx(hex.cx)+hs*.95*Math.cos(a),vy=bpy(hex.cy)+hs*.95*Math.sin(a);i===0?bctx.moveTo(vx,vy):bctx.lineTo(vx,vy);}bctx.closePath();bctx.fillStyle='rgba(220,0,0,.22)';bctx.fill();}
    } else {
      const g=bctx.createRadialGradient(bpx(hex.cx),bpy(hex.cy),0,bpx(hex.cx),bpy(hex.cy),hs);
      g.addColorStop(0,lighten(col,35)); g.addColorStop(1,col);
      bctx.fillStyle=g; bctx.fill();
    }
    // Robber border
    bctx.strokeStyle=isRobber?'#ff4444':'#0a1a2a44';
    bctx.lineWidth=isRobber?3:1.2; bctx.stroke();
    // Robber highlight when selecting
    if (mobBuildMode==='robber' && hex.id!==state.robberHexId) {
      bctx.beginPath();
      for(let i=0;i<6;i++){
        const a=Math.PI/3*i-Math.PI/6;
        const vx=bpx(hex.cx)+hs*.95*Math.cos(a), vy=bpy(hex.cy)+hs*.95*Math.sin(a);
        i===0?bctx.moveTo(vx,vy):bctx.lineTo(vx,vy);
      }
      bctx.closePath();
      bctx.fillStyle='rgba(255,100,50,.18)'; bctx.fill();
    }
    // Resource emoji — only without skin
    if (!skinImg) {
      bctx.font=`${hs*.48}px serif`;
      bctx.textAlign='center'; bctx.textBaseline='middle';
      bctx.fillText(resEmoji(hex.resource)||'?',bpx(hex.cx),bpy(hex.cy)-hs*.26);
    }
    // Number token
    if (hex.number) {
      const isRed=hex.number===6||hex.number===8;
      const isBig=hex.number===5||hex.number===9;
      const isSm =hex.number===2||hex.number===12;
      const tr=hs*(isRed?.32:isBig?.29:isSm?.22:.26);
      const fs=hs*(isRed?.26:isBig?.23:isSm?.17:.21);
      const ty=bpy(hex.cy)+hs*.28;
      bctx.beginPath(); bctx.arc(bpx(hex.cx),ty,tr,0,Math.PI*2);
      bctx.fillStyle=isRed?'#ffe8e8':'#fffff0'; bctx.fill();
      bctx.strokeStyle=isRed?'#cc2200':'#5a4a2a'; bctx.lineWidth=isRed?2:1.2; bctx.stroke();
      bctx.fillStyle=isRed?'#cc2200':'#1a1200';
      bctx.font=`bold ${fs}px serif`;
      bctx.fillText(hex.number,bpx(hex.cx),ty);
      const dots={2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1}[hex.number]||0;
      for(let d=0;d<dots;d++){
        const dx=(d-(dots-1)/2)*hs*.05;
        bctx.beginPath(); bctx.arc(bpx(hex.cx)+dx,ty+tr*.82,hs*.026,0,Math.PI*2);
        bctx.fillStyle=isRed?'#cc2200':'#1a1200'; bctx.fill();
      }
    }
  }
}

function drawBoardEdges() {
  const hs=HS();
  for (const edge of state.board.edges) {
    const v1=state.board.vertices[edge.v1], v2=state.board.vertices[edge.v2];
    if (!v1||!v2) continue;
    const x1=bpx(v1.x),y1=bpy(v1.y),x2=bpx(v2.x),y2=bpy(v2.y);
    if (edge.owner!==null) {
      const col=state.players[edge.owner].color;
      const rImg=skinRoadImg(col);
      if(rImg){
        const cx=(x1+x2)/2,cy=(y1+y2)/2;
        const angle=Math.atan2(y2-y1,x2-x1)+Math.PI/2;
        const len=Math.hypot(x2-x1,y2-y1)*1.15;
        const thick=hs*1.0;
        bctx.save(); bctx.translate(cx,cy); bctx.rotate(angle);
        bctx.drawImage(rImg,-thick/2,-len/2,thick,len);
        bctx.restore();
      } else {
        bctx.beginPath(); bctx.moveTo(x1,y1); bctx.lineTo(x2,y2);
        bctx.strokeStyle=col; bctx.lineWidth=hs*.13; bctx.lineCap='round'; bctx.stroke();
        bctx.strokeStyle=lighten(col,55); bctx.lineWidth=hs*.05; bctx.stroke();
      }
    } else if (isValidRoadEdge(edge.id)) {
      bctx.beginPath(); bctx.moveTo(x1,y1); bctx.lineTo(x2,y2);
      bctx.strokeStyle='rgba(255,220,50,.75)'; bctx.lineWidth=hs*.09;
      bctx.setLineDash([hs*.07,hs*.04]); bctx.stroke(); bctx.setLineDash([]);
    }
  }
}

function drawBoardVertices() {
  const hs=HS();
  for (const v of state.board.vertices) {
    const x=bpx(v.x), y=bpy(v.y);
    const hlSett = (mobBuildMode==='settlement'||mobBuildMode==='settlement_initial') && isValidSettlementV(v.id);
    const hlCity = mobBuildMode==='city' && isValidCityV(v.id);
    const hlKnight = mobBuildMode==='knight' && isValidKnightV(v.id);
    if (v.building) {
      const col=state.players[v.owner].color;
      if (hlCity) {
        bctx.beginPath(); bctx.arc(x,y,hs*.27,0,Math.PI*2);
        bctx.strokeStyle='rgba(255,220,50,.9)'; bctx.lineWidth=hs*.08; bctx.stroke();
        bctx.fillStyle='rgba(255,220,50,.15)'; bctx.fill();
      }
      v.building==='settlement' ? drawSettlement(x,y,col,hs) : drawCity(x,y,col,hs);
    } else if (hlSett) {
      bctx.beginPath(); bctx.arc(x,y,hs*.14,0,Math.PI*2);
      bctx.fillStyle='rgba(255,220,50,.88)'; bctx.fill();
      bctx.strokeStyle='#fff'; bctx.lineWidth=1.5; bctx.stroke();
    } else if (hlKnight) {
      bctx.beginPath(); bctx.arc(x,y,hs*.15,0,Math.PI*2);
      bctx.fillStyle='rgba(200,164,74,.85)'; bctx.fill();
      bctx.strokeStyle='#fff'; bctx.lineWidth=1.5; bctx.stroke();
    }
  }
}

// ── Cities & Knights: knight pieces on the board ────────────────────
const MOB_KNIGHT_EMOJI = { basic: '🛡️', strong: '⚔️', mighty: '🐎' };
const MOB_RANK_VAL = { basic:1, strong:2, mighty:3 };
function drawBoardKnights() {
  if (!state?.citiesKnights) return;
  const hs=HS();

  // Highlight valid retreat spots when a displacement is awaiting a choice
  if (state.pendingKnightDisplace) {
    for (const vid of state.pendingKnightDisplace.options) {
      const v=state.board.vertices[vid]; const x=bpx(v.x), y=bpy(v.y);
      bctx.beginPath(); bctx.arc(x,y,hs*.18,0,Math.PI*2);
      bctx.strokeStyle='rgba(255,220,50,.9)'; bctx.lineWidth=hs*.06; bctx.stroke();
    }
  }
  // Highlight valid targets while a move/displace action is being aimed
  if (mobBuildMode==='knight_move_target' || mobBuildMode==='knight_displace_target') {
    const fromVertex = state.board.vertices[knightActionFrom];
    if (fromVertex) {
      const myKnight = state.players[MY_PLAYER_ID]?.knights?.find(k=>k.vertexId===knightActionFrom);
      for (const eid of fromVertex.adjEdges) {
        const e=state.board.edges[eid];
        const otherId = e.v1===knightActionFrom ? e.v2 : e.v1;
        const other = state.board.vertices[otherId];
        let valid=false;
        if (mobBuildMode==='knight_move_target') {
          valid = e.owner===MY_PLAYER_ID && other.owner===null && !state.players.some(p=>(p.knights||[]).some(k=>k.vertexId===otherId));
        } else if (myKnight) {
          const enemy = state.players.find(p => p.id!==MY_PLAYER_ID && (p.knights||[]).some(k=>k.vertexId===otherId));
          const enemyKnight = enemy?.knights.find(k=>k.vertexId===otherId);
          valid = e.owner!==null && !!enemyKnight && MOB_RANK_VAL[myKnight.rank] > MOB_RANK_VAL[enemyKnight.rank];
        }
        if (valid) {
          const x=bpx(other.x), y=bpy(other.y);
          bctx.beginPath(); bctx.arc(x,y,hs*.18,0,Math.PI*2);
          bctx.strokeStyle='rgba(200,164,74,.9)'; bctx.lineWidth=hs*.06; bctx.stroke();
        }
      }
    }
  }

  for (const player of state.players) {
    for (const knight of (player.knights || [])) {
      const v = state.board.vertices[knight.vertexId];
      if (!v) continue;
      const x=bpx(v.x), y=bpy(v.y);
      const r = hs*.22;
      bctx.save();
      if (!knight.active) bctx.globalAlpha = .55;
      bctx.beginPath(); bctx.arc(x,y,r,0,Math.PI*2);
      bctx.fillStyle = player.color; bctx.fill();
      bctx.strokeStyle='#fff'; bctx.lineWidth=2; bctx.stroke();
      bctx.font=`${r*1.3}px serif`; bctx.textAlign='center'; bctx.textBaseline='middle';
      bctx.fillText(MOB_KNIGHT_EMOJI[knight.rank] || '🛡️', x, y);
      bctx.restore();
    }
  }
}

function drawBoardPorts() {
  if (!state.board.ports) return;
  const hs=HS();
  const hexes=state.board.hexes;
  const bcx=hexes.reduce((s,h)=>s+bpx(h.cx),0)/hexes.length;
  const bcy=hexes.reduce((s,h)=>s+bpy(h.cy),0)/hexes.length;
  for (const port of state.board.ports) {
    if (!port.vertices?.length) continue;
    const v0=state.board.vertices[port.vertices[0]];
    const v1=port.vertices.length>1?state.board.vertices[port.vertices[1]]:v0;
    if (!v0||!v1) continue;
    const mx=(bpx(v0.x)+bpx(v1.x))/2, my=(bpy(v0.y)+bpy(v1.y))/2;
    const dx=mx-bcx, dy=my-bcy, len=Math.sqrt(dx*dx+dy*dy)||1;
    const push=hs*.65;
    const bx=mx+dx/len*push, by=my+dy/len*push;
    const r=hs*.24;
    const isG=port.type==='any';
    const mRC=RES_COLORS[port.type]||'#888';
    // Connector lines
    for (const vid of port.vertices) {
      const v=state.board.vertices[vid]; if(!v) continue;
      bctx.beginPath(); bctx.moveTo(bx,by); bctx.lineTo(bpx(v.x),bpy(v.y));
      bctx.strokeStyle=isG?'rgba(160,180,200,.7)':mRC;
      bctx.lineWidth=hs*.06;
      bctx.setLineDash([hs*.06,hs*.04]); bctx.stroke(); bctx.setLineDash([]);
    }
    bctx.beginPath(); bctx.arc(bx,by,r+4,0,Math.PI*2);
    bctx.strokeStyle=isG?'rgba(160,180,200,.25)':mRC; bctx.lineWidth=7; bctx.stroke();
    bctx.beginPath(); bctx.arc(bx,by,r,0,Math.PI*2);
    bctx.fillStyle=isG?'rgba(60,80,110,.96)':darken(mRC,50); bctx.fill();
    bctx.strokeStyle=isG?'#a0b4c8':lighten(mRC,50); bctx.lineWidth=2; bctx.stroke();
    bctx.font=`${hs*.2}px serif`; bctx.textAlign='center'; bctx.textBaseline='middle';
    bctx.fillText(isG?'🌀':resEmoji(port.type),bx,by-r*.22);
    bctx.fillStyle='#fff'; bctx.font=`bold ${hs*.18}px sans-serif`;
    bctx.fillText(`${port.ratio}:1`,bx,by+r*.5);
  }
}

function drawBoardRobber() {
  if (state.robberHexId===null) return;
  const h=state.board.hexes[state.robberHexId];
  const hs=HS();
  const rx=bpx(h.cx), ry=bpy(h.cy)-hs*.3, r=hs*.40;
  if (SKIN?.robberImage) {
    const s = r * 2.1;
    bctx.drawImage(SKIN.robberImage, rx-s/2, ry-s/2, s, s);
  } else {
    bctx.beginPath(); bctx.arc(rx,ry,r,0,Math.PI*2);
    bctx.fillStyle='rgba(32,32,36,.95)'; bctx.fill();
    bctx.strokeStyle='rgba(180,180,190,.7)'; bctx.lineWidth=2.5; bctx.stroke();
    bctx.font=`${hs*.44}px serif`;
    bctx.textAlign='center'; bctx.textBaseline='middle';
    bctx.fillText('🦹',rx,ry);
  }
}

function drawSettlement(x,y,color,hs){
  const img = skinBuildingImg('settlement', color);
  if (img) { const s=hs*0.85; bctx.drawImage(img,x-s/2,y-s*0.4,s,s); return; }
  const s=hs*.2; bctx.save(); bctx.translate(x,y-s*.3);
  bctx.beginPath(); bctx.rect(-s,0,s*2,s*1.3); bctx.fillStyle=color; bctx.fill();
  bctx.strokeStyle='#fff'; bctx.lineWidth=1.2; bctx.stroke();
  bctx.beginPath(); bctx.moveTo(-s*1.2,0); bctx.lineTo(0,-s*1.2); bctx.lineTo(s*1.2,0); bctx.closePath();
  bctx.fillStyle=darken(color,30); bctx.fill(); bctx.stroke(); bctx.restore();
}
function drawCity(x,y,color,hs){
  const img = skinBuildingImg('city', color);
  if (img) { const s=hs*1.05; bctx.drawImage(img,x-s/2,y-s*0.4,s,s); return; }
  const s=hs*.2; bctx.save(); bctx.translate(x,y-s*.3);
  bctx.beginPath(); bctx.rect(-s*1.2,-s*.2,s*.9,s*1.5); bctx.fillStyle=color; bctx.fill();
  bctx.strokeStyle='#fff'; bctx.lineWidth=1.2; bctx.stroke();
  bctx.beginPath(); bctx.rect(0,0,s*1.2,s*1.3); bctx.fill(); bctx.stroke();
  bctx.beginPath(); bctx.moveTo(0,0); bctx.lineTo(s*.6,-s); bctx.lineTo(s*1.2,0); bctx.closePath();
  bctx.fillStyle=darken(color,30); bctx.fill(); bctx.stroke(); bctx.restore();
}

// ── Validity helpers ──────────────────────────────────────────────
function isValidRoadEdge(eid) {
  if (!state) return false;
  const isSetup=state.phase==='setup1'||state.phase==='setup2';
  if (!isSetup && !state.diceRolled) return false;
  if (!isSetup && !(mobBuildMode==='road'||state.pendingRoadBuilding>0)) return false;
  const pid=MY_PLAYER_ID, edge=state.board.edges[eid];
  if (edge.owner!==null) return false;
  if (isSetup && state.waitingForRoad) {
    const lastV=state.lastSettlementPlaced;
    if (lastV!=null) return edge.v1===lastV||edge.v2===lastV;
  }
  for (const vid of [edge.v1,edge.v2]) {
    const v=state.board.vertices[vid];
    if (v.owner===pid) return true;
    if (v.owner===null||v.owner===pid)
      if (v.adjEdges.some(e2=>e2!==eid&&state.board.edges[e2].owner===pid)) return true;
  }
  return false;
}
function isValidSettlementV(vid) {
  if (!state) return false;
  const isSetup=state.phase==='setup1'||state.phase==='setup2';
  if (!isSetup&&!state.diceRolled) return false;
  const v=state.board.vertices[vid];
  if (v.owner!==null) return false;
  for (const eid of v.adjEdges){
    const e=state.board.edges[eid];
    if (state.board.vertices[e.v1===vid?e.v2:e.v1].owner!==null) return false;
  }
  if (isSetup && !state.waitingForRoad) return true; // setup: any free distant vertex
  return v.adjEdges.some(eid=>state.board.edges[eid].owner===MY_PLAYER_ID);
}
function isValidCityV(vid) {
  if (!state||!state.diceRolled) return false;
  const v=state.board.vertices[vid];
  return v.owner===MY_PLAYER_ID && v.building==='settlement';
}
function isValidKnightV(vid) {
  if (!state||state.phase!=='main'||!state.citiesKnights) return false;
  const v=state.board.vertices[vid];
  if (v.owner!==null) return false;
  if (state.players.some(p => (p.knights||[]).some(k=>k.vertexId===vid))) return false;
  return v.adjEdges.some(eid=>state.board.edges[eid].owner===MY_PLAYER_ID);
}

// ── Touch handling on board canvas ───────────────────────────────
boardCanvas.addEventListener('touchstart', onBoardTouchStart, {passive:false});
boardCanvas.addEventListener('touchmove',  onBoardTouchMove,  {passive:false});
boardCanvas.addEventListener('touchend',   onBoardTouchEnd,   {passive:false});
// Mouse fallback for testing
boardCanvas.addEventListener('click', e => {
  const r=boardCanvas.getBoundingClientRect();
  handleBoardTap(e.clientX-r.left, e.clientY-r.top);
});

function onBoardTouchStart(e) {
  e.preventDefault();
  if (e.touches.length===1) {
    const t=e.touches[0];
    const r=boardCanvas.getBoundingClientRect();
    panStart={x:t.clientX-r.left, y:t.clientY-r.top, tx:cam.tx, ty:cam.ty};
    pinchStart=null;
  } else if (e.touches.length===2) {
    panStart=null;
    const r=boardCanvas.getBoundingClientRect();
    const t0=e.touches[0], t1=e.touches[1];
    const dist=Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
    const cx=(t0.clientX+t1.clientX)/2-r.left;
    const cy=(t0.clientY+t1.clientY)/2-r.top;
    pinchStart={dist, cx, cy, camScale:cam.scale, camTx:cam.tx, camTy:cam.ty};
  }
}

function onBoardTouchMove(e) {
  e.preventDefault();
  if (e.touches.length===2 && pinchStart) {
    const r=boardCanvas.getBoundingClientRect();
    const t0=e.touches[0], t1=e.touches[1];
    const dist=Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
    const cx=(t0.clientX+t1.clientX)/2-r.left;
    const cy=(t0.clientY+t1.clientY)/2-r.top;
    const newScale=Math.max(0.5, Math.min(6, pinchStart.camScale * dist/pinchStart.dist));
    const scaleRatio=newScale/pinchStart.camScale;
    cam.scale=newScale;
    cam.tx=pinchStart.cx - scaleRatio*(pinchStart.cx-pinchStart.camTx);
    cam.ty=pinchStart.cy - scaleRatio*(pinchStart.cy-pinchStart.camTy);
    renderBoardCanvas();
  } else if (e.touches.length===1 && panStart) {
    const r=boardCanvas.getBoundingClientRect();
    const t=e.touches[0];
    const dx=(t.clientX-r.left)-panStart.x;
    const dy=(t.clientY-r.top) -panStart.y;
    cam.tx=panStart.tx+dx;
    cam.ty=panStart.ty+dy;
    renderBoardCanvas();
  }
}

function onBoardTouchEnd(e) {
  e.preventDefault();
  if (e.touches.length===0 && e.changedTouches.length===1) {
    const now=Date.now();
    const wasPan = panStart && (
      Math.abs(cam.tx-panStart.tx)>6 || Math.abs(cam.ty-panStart.ty)>6
    );
    panStart=null; pinchStart=null;
    // Only treat as tap if not a drag
    if (!wasPan) {
      const r=boardCanvas.getBoundingClientRect();
      const t=e.changedTouches[0];
      handleBoardTap(t.clientX-r.left, t.clientY-r.top);
    }
    // Double-tap to reset zoom
    if (now-lastTapTime<300) { fitBoardToScreen(); renderBoardCanvas(); }
    lastTapTime=now;
  } else {
    panStart=null; pinchStart=null;
  }
}

function handleBoardTap(cx, cy) {
  if (!state) return;

  // Knight-displacement retreat: resolved unconditionally (no build mode
  // needed) by the displaced player tapping one of the highlighted options —
  // mirrors the web client's click handling for this same pending state.
  if (state.pendingKnightDisplace?.playerId === MY_PLAYER_ID) {
    const v = findTappedVertex(cx,cy);
    if (v && state.pendingKnightDisplace.options.includes(v.id)) {
      send({type:'RESOLVE_KNIGHT_DISPLACE', vertexId:v.id});
      document.getElementById('mob-build-banner').classList.add('hidden');
    }
    return;
  }

  if (!mobBuildMode) return;

  if (mobBuildMode==='robber') {
    const hex=findTappedHex(cx,cy);
    if (hex && hex.id!==state.robberHexId) {
      send({type:'MOVE_ROBBER', hexId:hex.id});
      mobBuildMode = null;
      document.getElementById('mob-build-banner').classList.add('hidden');
      // Remove robber panel and expand sheet immediately so Fine Turno is reachable
      document.getElementById('mob-robber-panel')?.classList.remove('active');
      document.getElementById('mob-steal-panel')?.classList.remove('active');
      expandSheet();
    }
    return;
  }

  if (mobBuildMode==='road_initial') {
    const edge=findTappedEdge(cx,cy);
    if (edge) { send({type:'PLACE_INITIAL_ROAD',edgeId:edge.id}); setMobBuildMode(null); }
    return;
  }
  if (mobBuildMode==='road') {
    const edge=findTappedEdge(cx,cy);
    if (edge && isValidRoadEdge(edge.id)) {
      const type=mobBuildMode==='road_initial'?'PLACE_INITIAL_ROAD':'BUILD_ROAD';
      send({type, edgeId:edge.id});
      setMobBuildMode(null);
    }
    return;
  }

  if (mobBuildMode==='settlement'||mobBuildMode==='settlement_initial') {
    const v=findTappedVertex(cx,cy);
    if (v && isValidSettlementV(v.id)) {
      const type=mobBuildMode==='settlement_initial'?'PLACE_INITIAL_SETTLEMENT':'BUILD_SETTLEMENT';
      send({type, vertexId:v.id});
      setMobBuildMode(null);
    }
    return;
  }

  if (mobBuildMode==='city') {
    const v=findTappedVertex(cx,cy);
    if (v && isValidCityV(v.id)) {
      send({type:'BUILD_CITY', vertexId:v.id});
      setMobBuildMode(null);
    }
    return;
  }

  if (mobBuildMode==='knight') {
    const v=findTappedVertex(cx,cy);
    if (v && isValidKnightV(v.id)) {
      send({type:'BUILD_KNIGHT', vertexId:v.id});
      setMobBuildMode(null);
    }
    return;
  }
  if (mobBuildMode==='knight_move_target') {
    const v=findTappedVertex(cx,cy);
    if (v) { send({type:'MOVE_KNIGHT', fromVertexId:knightActionFrom, toVertexId:v.id}); setMobBuildMode(null); knightActionFrom=null; }
    return;
  }
  if (mobBuildMode==='knight_chase_target') {
    const h=findTappedHex(cx,cy);
    if (h) { send({type:'CHASE_ROBBER_KNIGHT', vertexId:knightActionFrom, newHexId:h.id}); setMobBuildMode(null); knightActionFrom=null; }
    return;
  }
  if (mobBuildMode==='knight_displace_target') {
    const v=findTappedVertex(cx,cy);
    if (v) { send({type:'DISPLACE_KNIGHT', fromVertexId:knightActionFrom, targetVertexId:v.id}); setMobBuildMode(null); knightActionFrom=null; }
    return;
  }
}

// Hit testing — in canvas coords, inverse of bpx/bpy
function findTappedHex(cx,cy) {
  let best=null, bestD=HS()*0.95;
  for (const h of state.board.hexes) {
    const d=Math.hypot(cx-bpx(h.cx), cy-bpy(h.cy));
    if (d<bestD){bestD=d;best=h;}
  }
  return best;
}
function findTappedVertex(cx,cy) {
  let best=null, bestD=HS()*0.35;
  for (const v of state.board.vertices) {
    const d=Math.hypot(cx-bpx(v.x), cy-bpy(v.y));
    if (d<bestD){bestD=d;best=v;}
  }
  return best;
}
function findTappedEdge(cx,cy) {
  let best=null, bestD=HS()*0.32;
  for (const e of state.board.edges) {
    const v1=state.board.vertices[e.v1], v2=state.board.vertices[e.v2];
    if (!v1||!v2) continue;
    const mx=(bpx(v1.x)+bpx(v2.x))/2, my=(bpy(v1.y)+bpy(v2.y))/2;
    const d=Math.hypot(cx-mx, cy-my);
    if (d<bestD){bestD=d;best=e;}
  }
  return best;
}

// ── Mini board (wait screen) ──────────────────────────────────────
function renderMiniBoard() {
  const canvas=document.getElementById('mini-canvas');
  const ctx=canvas.getContext('2d');
  const wrap=document.querySelector('.wait-board-wrap');
  const W=wrap.clientWidth-16, H=wrap.clientHeight-16;
  canvas.width=W; canvas.height=H;
  ctx.clearRect(0,0,W,H);
  const hexes=state.board.hexes;
  const CXS=hexes.map(h=>h.cx), CYS=hexes.map(h=>h.cy);
  const minX=Math.min(...CXS),maxX=Math.max(...CXS);
  const minY=Math.min(...CYS),maxY=Math.max(...CYS);
  const hs=Math.min(W/((maxX-minX)+2.2), H/((maxY-minY)+1.8))*.88;
  const ox=W/2-((minX+maxX)/2)*hs, oy=H/2-((minY+maxY)/2)*hs;
  const px=x=>x*hs+ox, py=y=>y*hs+oy;
  const sg=ctx.createRadialGradient(W/2,H/2,10,W/2,H/2,W*.6);
  sg.addColorStop(0,'#1a3a6a'); sg.addColorStop(1,'#0a1a2a');
  ctx.fillStyle=sg; ctx.fillRect(0,0,W,H);
  for (const h of hexes) {
    ctx.beginPath();
    for(let i=0;i<6;i++){const a=Math.PI/3*i-Math.PI/6;
      const vx=px(h.cx)+hs*.93*Math.cos(a),vy=py(h.cy)+hs*.93*Math.sin(a);
      i===0?ctx.moveTo(vx,vy):ctx.lineTo(vx,vy);}
    ctx.closePath(); ctx.fillStyle=RES_COLORS[h.resource]||'#888'; ctx.fill();
    ctx.strokeStyle='#0a1a2a44'; ctx.lineWidth=.8; ctx.stroke();
    if(h.number){
      const isRed=h.number===6||h.number===8;
      ctx.beginPath(); ctx.arc(px(h.cx),py(h.cy),hs*.24,0,Math.PI*2);
      ctx.fillStyle=isRed?'#ffe8e8':'#fffff0'; ctx.fill();
      ctx.fillStyle=isRed?'#cc2200':'#1a1200'; ctx.font=`bold ${hs*.18}px serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(h.number,px(h.cx),py(h.cy));
    }
  }
  // Draw roads
  for (const e of state.board.edges) {
    if (e.owner===null) continue;
    const v1=state.board.vertices[e.v1], v2=state.board.vertices[e.v2];
    if (!v1||!v2) continue;
    const col=state.players[e.owner].color;
    ctx.beginPath(); ctx.moveTo(px(v1.x),py(v1.y)); ctx.lineTo(px(v2.x),py(v2.y));
    ctx.strokeStyle=col; ctx.lineWidth=hs*.1; ctx.lineCap='round'; ctx.stroke();
  }
  // Draw settlements and cities
  for (const v of state.board.vertices) {
    if (!v.building) continue;
    const col=state.players[v.owner].color;
    const r=hs*(v.building==='city'?.16:.12);
    ctx.beginPath(); ctx.arc(px(v.x),py(v.y),r,0,Math.PI*2);
    ctx.fillStyle=col; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.stroke();
  }
  if (state.robberHexId!==null){
    const h=state.board.hexes[state.robberHexId];
    ctx.beginPath(); ctx.arc(px(h.cx),py(h.cy),hs*.32,0,Math.PI*2);
    ctx.fillStyle='rgba(32,32,36,.95)'; ctx.fill();
    ctx.strokeStyle='rgba(180,180,190,.6)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.font=`${hs*.32}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('🦹',px(h.cx),py(h.cy));
  }
}

// ================================================================
//  BANK TRADE
// ================================================================
let bankGive=null, bankReceive=null;
const MOB_CK_COMMODITIES = ['paper','cloth','coin'];
const MOB_CK_COMMODITY_ICON = { paper:'📜', cloth:'🧵', coin:'🪙' };
// Cities & Knights: progress card display names/icons (mirrors main.js;
// Italian-only for now since no card is playable yet)
const PROGRESS_CARD_NAMES = {
  merchant:'Mercante', resourceMonopoly:'Monopolio Risorsa', commercialHarbor:'Porto Commerciale',
  masterMerchant:'Gran Mercante', merchantFleet:'Flotta Mercantile', tradeMonopoly:'Monopolio Commercio',
  spy:'Spia', bishop:'Vescovo', deserter:'Disertore', diplomat:'Diplomatico', intrigue:'Intrigo',
  saboteur:'Sabotatore', warlord:'Signore della Guerra', wedding:'Matrimonio', constitution:'Costituzione',
  alchemist:'Alchimista', crane:'Gru', inventor:'Inventore', irrigation:'Irrigazione', medicine:'Medicina',
  mining:'Miniera', roadBuilding:'Costruzione Strade', smith:'Fabbro', engineer:'Ingegnere', printer:'Stampa'
};
const PROGRESS_COLOR_ICON = { trade:'🟡', politics:'🔵', science:'🟢' };
function mobTradePool(player, key) {
  return MOB_CK_COMMODITIES.includes(key) ? (player.commodities||{}) : (player.resources||{});
}
document.getElementById('mob-btn-bank').addEventListener('click',()=>{
  bankGive=null; bankReceive=null;
  const me=state.players[MY_PLAYER_ID];
  const ckOn = !!state.citiesKnights;

  const giveResHtml = RES_LIST.map(r=>{
    const ratio=getMobTradeRatio(me,r), have=me.resources[r]||0;
    const dis=have<ratio?'disabled':'';
    return `<button class="mob-res-btn" data-res="${r}" onclick="selBankGive('${r}')" ${dis}>
      <span class="re">${resEmoji(r)}</span><span>${resName(r)}</span><small>${have}/${ratio}</small>
    </button>`;
  }).join('');
  const giveComHtml = ckOn ? MOB_CK_COMMODITIES.map(c=>{
    const ratio=getMobCommodityTradeRatio(me), have=me.commodities?.[c]||0;
    const dis=have<ratio?'disabled':'';
    return `<button class="mob-res-btn" data-res="${c}" onclick="selBankGive('${c}')" ${dis}>
      <span class="re">${MOB_CK_COMMODITY_ICON[c]}</span><span>${commodityName(c)}</span><small>${have}/${ratio}</small>
    </button>`;
  }).join('') : '';
  document.getElementById('mob-trade-give').innerHTML = giveResHtml + giveComHtml;

  const recvResHtml = RES_LIST.map(r=>{
    return `<button class="mob-res-btn" data-res="${r}" onclick="selBankRecv('${r}')">
      <span class="re">${resEmoji(r)}</span><span>${resName(r)}</span>
    </button>`;
  }).join('');
  const recvComHtml = ckOn ? MOB_CK_COMMODITIES.map(c=>{
    return `<button class="mob-res-btn" data-res="${c}" onclick="selBankRecv('${c}')">
      <span class="re">${MOB_CK_COMMODITY_ICON[c]}</span><span>${commodityName(c)}</span>
    </button>`;
  }).join('') : '';
  document.getElementById('mob-trade-receive').innerHTML = recvResHtml + recvComHtml;

  document.getElementById('mob-trade-ratio').textContent='';
  openMobModal('mob-modal-bank');
});
window.selBankGive=r=>{
  bankGive=r;
  document.querySelectorAll('#mob-trade-give .mob-res-btn').forEach(b=>b.classList.toggle('selected',b.dataset.res===r));
  const me=state.players[MY_PLAYER_ID];
  const isCommodity = MOB_CK_COMMODITIES.includes(r);
  const ratio = isCommodity ? getMobCommodityTradeRatio(me) : getMobTradeRatio(me,r);
  const have  = mobTradePool(me,r)[r]||0;
  const icon  = isCommodity ? MOB_CK_COMMODITY_ICON[r] : (resEmoji(r)||r);
  document.getElementById('mob-trade-ratio').textContent=t('pt_ratio_info',ratio,have,icon);
};
window.selBankRecv=r=>{
  bankReceive=r;
  document.querySelectorAll('#mob-trade-receive .mob-res-btn').forEach(b=>b.classList.toggle('selected',b.dataset.res===r));
};
document.getElementById('mob-btn-bank-confirm').addEventListener('click',()=>{
  if(!bankGive||!bankReceive){alert('Seleziona dare e ricevere');return;}
  send({type:'TRADE_BANK',give:bankGive,receive:bankReceive});
  closeMobModal('mob-modal-bank');
});
function getMobTradeRatio(player,resource){
  let best=4;
  for(const vid of [...(player.settlements||[]),...(player.cities||[])]){
    const port=state.board.vertices[vid]?.port; if(!port) continue;
    if(port.type===resource||port.type==='any') best=Math.min(best,port.ratio);
  }
  return best;
}
// Cities & Knights: commodities only get the generic 3:1 harbor rate (no
// 2:1 harbor exists for a specific commodity), 4:1 with no harbor at all.
function getMobCommodityTradeRatio(player){
  let best=4;
  for(const vid of [...(player.settlements||[]),...(player.cities||[])]){
    const port=state.board.vertices[vid]?.port;
    if(port?.type==='any') best=Math.min(best,port.ratio);
  }
  return best;
}

// ================================================================
//  PLAYER TRADE
// ================================================================
let ptTarget=null, ptOffer={wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0}, ptWant={...ptOffer};
document.getElementById('mob-btn-player').addEventListener('click',()=>{
  ptTarget=null; ptOffer={wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0}; ptWant={...ptOffer};
  renderPTModal(); openMobModal('mob-modal-player-trade');
});
window.selPTTarget=id=>{ptTarget=id; ptWant={wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0}; renderPTModal();};
window.chMobPT=(side,res,d)=>{
  const me=state.players[MY_PLAYER_ID];
  const blind = state.hiddenResources ?? false;
  if(side==='offer') ptOffer[res]=Math.max(0,Math.min(mobTradePool(me,res)[res]||0,(ptOffer[res]||0)+d));
  else { const tgt=ptTarget!==null?state.players[ptTarget]:null;
    if(!tgt) return;
    const max = blind ? 99 : (mobTradePool(tgt,res)[res]||0);
    ptWant[res]=Math.max(0,Math.min(max,(ptWant[res]||0)+d)); }
  renderPTModal();
};
function mobPTRow(r, icon, label, tgt, me, blind) {
  const ov=ptOffer[r]||0, wv=ptWant[r]||0;
  const mh=mobTradePool(me,r)[r]||0;
  const targetPool = tgt ? mobTradePool(tgt,r) : null;
  const th=tgt ? (blind ? '?' : (targetPool[r]||0)) : '—';
  const wantMax=tgt ? (blind ? 99 : (targetPool[r]||0)) : 0;
  return `<div class="mob-pt-row">
    <span class="mob-pt-emoji">${icon}</span>
    <div class="mob-pt-name">${label}</div>
    <div class="mob-pt-col">
      <span class="mob-pt-col-head">${t('offer_label')||'Offri'}(${mh})</span>
      <div class="mob-stepper">
        <button onclick="chMobPT('offer','${r}',-1)">−</button>
        <span style="${ov>0?'color:#f0c040;font-weight:bold':''}">${ov}</span>
        <button onclick="chMobPT('offer','${r}',1)" ${ov>=mh?'disabled':''}>+</button>
      </div>
    </div>
    <div class="mob-pt-col">
      <span class="mob-pt-col-head">${t('want_label')||'Vuoi'}(${th})</span>
      <div class="mob-stepper">
        <button onclick="chMobPT('want','${r}',-1)" ${!tgt?'disabled':''}>−</button>
        <span style="${wv>0?'color:#f0c040;font-weight:bold':''}">${wv}</span>
        <button onclick="chMobPT('want','${r}',1)" ${!tgt||wv>=wantMax?'disabled':''}>+</button>
      </div>
    </div>
  </div>`;
}
function renderPTModal(){
  const me=state.players[MY_PLAYER_ID], others=state.players.filter(p=>p.id!==MY_PLAYER_ID);
  const tgt=ptTarget!==null?state.players[ptTarget]:null;
  const blind = state.hiddenResources ?? false;
  document.getElementById('mob-trade-targets').innerHTML=others.map(p=>
    `<button class="mob-target-btn ${ptTarget===p.id?'active':''}" style="--pcol:${p.color}"
             onclick="selPTTarget(${p.id})"><span style="color:${p.color}">●</span> ${escHtml(p.name)}</button>`).join('');
  const resRows = RES_LIST.map(r => mobPTRow(r, resEmoji(r), resName(r), tgt, me, blind)).join('');
  const commodityRows = state.citiesKnights
    ? MOB_CK_COMMODITIES.map(c => mobPTRow(c, MOB_CK_COMMODITY_ICON[c], commodityName(c), tgt, me, blind)).join('')
    : '';
  document.getElementById('mob-pt-rows').innerHTML = resRows +
    (commodityRows ? `<div class="drawer-section-title" style="margin:10px 0 4px">${t('sec_city_improvements')||'Città & Cavalieri'}</div>${commodityRows}` : '');
}
document.getElementById('mob-btn-pt-send').addEventListener('click',()=>{
  const offer=Object.fromEntries(Object.entries(ptOffer).filter(([,v])=>v>0));
  const want =Object.fromEntries(Object.entries(ptWant) .filter(([,v])=>v>0));
  const err=document.getElementById('mob-pt-error');
  if(ptTarget===null){err.textContent=t('choose_player');err.classList.remove('hidden');return;}
  if(!Object.keys(offer).length){err.textContent=t('trade_error_offer');err.classList.remove('hidden');return;}
  if(!Object.keys(want).length) {err.textContent=t('trade_error_want'); err.classList.remove('hidden');return;}
  err.classList.add('hidden');
  // Manda proposta al server (nessun accepted) — il destinatario vedrà la modale
  send({type:'TRADE_PLAYER', fromId:MY_PLAYER_ID, toId:ptTarget, offer, want});
  closeMobModal('mob-modal-player-trade');
  // Mostra messaggio di attesa al proponente
  showMobToast(t('propose_sent'));
});
// Cities & Knights: build a short, recognizable label for a city vertex
// using the resources of its adjacent hexes (no board-click needed on mobile)
function describeCityVertex(vertexId) {
  const v = state.board.vertices[vertexId];
  if (!v) return `#${vertexId}`;
  const icons = (v.adjHexes || [])
    .map(hid => state.board.hexes[hid])
    .filter(h => h && h.resource !== 'desert')
    .map(h => resEmoji(h.resource))
    .join('');
  return icons || `#${vertexId}`;
}

// Cities & Knights: modal for choosing which city to lose to a barbarian
// attack — shown to the affected player even if it's not their turn.
function showBarbarianCityChoice(choice) {
  const list = document.getElementById('mob-barbarian-city-list');
  list.innerHTML = choice.options.map(vid => `
    <button class="mob-city-choice-btn" onclick="resolveBarbarianCityChoice(${vid})">
      🏙️ ${describeCityVertex(vid)}
    </button>`).join('');
  openMobModal('mob-modal-barbarian-choice');
}
window.resolveBarbarianCityChoice = vid => {
  send({ type: 'RESOLVE_BARBARIAN_CITY_CHOICE', vertexId: vid });
  closeMobModal('mob-modal-barbarian-choice');
};

// Cities & Knights: mandatory discard down to the 4-card progress-hand limit
let mobProgressDiscardSelected = [];
function showProgressDiscardChoice(playerId) {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  document.getElementById('mob-progress-discard-info').textContent =
    `Scarta ${excess} cart${excess>1?'e':'a'} (hai ${p.progressCards.length}, il limite è 4)`;
  mobProgressDiscardSelected = [];
  renderMobProgressDiscardList(playerId);
  openMobModal('mob-modal-progress-discard');
}
function renderMobProgressDiscardList(playerId) {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  document.getElementById('mob-progress-discard-list').innerHTML = p.progressCards.map((c,idx) => {
    const selected = mobProgressDiscardSelected.includes(idx);
    return `<button class="mob-city-choice-btn" style="${selected?'background:rgba(220,60,60,.3)':''}" onclick="toggleMobProgressDiscard(${idx},${playerId})">
      ${selected?'✅ ':''}${PROGRESS_COLOR_ICON[c.color]||'📗'} ${PROGRESS_CARD_NAMES[c.type]||c.type}
    </button>`;
  }).join('');
  const btn = document.getElementById('mob-btn-progress-discard-confirm');
  btn.disabled = mobProgressDiscardSelected.length !== excess;
  btn.onclick = () => {
    send({ type: 'DISCARD_PROGRESS_CARDS', playerId, indices: mobProgressDiscardSelected });
    closeMobModal('mob-modal-progress-discard');
  };
}
window.toggleMobProgressDiscard = (idx, playerId) => {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  const pos = mobProgressDiscardSelected.indexOf(idx);
  if (pos >= 0) mobProgressDiscardSelected.splice(pos, 1);
  else if (mobProgressDiscardSelected.length < excess) mobProgressDiscardSelected.push(idx);
  renderMobProgressDiscardList(playerId);
};

// Cities & Knights: tied Defender of Catan — pick a progress-card color
function showDefenderColorChoice(playerId) {
  document.getElementById('mob-defender-choice-list').innerHTML =
    ['trade','politics','science'].map(c =>
      `<button class="mob-city-choice-btn" onclick="pickMobDefenderColor(${playerId},'${c}')">
        ${PROGRESS_COLOR_ICON[c]||'📗'} ${t('ck_track_'+c) || c}
      </button>`).join('');
  openMobModal('mob-modal-defender-choice');
}
window.pickMobDefenderColor = (playerId, color) => {
  send({ type: 'CHOOSE_DEFENDER_PROGRESS', playerId, color });
  closeMobModal('mob-modal-defender-choice');
};

// ── Cities & Knights: knight recruitment + management (mobile) ─────
const MOB_KNIGHT_RANKS = ['basic','strong','mighty'];
const MOB_KNIGHT_RANK_VAL = { basic:1, strong:2, mighty:3 };
function showMobKnightsModal() {
  document.getElementById('mob-knights-title').textContent = t('mob_knights_title') || 'I tuoi Cavalieri';
  renderMobKnightsList();
  openMobModal('mob-modal-knights');
}
function renderMobKnightsList() {
  const me = state.players[MY_PLAYER_ID];
  const canAffordBuild = (me.resources.sheep||0)>=1 && (me.resources.ore||0)>=1;
  const basicCount = (me.knights||[]).filter(k=>k.rank==='basic').length;
  const canBuild = canAffordBuild && basicCount < 2 && state.diceRolled;
  const buildRow = `<button class="mob-city-choice-btn" ${canBuild?'':'disabled style="opacity:.4"'} onclick="mobStartBuildKnight()">
    ➕ ${t('mob_build_knight')||'Costruisci nuovo cavaliere'} <small>(1🐑1🪨)</small>
  </button>`;
  const rows = (me.knights||[]).map(k => {
    const rankName = t(`ck_knight_${k.rank}`) || k.rank;
    const status = k.active ? (t('ck_active')||'Attivo') : (t('ck_inactive')||'Inattivo');
    return `<button class="mob-city-choice-btn" onclick="showMobKnightActions(${k.vertexId})">
      <span class="mob-knight-row${k.active?'':' inactive'}">
        <span class="mob-knight-info">${MOB_KNIGHT_EMOJI[k.rank]||'🛡️'} ${rankName}</span>
        <small>${status}</small>
      </span>
    </button>`;
  }).join('');
  document.getElementById('mob-knights-list').innerHTML = buildRow + rows;
}
window.mobStartBuildKnight = () => {
  closeMobModal('mob-modal-knights');
  setMobBuildMode('knight');
};
window.showMobKnightActions = vertexId => {
  const me = state.players[MY_PLAYER_ID];
  const knight = me.knights?.find(k=>k.vertexId===vertexId);
  if (!knight) return;
  const idx = MOB_KNIGHT_RANKS.indexOf(knight.rank);
  const vertex = state.board.vertices[vertexId];
  const politicsLvl = me.cityImprovements?.politics || 0;
  const canAffordActivate = (me.resources.wheat||0) >= 1;
  const canAffordPromote  = (me.resources.sheep||0)>=1 && (me.resources.ore||0)>=1;
  const adjacentToRobber = vertex.adjHexes.includes(state.robberHexId);
  let canDisplace = false;
  for (const eid of vertex.adjEdges) {
    const e = state.board.edges[eid];
    if (e.owner === null) continue;
    const otherId = e.v1===vertexId ? e.v2 : e.v1;
    for (const p of state.players) {
      if (p.id === MY_PLAYER_ID) continue;
      const ek = p.knights?.find(k=>k.vertexId===otherId);
      if (ek && MOB_KNIGHT_RANK_VAL[knight.rank] > MOB_KNIGHT_RANK_VAL[ek.rank]) { canDisplace = true; break; }
    }
    if (canDisplace) break;
  }

  const rankName = t(`ck_knight_${knight.rank}`) || knight.rank;
  const actions = [];
  if (!knight.active) {
    actions.push(`<button class="mob-city-choice-btn" ${canAffordActivate?'':'disabled style="opacity:.4"'} onclick="mobKnightAction('activate',${vertexId})">🌾 ${t('ck_activate')||'Attiva'} <small>(1🌾)</small></button>`);
  }
  if (idx < MOB_KNIGHT_RANKS.length - 1) {
    const nextRank = MOB_KNIGHT_RANKS[idx+1];
    const politicsBlocked = nextRank==='mighty' && politicsLvl < 3;
    const disabled = politicsBlocked || !canAffordPromote;
    const reason = politicsBlocked ? (t('ck_need_politics')||'Richiede Politica liv.3')
                 : (!canAffordPromote ? (t('ck_missing')||'risorse insufficienti') : '');
    actions.push(`<button class="mob-city-choice-btn" ${disabled?'disabled style="opacity:.4"':''} onclick="mobKnightAction('promote',${vertexId})">⬆️ ${t('ck_promote')||'Promuovi'} <small>(1🐑1🪨)</small>${reason?`<br><small>${reason}</small>`:''}</button>`);
  }
  if (knight.active && !knight.usedActionThisTurn) {
    actions.push(`<button class="mob-city-choice-btn" onclick="mobKnightStartMove(${vertexId})">🚶 ${t('ck_move')||'Muovi'}</button>`);
    if (adjacentToRobber) actions.push(`<button class="mob-city-choice-btn" onclick="mobKnightStartChase(${vertexId})">🦹 ${t('ck_chase_robber')||'Scaccia il Brigante'}</button>`);
    if (canDisplace) actions.push(`<button class="mob-city-choice-btn" onclick="mobKnightStartDisplace(${vertexId})">⚔️ ${t('ck_displace')||'Respingi Cavaliere'}</button>`);
  }
  if (!actions.length) actions.push(`<div style="color:#c8b080;font-size:.8rem">${t('ck_no_actions')||'Nessuna azione disponibile per questo cavaliere ora'}</div>`);

  const backRow = `<button class="mob-city-choice-btn" onclick="renderMobKnightsList()">← ${t('cancel_btn')||'Indietro'}</button>`;
  document.getElementById('mob-knights-title').textContent = `${MOB_KNIGHT_EMOJI[knight.rank]||'🛡️'} ${rankName}`;
  document.getElementById('mob-knights-list').innerHTML = actions.join('') + backRow;
};
window.mobKnightAction = (action, vertexId) => {
  if (action==='activate') send({ type:'ACTIVATE_KNIGHT', vertexId });
  else if (action==='promote') send({ type:'PROMOTE_KNIGHT', vertexId });
  // Refresh in place once the broadcast lands (handled by the state-update
  // sync below); if the modal is still open, re-show this knight's actions.
  setTimeout(() => {
    const stillOwned = state.players[MY_PLAYER_ID]?.knights?.some(k=>k.vertexId===vertexId);
    if (stillOwned && document.getElementById('mob-modal-knights').classList.contains('open')) {
      showMobKnightActions(vertexId);
    }
  }, 150);
};
window.mobKnightStartMove = vertexId => {
  knightActionFrom = vertexId;
  closeMobModal('mob-modal-knights');
  setMobBuildMode('knight_move_target');
};
window.mobKnightStartChase = vertexId => {
  knightActionFrom = vertexId;
  closeMobModal('mob-modal-knights');
  setMobBuildMode('knight_chase_target');
};
window.mobKnightStartDisplace = vertexId => {
  knightActionFrom = vertexId;
  closeMobModal('mob-modal-knights');
  setMobBuildMode('knight_displace_target');
};

// ── Cities & Knights: city improvements (mobile) ────────────────────
const MOB_CK_TRACKS = [
  { id: 'trade',    commodity: 'cloth', icon: '⚖️' },
  { id: 'politics', commodity: 'coin',  icon: '👑' },
  { id: 'science',  commodity: 'paper', icon: '🔬' }
];
function showMobImprovementsModal() {
  renderMobImprovementsList();
  openMobModal('mob-modal-improvements');
}
function renderMobImprovementsList() {
  const p = state.players[MY_PLAYER_ID];
  document.getElementById('mob-improvements-list').innerHTML = MOB_CK_TRACKS.map(tr => {
    const level = p.cityImprovements?.[tr.id] || 0;
    const have  = p.commodities?.[tr.commodity] || 0;
    const maxed = level >= 5;
    const nextLevel = level + 1;
    const cost = nextLevel;
    const holder = state.metropolises?.[tr.id] || null;
    const holderLevel = holder ? (state.players[holder.playerId]?.cityImprovements?.[tr.id] || 0) : 0;
    const grantsMetro = (!holder || holder.playerId !== p.id) && nextLevel > holderLevel;
    const metroVertices = new Set(Object.values(state.metropolises||{}).filter(Boolean).map(m => m.vertexId));
    const hasAvailableCity = (p.cities||[]).some(v => !metroVertices.has(v));
    const needsCity = nextLevel >= 4 && grantsMetro && !hasAvailableCity;
    const cantAfford = have < cost;
    const disabled = maxed || needsCity || cantAfford;
    const holdsMetro = holder?.playerId === p.id;
    const dots = Array.from({length:5}, (_,i)=>`<span class="ck-dot${i<level?' filled':''}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:3px;background:${i<level?'#f0c040':'rgba(255,255,255,.2)'}"></span>`).join('');
    const trackName = t(`ck_track_${tr.id}`) || tr.id;
    let reason = '';
    if (maxed) reason = t('ck_maxed') || 'MAX';
    else if (needsCity) reason = t('ck_need_city') || 'Serve una città non-metropoli';
    else if (cantAfford) reason = `${MOB_CK_COMMODITY_ICON[tr.commodity]} ${cost-have} ${t('ck_missing')||'mancanti'}`;
    return `<div class="mob-city-choice-btn" style="display:flex;flex-direction:column;gap:6px;align-items:stretch;${disabled?'opacity:.7':''}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>${tr.icon} ${trackName} ${holdsMetro?'🏛️':''}</span>
        <span>${dots}</span>
      </div>
      <button class="mob-big-btn ${disabled?'grey':'green'}" ${disabled?'disabled':''} onclick="mobBuyCityImprovement('${tr.id}')" style="margin-top:0">
        ${maxed ? (t('ck_maxed')||'MAX') : `${t('ck_buy')||'Compra'} ${MOB_CK_COMMODITY_ICON[tr.commodity]}${cost} (hai ${have})`}
      </button>
      ${(!maxed && disabled) ? `<small style="color:#e08080">${reason}</small>` : ''}
    </div>`;
  }).join('');
}
window.mobBuyCityImprovement = track => {
  send({ type: 'BUY_CITY_IMPROVEMENT', track });
  // Re-rendered by the state-update handler on the next broadcast (never
  // optimistically from local state — see the equivalent web fix).
};

function showTradeAccept(trade){
  // trade = { fromId, toId, offer, want } — chiamata sul telefono del DESTINATARIO
  const from=state.players[trade.fromId], to=state.players[trade.toId];
  const chipIcon = r => MOB_CK_COMMODITIES.includes(r) ? MOB_CK_COMMODITY_ICON[r] : resEmoji(r);
  const fmt=obj=>Object.entries(obj).filter(([,a])=>a>0).map(([r,a])=>`${a}×${chipIcon(r)}`).join(' ');

  // Check if recipient has the requested resources/commodities
  const toMissing = Object.entries(trade.want||{})
    .filter(([r,a])=>(mobTradePool(to,r)[r]||0) < parseInt(a));
  const canAccept = toMissing.length === 0;

  document.getElementById('mob-accept-title').innerHTML=
    `<span style="color:${from.color}">${escHtml(from.name)}</span> → <span style="color:${to.color}">${escHtml(to.name)}</span>`;
  document.getElementById('mob-accept-details').innerHTML=`
    <p style="margin:8px 0"><b>${escHtml(from.name)}</b> dà: ${fmt(trade.offer)}</p>
    <p style="margin:8px 0"><b>${escHtml(to.name)}</b> dà: ${fmt(trade.want)}</p>
    ${!canAccept ? `<p style="color:#e06060;margin:8px 0;font-size:.85rem">⚠️ ${escHtml(to.name)} non ha le risorse richieste</p>` : ''}
    <p style="color:${to.color};margin-top:14px;font-weight:bold;text-align:center">${escHtml(to.name)}, accetti?</p>`;
  document.getElementById('mob-btn-accept').style.display = canAccept ? '' : 'none';
  document.getElementById('mob-btn-accept').onclick=()=>{
    send({type:'TRADE_PLAYER', fromId:trade.fromId, toId:trade.toId,
          offer:trade.offer, want:trade.want, accepted:true});
    closeMobModal('mob-modal-accept');
  };
  document.getElementById('mob-btn-reject').textContent = canAccept ? t('reject_btn')||'Rifiuta' : t('close_btn')||'Chiudi';
  document.getElementById('mob-btn-reject').onclick=()=>{
    send({type:'TRADE_PLAYER', fromId:trade.fromId, toId:trade.toId, rejected:true});
    closeMobModal('mob-modal-accept');
  };
  openMobModal('mob-modal-accept');
}

// Toast temporaneo per feedback
function showMobStealDelta(deltas) {
  // Show a toast for each player with resource changes
  const lines = [];
  for (const [pidStr, res] of Object.entries(deltas)) {
    const pid = parseInt(pidStr);
    const p = state.players[pid];
    if (!p) continue;
    const parts = Object.entries(res).map(([r, d]) =>
      `${d > 0 ? '+' : ''}${d}${resEmoji(r)}`
    ).join(' ');
    lines.push(`<span style="color:${p.color}">${escHtml(p.name)}</span> ${parts}`);
  }
  if (!lines.length) return;

  // Show as a dismissable overlay toast
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:rgba(20,20,40,.95);border:2px solid #c8a84b;border-radius:16px;
    padding:18px 28px;z-index:9999;text-align:center;color:#fff;font-size:1.1rem;
    line-height:1.8;box-shadow:0 4px 24px rgba(0,0,0,.7);min-width:200px;`;
  el.innerHTML = `<div style="font-size:.85rem;color:#c8a84b;margin-bottom:8px">🕴 ${skinLabel('robber','Marsellus Wallace')} ha colpito</div>
    ${lines.join('<br>')}
    <div style="font-size:.75rem;color:#666;margin-top:10px">Tocca per chiudere</div>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function showMobToast(msg, duration=2500, cls='') {
  let el = document.getElementById('mob-toast');
  if (!el) {
    el = document.createElement('div'); el.id='mob-toast';
    el.style.cssText='position:fixed;top:80px;left:50%;transform:translateX(-50%);'+
      'padding:14px 24px;border-radius:14px;font-size:1rem;font-weight:bold;'+
      'z-index:300;pointer-events:none;transition:opacity .35s;text-align:center;'+
      'max-width:90vw;white-space:nowrap;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  // Style by class
  if (cls === 'toast-ok') {
    el.style.background = 'rgba(20,80,30,.97)';
    el.style.border     = '2px solid #50cc70';
    el.style.color      = '#90ffa0';
  } else if (cls === 'toast-ko') {
    el.style.background = 'rgba(80,20,20,.97)';
    el.style.border     = '2px solid #cc5050';
    el.style.color      = '#ffaa90';
  } else {
    el.style.background = 'rgba(20,20,30,.95)';
    el.style.border     = '1px solid #c8a44a';
    el.style.color      = '#f0e6c8';
  }
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0'; }, duration);
}

// ================================================================
//  DEV CARDS
// ================================================================
document.getElementById('mob-btn-play-dev').addEventListener('click',()=>{
  const me=state.players[MY_PLAYER_ID], cards=me.devCards||[];
  const list=document.getElementById('mob-dev-list');
  if(!cards.length){list.innerHTML=`<p style="color:#c8b080;padding:10px">${t('no_cards')}</p>`;}
  else {
    const rolled2 = state.diceRolled;
    const counts={};
    for(const c of cards){if(c.type==='victoryPoint')continue;const k=c.type+(c.new?'_n':'');counts[k]=(counts[k]||0)+1;}
    list.innerHTML=Object.entries(counts).map(([k,cnt])=>{
      const isNew=k.endsWith('_n'), type=k.replace('_n','');
      const isKnight=type==='knight';
      const disabled=isNew||(!rolled2&&!isKnight);
      const badge=isNew?`<small style="color:#8a7a60">${t('next_turn_small')}</small>`
                 :!rolled2&&!isKnight?`<small style="color:#8a7a60">dopo il dado</small>`
                 :isKnight&&!rolled2?`<small style="color:#70ff90">⚔️ ora!</small>`
                 :'';
      return `<button class="mob-build-btn" style="width:100%;border-radius:10px;padding:12px;margin:5px 0;justify-content:center;${disabled?'opacity:.4':''}"
               ${disabled?'disabled':''} onclick="playMobDev('${type}')">
        ${DEV_NAMES[type]||type} ×${cnt} ${badge}
      </button>`;
    }).join('');
  }
  openMobModal('mob-modal-dev');
});
window.playMobDev=type=>{
  closeMobModal('mob-modal-dev');
  if(type==='yearOfPlenty'){
    let yc=[];
    document.getElementById('mob-yop-res').innerHTML=RES_LIST.map(r=>{
      return `<button class="mob-res-btn" data-res="${r}" onclick="togYOP('${r}')"><span class="re">${resEmoji(r)}</span><span>${resName(r)}</span></button>`;
    }).join('');
    window.togYOP=res=>{yc.includes(res)?yc=yc.filter(r=>r!==res):yc.length<2&&yc.push(res);
      document.querySelectorAll('#mob-yop-res .mob-res-btn').forEach(b=>b.classList.toggle('selected',yc.includes(b.dataset.res)));};
    document.getElementById('mob-btn-yop-confirm').onclick=()=>{
      if(yc.length!==2){alert(t('choose_2'));return;}
      send({type:'PLAY_DEV_CARD',cardType:'yearOfPlenty',params:{resources:yc}});
      closeMobModal('mob-modal-yop');
    };
    openMobModal('mob-modal-yop');
  } else if(type==='monopoly'){
    document.getElementById('mob-mono-res').innerHTML=RES_LIST.map(r=>{
      return `<button class="mob-res-btn" onclick="send({type:'PLAY_DEV_CARD',cardType:'monopoly',params:{resource:'${r}'}});closeMobModal('mob-modal-monopoly')">
        <span class="re">${resEmoji(r)}</span><span>${resName(r)}</span>
      </button>`;
    }).join('');
    openMobModal('mob-modal-monopoly');
  } else {
    send({type:'PLAY_DEV_CARD',cardType:type,params:{}});
  }
};

// ================================================================
//  DICE ANIMATION
// ================================================================
function playDiceAnim(d1,d2){
  const ov=document.getElementById('mob-dice-overlay');
  const bd1=document.getElementById('mob-big-d1'), bd2=document.getElementById('mob-big-d2');
  const tot=document.getElementById('mob-dice-total');
  ov.classList.remove('hidden');
  bd1.textContent='?'; bd2.textContent='?';
  bd1.classList.add('rolling'); bd2.classList.add('rolling');
  tot.classList.remove('visible','seven'); tot.textContent='';
  let tick=0;
  const iv=setInterval(()=>{
    bd1.textContent=dieChar(Math.floor(Math.random()*6)+1);
    bd2.textContent=dieChar(Math.floor(Math.random()*6)+1);
    if(++tick>=10){
      clearInterval(iv);
      bd1.textContent=dieChar(d1); bd2.textContent=dieChar(d2);
      bd1.classList.remove('rolling'); bd2.classList.remove('rolling');
      bd1.classList.add('landed'); bd2.classList.add('landed');
      const sum=d1+d2; tot.textContent=`= ${sum}`;
      if(sum===7) tot.classList.add('seven');
      setTimeout(()=>tot.classList.add('visible'),50);
      setTimeout(()=>{
        ov.classList.add('hidden');
        bd1.classList.remove('landed'); bd2.classList.remove('landed');
        // Phase 2: flash producing hexes then show gains
        if(sum===7) {
          document.body.classList.remove('gain-blocking'); // 7 = no gains, unblock now
        } else {
          startMobHexFlash(sum);
        }
      },1800);
    }
  },80);
}

function startMobHexFlash(total){
  if(!state) return;
  const producing = state.board.hexes.filter(h=>h.number===total && h.id!==state.robberHexId);
  if(!producing.length){ showMobGains(total); return; }

  let flash=0;
  const iv=setInterval(()=>{
    flash++;
    renderBoardCanvas();
    // Draw highlight on producing hexes
    const lit = flash%2===1;
    if(lit){
      for(const hex of producing){
        bctx.beginPath();
        for(let i=0;i<6;i++){
          const a=Math.PI/3*i-Math.PI/6;
          const vx=bpx(hex.cx)+HS()*.95*Math.cos(a), vy=bpy(hex.cy)+HS()*.95*Math.sin(a);
          i===0?bctx.moveTo(vx,vy):bctx.lineTo(vx,vy);
        }
        bctx.closePath();
        bctx.strokeStyle='#ffee44'; bctx.lineWidth=HS()*.12; bctx.stroke();
        bctx.fillStyle='rgba(255,238,68,.2)'; bctx.fill();
      }
    }
    if(flash>=10){
      clearInterval(iv);
      renderBoardCanvas(); // restore normal
      showMobGains(total);
    }
  },200);
}

function computeMobGains(total){
  const gains={}, commodityGains={};
  if(!state||total===7) return {gains, commodityGains};
  const HEX_COMMODITY = { wood:'paper', sheep:'cloth', ore:'coin' };
  const ck = !!state.citiesKnights;
  for(const hex of state.board.hexes){
    if(hex.number!==total||hex.id===state.robberHexId) continue;
    if(hex.resource==='desert') continue;
    for(const vid of hex.vertices){
      const v=state.board.vertices[vid];
      if(!v||v.owner==null) continue;
      const isCity = v.building==='city';
      if(!gains[v.owner]) gains[v.owner]={};
      if(ck && isCity && HEX_COMMODITY[hex.resource]){
        gains[v.owner][hex.resource]=(gains[v.owner][hex.resource]||0)+1;
        const commodity = HEX_COMMODITY[hex.resource];
        if(!commodityGains[v.owner]) commodityGains[v.owner]={};
        commodityGains[v.owner][commodity]=(commodityGains[v.owner][commodity]||0)+1;
      } else {
        const mult = isCity?2:1;
        gains[v.owner][hex.resource]=(gains[v.owner][hex.resource]||0)+mult;
      }
    }
  }
  return {gains, commodityGains};
}

let mobGainsDismissed = false;

function showMobGains(total){
  if (state?.winner !== null) return;
  const { gains, commodityGains } = computeMobGains(total);
  const myGains = gains[MY_PLAYER_ID];
  const myCommodityGains = commodityGains[MY_PLAYER_ID];

  // Update resources row with +N badges
  const me = state.players[MY_PLAYER_ID];
  const resEl = document.getElementById('mob-resources');
  if(me && resEl){
    const resPills = RES_LIST.map(r=>{
      const n=me.resources[r]||0;
      const g=myGains?.[r];
      const badge=g?`<span class="mob-res-gain">+${g}</span>`:'';
      return `<div class="mob-res-pill${g?' gained':''}"><span>${resEmoji(r)}</span><span class="n">${n}</span>${badge}</div>`;
    }).join('');
    const comPills = state.citiesKnights ? MOB_CK_COMMODITIES.map(c=>{
      const n=me.commodities?.[c]||0;
      const g=myCommodityGains?.[c];
      const badge=g?`<span class="mob-res-gain">+${g}</span>`:'';
      return `<div class="mob-res-pill${g?' gained':''}"><span>${MOB_CK_COMMODITY_ICON[c]}</span><span class="n">${n}</span>${badge}</div>`;
    }).join('') : '';
    resEl.innerHTML = resPills + comPills;
  }

  // If no gains for anyone, no dismiss needed
  const anyGains = Object.keys(gains).length>0 || Object.keys(commodityGains).length>0;
  if(!anyGains) return;

  // Show gain summary banner (tap to dismiss)
  let banner = document.getElementById('mob-gain-banner');
  if(!banner){
    banner = document.createElement('div');
    banner.id='mob-gain-banner';
    banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:50;'+
      'background:rgba(10,12,20,.96);border-top:2px solid #c8a44a;'+
      'padding:14px 16px;text-align:center;cursor:pointer;';
    document.getElementById('screen-active').appendChild(banner);
  }

  // Build summary: who got what (resources + commodities)
  const pids = new Set([...Object.keys(gains), ...Object.keys(commodityGains)]);
  const lines = [...pids].map(pid=>{
    const p=state.players[pid];
    const res=Object.entries(gains[pid]||{}).map(([r,n])=>`${n}×${resEmoji(r)}`).join(' ');
    const com=Object.entries(commodityGains[pid]||{}).map(([c,n])=>`${n}×${MOB_CK_COMMODITY_ICON[c]}`).join(' ');
    return `<span style="color:${p.color};font-weight:bold">${escHtml(p.name)}</span>: ${[res,com].filter(Boolean).join(' ')}`;
  });
  banner.innerHTML = `
    <div style="font-size:.85rem;color:#f0e6c8;margin-bottom:6px">${lines.join(' &nbsp;|&nbsp; ')}</div>
    <div style="font-size:.75rem;color:#c8a44a">▶ ${t('tap_to_continue')||'Tap to continue'}</div>`;
  banner.style.display='block';
  mobGainsDismissed=false;

  const dismiss=()=>{
    if(mobGainsDismissed) return;
    mobGainsDismissed=true;
    banner.style.display='none';
    document.body.classList.remove('gain-blocking');
    // Clear gain badges
    document.querySelectorAll('.mob-res-pill.gained').forEach(el=>{
      el.classList.remove('gained');
      el.querySelector('.mob-res-gain')?.remove();
    });
  };
  banner.addEventListener('click', dismiss, {once:true});
  // Auto-dismiss after 6s
  setTimeout(dismiss, 6000);
}

// ── Winner ────────────────────────────────────────────────────────
function showWinner(){
  const w=state.players[state.winner];
  document.getElementById('mob-winner-content').innerHTML=
    `<div style="font-size:2.8rem">🏆</div>
     <div style="color:${w.color};font-size:1.4rem;font-weight:bold;margin:8px 0">${escHtml(w.name)}</div>
     <div>${t('winner_text',w.name,w.points)}</div>`;
  // Clean up any lingering UI
  setMobBuildMode(null);
  expandSheet();
  const gainBanner = document.getElementById('mob-gain-banner');
  if (gainBanner) gainBanner.style.display = 'none';
  openMobModal('mob-modal-winner');
}

// ── Modal helpers ─────────────────────────────────────────────────
function openMobModal(id)  { document.getElementById(id).classList.add('open'); }
window.closeMobModal = id  => { document.getElementById(id).classList.remove('open'); };

// ── Utils ─────────────────────────────────────────────────────────
function applyMobileTranslations() {
  document.querySelectorAll('[data-t]').forEach(el => {
    const v = t(el.getAttribute('data-t'));
    if (v && v !== el.getAttribute('data-t')) el.textContent = v;
  });
  // Apply skin label overrides on top of i18n
  document.querySelectorAll('[data-skin-label]').forEach(el => {
    const key = el.getAttribute('data-skin-label');
    const override = SKIN?.labels?.[key];
    if (override) el.textContent = override;
  });
  // Update resource cost badges with skin-aware emojis
  document.querySelectorAll('[data-res-cost]').forEach(el => {
    const res = el.getAttribute('data-res-cost').split(',');
    const sep = el.getAttribute('data-res-cost').includes('wood,brick') && res.length === 2 ? '+' : '';
    el.textContent = sep ? res.map(r => resEmoji(r)).join('+') : res.map(r => resEmoji(r)).join('');
  });
}

function mobHasValidSettlementSpot(pid) {
  if (!state?.board) return false;
  return state.board.vertices.some(v => {
    if (v.owner !== null) return false;
    // distance rule: no adjacent settled vertex
    for (const eid of v.adjEdges) {
      const e = state.board.edges[eid];
      const nid = e.v1 === v.id ? e.v2 : e.v1;
      if (state.board.vertices[nid].owner !== null) return false;
    }
    // must be adjacent to own road
    return v.adjEdges.some(eid => state.board.edges[eid].owner === pid);
  });
}

function dieChar(n){ return ['','⚀','⚁','⚂','⚃','⚄','⚅'][n]||n; }
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function lighten(hex,pct){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),f=pct/100; return `rgb(${Math.min(255,r+f*200)},${Math.min(255,g+f*200)},${Math.min(255,b+f*200)})`; }
function darken(hex,pct)  { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),f=pct/100; return `rgb(${Math.max(0,r-f*200)},${Math.max(0,g-f*200)},${Math.max(0,b-f*200)})`; }

// ── Resize ────────────────────────────────────────────────────────
window.addEventListener('resize', ()=>{
  if (state && document.getElementById('screen-active').classList.contains('active')) {
    fitBoardToScreen(); renderBoardCanvas();
  }
  if (state && document.getElementById('screen-wait').classList.contains('active')) {
    renderMiniBoard();
  }
});

// ── Boot ──────────────────────────────────────────────────────────
init();
