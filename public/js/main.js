// ===================================================================
//  CATAN WEB CLIENT  —  public/js/main.js
//
//  Handles the admin/desktop view (index.html) and web-player mode.
//
//  Key responsibilities:
//    • Setup screen: player config, options, skin selection, QR/link gen
//    • Canvas board rendering (hexes, numbers, buildings, roads, ports)
//    • Game UI: dice, building buttons, dev cards, trade modals
//    • WebSocket connection and STATE_UPDATE handling
//    • WEB_PLAYER_ID: set when opening a web-player link with ?token=
//      null = admin (sees everything); non-null = specific player
//    • shouldHideRes(p): central decision for hidden-resources display
//
//  Skin loading (loadSkinAssets):
//    Fetches skin.json and preloads all images asynchronously.
//    Render is deferred until the skin is ready to avoid a flash of
//    unskinned content on the first STATE_UPDATE.
//
//  i18n: all display strings go through t(key) from i18n.js.
//  Skin label overrides are applied via skinLabel(key, fallback).
// ===================================================================

// The 4 immutable standard Catan colors (never mutated)
const CATAN_COLORS = ['#e03030', '#4080e0', '#30a030', '#e0a020'];
// Per-player chosen colors (separate mutable array)
let playerColors = ['#e03030', '#4080e0', '#30a030', '#e0a020'];

let uiScale = 2; // 1 | 1.7 | 2  — default Maxi
let desertCenter = true;  // default: desert at center
let zeroResources = true;  // default: no starting resources
let hiddenResources = true; // default: hide other players' resource counts
let balancedResources = false; // default: pure random tile placement
let citiesKnights = false; // default: base game, no Cities & Knights variant
let randomPorts   = false; // default: standard port layout
let randomNumbers = false; // default: standard spiral number placement
let quickGame     = false; // default: win at 10 points; quick=win at 7
let unlimitedDev  = true;  // default: unlimited dev cards per turn (house rule)
let instantDev    = false; // default: dev cards need 1 turn to become playable
let debugDevCard   = null;   // debug: force first dev card type
let debugResources = false;  // debug: give 10 of each resource at game start
let debugSkipSetup = false;  // debug: auto-place everyone's initial settlements/roads
let debugForceDice = null;   // debug: force dice total (null = disabled)
let selectedSkinId = 'standard';
let currentWebLink = '';
let currentQRLink  = '';
let SKIN = null; // loaded skin data: { id, hexImages:{wood:Image,...} }
let currentPin = null;

// Mobile detection — declared early so all code can use it
const _isMobile = window.innerWidth <= 600 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (_isMobile) {
  document.addEventListener('DOMContentLoaded', () => {
    const phoneBtn = document.getElementById('phone-host-btn');
    if (phoneBtn) phoneBtn.style.display = '';
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.style.display = 'none';
  });
}
let WEB_PLAYER_ID = null; // set when joining as specific player via web link // 5-digit room PIN
let diceAnimating = false; // must be declared early — used in renderHUD

function showRuleToast(descKey) {
  const msg = t(descKey);
  if (!msg) return;
  let el = document.getElementById('rule-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rule-toast';
    el.style.cssText = `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
      background:rgba(20,20,40,.97);border:2px solid #c8a84b;border-radius:14px;
      padding:14px 24px;z-index:9999;color:#fff;font-size:.95rem;text-align:center;
      max-width:360px;box-shadow:0 4px 20px rgba(0,0,0,.6);cursor:pointer;line-height:1.5;`;
    el.onclick = () => { clearTimeout(el._t); el.remove(); };
    document.body.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 5000);
}

// ===================================================================
//  MODERN HOVER TOOLTIPS
//  Any element with data-tip="text" gets a styled floating tooltip on
//  hover instead of the plain browser one. A single delegated listener
//  on document means this keeps working even though player cards,
//  build buttons, etc. get their innerHTML fully replaced on every
//  render — there's nothing per-element to re-attach.
// ===================================================================
(function initHoverTooltips() {
  const tip = document.createElement('div');
  tip.id = 'hover-tooltip';
  document.body.appendChild(tip);

  function position(el) {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 10;
    let below = false;
    if (y < 4) { y = r.bottom + 10; below = true; }
    x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    tip.classList.toggle('below', below);
  }
  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('visible');
    position(el);
  }
  function hide() { tip.classList.remove('visible'); }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tip]');
    if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();

function applyTranslations() {
  document.querySelectorAll('[data-t]').forEach(el => {
    const key = el.getAttribute('data-t');
    const val = t(key);
    if (val && val !== key) el.textContent = val;
  });
  // Apply skin label overrides on top of i18n
  document.querySelectorAll('[data-skin-label]').forEach(el => {
    const key = el.getAttribute('data-skin-label');
    const override = SKIN?.labels?.[key];
    if (override) el.textContent = override;
  });
  // Update resource cost badges with skin-aware emojis + hover tooltip with the name
  document.querySelectorAll('[data-res-cost]').forEach(el => {
    const res = el.getAttribute('data-res-cost').split(',');
    const sep = el.getAttribute('data-res-cost').includes('wood,brick') && res.length === 2 ? '+' : '';
    el.textContent = sep ? res.map(r => resEmoji(r)).join('+') : res.map(r => resEmoji(r)).join('');
    const counts = {};
    res.forEach(r => counts[r] = (counts[r]||0)+1);
    el.setAttribute('data-tip', Object.entries(counts).map(([r,n]) => n>1 ? `${resName(r)}×${n}` : resName(r)).join(', '));
  });
}

let logOpen = false;
function toggleLog() {
  logOpen = !logOpen;
  document.getElementById('log-panel').classList.toggle('hidden', !logOpen);
}

const RES_EMOJI  = { wood:'🪵', brick:'🧱', sheep:'🐑', wheat:'🌾', ore:'🪨', desert:'🏜', any:'🌀' };
const RES_COLORS = { wood:'#2d7a2d', brick:'#a03010', sheep:'#70c040', wheat:'#c8a020', ore:'#607090', desert:'#c8b070' };

// Map player hex color → skin color key
function skinColorKey(hexColor) {
  if (!hexColor) return 'red';
  const h = hexColor.toLowerCase();
  const r=parseInt(h.slice(1,3),16)||0, g=parseInt(h.slice(3,5),16)||0, b=parseInt(h.slice(5,7),16)||0;
  // Yellow: high R+G, low B
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
// DEV_NAMES is a function so it always returns the current language
function DEV_NAMES_MAP() { return {
  knight:       skinLabel('knight',       t('devname_knight')     || '⚔️ Knight'),
  victoryPoint: t('devname_vp')                                   || '⭐ Victory Point',
  roadBuilding: skinLabel('road_building', t('devname_road_build') || '🛤 Road Building'),
  yearOfPlenty: skinLabel('devname_yop',   t('devname_yop')        || '🌻 Year of Plenty'),
  monopoly:     skinLabel('devname_monopoly', t('devname_monopoly') || '👑 Monopoly'),
}; }
// Backward-compat proxy
const DEV_NAMES = new Proxy({}, { get: (_,k) => DEV_NAMES_MAP()[k] });

// Medal badge: 🥇 symbol for longest road / largest army
function badgeHTML(p) {
  const badges = [];
  if (p.hasLongestRoad)  badges.push(`<span class="medal-badge road-medal"  data-tip="${skinLabel('longest_road','Longest Road')}">${skinLabel('longest_road_emoji','🛤')}🥇</span>`);
  if (p.hasLargestArmy)  badges.push(`<span class="medal-badge army-medal"  data-tip="${skinLabel('largest_army','Largest Army')}">${skinLabel('largest_army_emoji','⚔️')}🥇</span>`);
  const kn = p.knightsPlayed || 0;
  if (kn > 0 && !p.hasLargestArmy) badges.push(`<span class="knight-count">⚔️×${kn}</span>`);
  else if (kn > 0 && p.hasLargestArmy) badges[badges.length-1] = `<span class="medal-badge army-medal" data-tip="${skinLabel('largest_army','Largest Army')}">${skinLabel('largest_army_emoji','⚔️')}🥇<sup>${kn}</sup></span>`;
  if (state?.citiesKnights && state.metropolises) {
    for (const tr of ['trade','politics','science']) {
      if (state.metropolises[tr]?.playerId === p.id) {
        const name = t(`ck_track_${tr}`) || tr;
        badges.push(`<span class="medal-badge ck-metro-medal" data-tip="${t('ck_metropolis')||'Metropoli'}: ${name}">🏛️</span>`);
      }
    }
  }
  return badges.join('');
}

// ===================================================================
//  WEBSOCKET
// ===================================================================
let ws;
let state    = null;
let buildMode = null; // 'road'|'settlement'|'city'|'knight'|'knight_move_target'|'knight_chase_target'|'knight_displace_target'|null
let knightActionFrom = null; // vertexId of the knight performing move/chase/displace, while targeting

let _wsPingInterval = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs    = currentPin ? `?pin=${currentPin}` : '';
  ws = new WebSocket(`${proto}://${location.host}${qs}`);
  ws.onopen = () => {
    console.log('WS ready, pin=' + (currentPin||'–'));
    // Keep-alive ping every 30s to prevent Render.com timeout
    clearInterval(_wsPingInterval);
    _wsPingInterval = setInterval(() => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({type:'PING'}));
    }, 30000);
    // Clear any leftover blocking state from before disconnect/reload
    diceAnimating = false;
    document.body.classList.remove('gain-blocking');
    const dismiss = document.getElementById('gain-dismiss');
    if (dismiss) { dismiss.classList.remove('visible'); }
    const gainPopups = document.getElementById('gain-popups');
    if (gainPopups) gainPopups.innerHTML = '';

  };
  ws.onmessage = (e) => { onMessage(JSON.parse(e.data)); };
  ws.onclose   = () => {
    clearInterval(_wsPingInterval);
    setTimeout(connectWS, 1500);
  };
}
function send(d) { if (window.__SPECTATOR_MODE) return; if (ws?.readyState === 1) ws.send(JSON.stringify(d)); }

function onMessage(data) { if (window._onMessageHook) window._onMessageHook(data);
  if (data.type === 'ACTION_ERROR') {
    if (data.context === 'end_turn' && data.pendingDiscard?.length) {
      const names = data.pendingDiscard.join(', ');
      showGameToast(`⏳ ${names} ${t('must_discard_first')||'must discard first'}`, 'toast-rejected', 4000);
    } else {
      showGameToast(`⚠️ ${data.error}`, 'toast-rejected', 3000);
    }
    return;
  }
  if (data.type === 'SET_BUILD_MODE') {
    // Mobile player changed build mode — reflect it on desktop
    buildMode = data.mode;
    renderBoard();
    updateButtonStates();
    return;
  }
  if (data.type === 'MOBILE_STATUS') {
    // Update mobile connected badges in player panel
    if (state) state.mobileConnected = data.connected;
    renderPlayers();
    return;
  }
  if (data.type !== 'STATE_UPDATE') return;
  const isFirstUpdate = (state === null); // true on F5 / fresh connect
  const prevDiceRolled   = state?.diceRolled || false;
  const prevPendingTrade = state?.pendingTrade || null;
  const prevPendingSteal = state?.pendingSteal || false;
  const prevPendingRobber = state?.pendingRobber || false;
  const prevResources    = state ? state.players.map(p => ({...p.resources})) : null;
  const prevCommodities  = state ? state.players.map(p => ({...(p.commodities||{})})) : null;
  const prevLastDrawn    = state?.lastDrawnCard || null;
  const prevMaxProgressSeq = Math.max(0, ...((state?.lastDrawnProgressCards)||[]).map(d => d.seq||0));
  const prevSpecials     = state ? state.players.map(p => ({
    hasLongestRoad: p.hasLongestRoad, hasLargestArmy: p.hasLargestArmy
  })) : null;
  const prevPoints       = state ? state.players.map(p => p.points) : null;
  const prevBarbarianProgress = state?.barbarianProgress ?? 0;
  const prevDefenderPoints = state ? state.players.map(p => p.defenderPoints||0) : null;
  const prevCitiesCount  = state ? state.players.map(p => (p.cities||[]).length) : null;
  // Track setup step to reset buildMode on turn change
  const prevSetupKey = state ? (state.phase + ':' + state.setupStep + ':' + state.waitingForRoad) : null;
  state = data.state;

  // Reset buildMode when setup step/phase changes (new player's turn, or settlement→road transition)
  if (!isFirstUpdate && prevSetupKey) {
    const newSetupKey = state.phase + ':' + state.setupStep + ':' + state.waitingForRoad;
    if (prevSetupKey !== newSetupKey && (state.phase==='setup1'||state.phase==='setup2')) {
      buildMode = null;
    }
  }


  // Detect fresh dice roll BEFORE render()
  const isFreshRoll = !window.__SPECTATOR_MODE && !prevDiceRolled && state?.diceRolled && state?.diceValues?.[0];
  if (isFreshRoll) { diceAnimating = true; document.body.classList.add("gain-blocking"); }
  // pendingRobber: keep canvas interactive
  if (state?.pendingRobber) { canvas.style.pointerEvents = 'auto'; }
  else if (!isFreshRoll)    { canvas.style.pointerEvents = ''; }

  // Detect trade resolution (pendingTrade was present, now gone)
  if (!isFirstUpdate && prevPendingTrade && !state?.pendingTrade && prevResources && state) {
    handleTradeResolution(prevPendingTrade, prevResources, prevCommodities);
  }
  // Detect robber/steal resolution — covers auto-steal (1 candidate) AND manual steal
  const stealJustResolved = (prevPendingSteal && !state?.pendingSteal) ||
                             (prevPendingRobber && !state?.pendingRobber && !state?.pendingSteal);
  if (!isFirstUpdate && stealJustResolved && prevResources && state) {
    const deltas = {};
    const commodityDeltas = {};
    let anyChange = false;
    for (const p of state.players) {
      deltas[p.id] = {};
      for (const res of ['wood','brick','sheep','wheat','ore']) {
        const diff = (p.resources[res]||0) - (prevResources[p.id][res]||0);
        if (diff !== 0) { deltas[p.id][res] = diff; anyChange = true; }
      }
      if (state.citiesKnights) {
        commodityDeltas[p.id] = {};
        for (const c of ['paper','cloth','coin']) {
          const diff = (p.commodities?.[c]||0) - (prevCommodities[p.id]?.[c]||0);
          if (diff !== 0) { commodityDeltas[p.id][c] = diff; anyChange = true; }
        }
      }
    }
    if (anyChange) showStealExchangePanel(deltas, commodityDeltas);
  }

  // Cities & Knights: detect a barbarian attack that just resolved (the
  // fleet track went from a high value back to 0). We don't get a direct
  // message for this — it's folded into the regular dice-roll state update —
  // so we diff defenderPoints/city-counts against the pre-update snapshot
  // to build a readable summary.
  if (!isFirstUpdate && state?.citiesKnights && prevBarbarianProgress > 0 && state.barbarianProgress === 0
      && prevDefenderPoints && prevCitiesCount) {
    const gainedDefender = [];
    const lostCity = [];
    for (const p of state.players) {
      if ((p.defenderPoints||0) > prevDefenderPoints[p.id]) gainedDefender.push(p.name);
      if ((p.cities||[]).length < prevCitiesCount[p.id]) lostCity.push(p.name);
    }
    if (gainedDefender.length) {
      showGameToast(`🛡️ ${t('ck_barbarian_won')||'I difensori respingono i barbari!'} ${gainedDefender.join(', ')} +1 ⭐ (${t('ck_defender_of_catan')||'Difensore di Catan'})`, '', 5000);
    } else if (lostCity.length) {
      showGameToast(`🏹 ${t('ck_barbarian_lost')||'I barbari sfondano le difese!'} ${lostCity.join(', ')}`, '', 5000);
    } else if (state.pendingBarbarianChoices?.length) {
      showGameToast(`🏹 ${t('ck_barbarian_lost')||'I barbari sfondano le difese!'}`, '', 5000);
    }
  }

  // Detect dev card purchase — skip on F5/reconnect (card was already seen)
  const newDrawn = state?.lastDrawnCard;
  if (!isFirstUpdate && newDrawn && (!prevLastDrawn || prevLastDrawn.card !== newDrawn.card ||
      prevLastDrawn.subtype !== newDrawn.subtype ||
      prevLastDrawn.playerId !== newDrawn.playerId)) {
    showDevCardDrawnPopup(newDrawn);
  }

  // Cities & Knights: progress-card draw notifications. The server appends
  // to lastDrawnProgressCards during one roll (several players can draw),
  // resets it on the next roll, and tags each entry with a monotonic seq —
  // entries with seq greater than any previously seen are new. The card
  // NAME is secret: it is shown only to the owner
  // (or on the admin hotseat screen, WEB_PLAYER_ID === null, which by
  // convention sees everything — same model as hidden resources); everyone
  // else only sees the color drawn.
  const drawnProgress = state?.lastDrawnProgressCards || [];
  if (!isFirstUpdate) {
    for (const d of drawnProgress.filter(d => (d.seq||0) > prevMaxProgressSeq)) {
      const pName = state.players[d.playerId]?.name || '';
      const icon = PROGRESS_COLOR_ICON[d.color] || '📗';
      const canSeeType = WEB_PLAYER_ID === null || WEB_PLAYER_ID === d.playerId;
      const what = canSeeType ? (PROGRESS_CARD_NAMES[d.type] || d.type) : (t('ck_progress_card_hidden') || 'una carta progresso');
      showGameToast(`${icon} ${escHtml(pName)} pesca: ${what}`, '', 3500);
    }
  }

  // Detect Longest Road / Largest Army badge changes
  if (!isFirstUpdate && prevSpecials && state) {
    for (const p of state.players) {
      const prev = prevSpecials[p.id];
      if (!prev) continue;
      if (p.hasLongestRoad && !prev.hasLongestRoad)
        showGameToast(`${skinLabel('longest_road_emoji','🛤')} ${escHtml(p.name)} — ${skinLabel('longest_road', t('log_longest_road', p.name, state.longestRoadLength||'5+'))}`, 'toast-special', 4000);
      if (!p.hasLongestRoad && prev.hasLongestRoad)
        showGameToast(`${skinLabel('longest_road_emoji','🛤')} ${escHtml(p.name)} — ${t('log_lost_longest_road')||'lost Longest Road'}`, 'toast-special', 4000);
      if (p.hasLargestArmy && !prev.hasLargestArmy)
        showGameToast(`${skinLabel('largest_army_emoji','⚔️')} ${escHtml(p.name)} — ${skinLabel('largest_army', t('log_largest_army', p.name))}`, 'toast-special', 4000);
      if (!p.hasLargestArmy && prev.hasLargestArmy)
        showGameToast(`${skinLabel('largest_army_emoji','⚔️')} ${escHtml(p.name)} — ${t('log_lost_largest_army')||'lost Largest Army'}`, 'toast-special', 4000);
    }
  }

  // Detect point gains — notify ALL players
  if (!isFirstUpdate && prevPoints && state) {
    const gainers = state.players.filter(p => p.points > (prevPoints[p.id]||0));
    if (gainers.length > 0) {
      // Small delay so it doesn't overlap with dice/trade toasts
      setTimeout(() => {
        for (const p of gainers) {
          const delta = p.points - (prevPoints[p.id]||0);
          const bar = '⭐'.repeat(Math.min(p.points, 10));
          showPointsToast(p, delta);
        }
      }, gainers.some(p => !prevDiceRolled && state.diceRolled) ? 2200 : 300);
    }
  }

  // If gain-dismiss is visible but state changed (phone acted) — auto-dismiss
  const dismiss = document.getElementById('gain-dismiss');
  if (dismiss?.classList.contains('visible') && state && !state.pendingRobber && !state.pendingDiscard?.length) {
    // Trigger dismiss programmatically
    dismiss.click();
  }

  if (state) {
    if (state.pin && state.pin !== currentPin) {
      currentPin = state.pin;
      history.replaceState({}, '', `?pin=${currentPin}`);
    }
    // Load skin if changed
    if (state.skinId && state.skinId !== (SKIN?.id ?? 'standard')) {
      loadSkinAssets(state.skinId);
    }
    // Phone-host mode: never show game-screen, just update the host panel
    if (_phoneHostMode) {
      render(); // calls renderPhoneHost()
      return;
    }

    const gs = document.getElementById('game-screen');
    const wasHidden = !gs.classList.contains('active');
    if (wasHidden) {
      showScreen('game-screen');
      renderPINBadge();
    }

    // Resize canvas ONLY if dimensions changed or canvas is empty
    const needsResize = canvas.width !== window.innerWidth || canvas.height !== window.innerHeight
                        || canvas.width === 0 || canvas.height === 0;
    if (needsResize) {
      canvas.width  = window.innerWidth  || 1280;
      canvas.height = window.innerHeight || 720;
    }

    if (wasHidden || canvas.width === 0) {
      // Screen just became visible — wait one frame for layout before drawing
      requestAnimationFrame(() => {
        canvas.width  = window.innerWidth  || 1280;
        canvas.height = window.innerHeight || 720;
        render();
        if (isFreshRoll) handleDiceRollAnimation(state, prevDiceRolled);
      });
    } else {
      render();
      if (isFreshRoll) handleDiceRollAnimation(state, prevDiceRolled);
    }
    return;
  }
  // state is null — game not started yet
  // If we're a web player waiting for the game, stay on waiting-screen
  if (WEB_PLAYER_ID !== null && document.getElementById('waiting-screen')?.classList.contains('active')) return;
  render();
}

// ===================================================================
//  SETUP SCREEN
// ===================================================================
let playerCount = 3;

function initSetupScreen(skipRoom) {
  document.querySelectorAll('.count-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      playerCount = +btn.dataset.count;
      // Reset colors to defaults when changing player count
      playerColors = [...CATAN_COLORS];
      document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPlayerConfigs();
    })
  );

  document.querySelectorAll('.scale-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      if (_isMobile) return; // mobile: always use ui-xlarge
      uiScale = parseFloat(btn.dataset.scale);
      document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.body.classList.remove('ui-large','ui-xlarge');
      if      (uiScale >= 2)   document.body.classList.add('ui-xlarge');
      else if (uiScale >= 1.7) document.body.classList.add('ui-large');
    })
  );

  renderPlayerConfigs();
  document.querySelectorAll('.desert-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      desertCenter = btn.dataset.desert === 'center';
      document.querySelectorAll('.desert-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );

  // Zero resources rule toggle
  document.getElementById('btn-zero-res')?.addEventListener('click', () => {
    zeroResources = !zeroResources;
    document.getElementById('btn-zero-res').classList.toggle('active', zeroResources);
    if (zeroResources) showRuleToast('rule_desc_zero_res');
  });

  // Random ports toggle
  document.getElementById('btn-random-ports')?.addEventListener('click', () => {
    randomPorts = !randomPorts;
    document.getElementById('btn-random-ports').classList.toggle('active', randomPorts);
    if (randomPorts) showRuleToast('rule_desc_random_ports');
  });
  // Random numbers toggle
  document.getElementById('btn-random-numbers')?.addEventListener('click', () => {
    randomNumbers = !randomNumbers;
    document.getElementById('btn-random-numbers').classList.toggle('active', randomNumbers);
    if (randomNumbers) showRuleToast('rule_desc_random_nums');
  });
  document.getElementById('btn-quick-game')?.addEventListener('click', () => {
    quickGame = !quickGame;
    document.getElementById('btn-quick-game').classList.toggle('active', quickGame);
    if (quickGame) showRuleToast('rule_desc_quick');
  });
  document.getElementById('btn-unlimited-dev')?.addEventListener('click', () => {
    unlimitedDev = !unlimitedDev;
    document.getElementById('btn-unlimited-dev').classList.toggle('active', unlimitedDev);
    if (unlimitedDev) showRuleToast('rule_desc_unlimited');
  });
  document.getElementById('btn-instant-dev')?.addEventListener('click', () => {
    instantDev = !instantDev;
    document.getElementById('btn-instant-dev').classList.toggle('active', instantDev);
    if (instantDev) showRuleToast('rule_desc_instant');
  });

  document.getElementById('btn-hidden-res')?.addEventListener('click', () => {
    hiddenResources = !hiddenResources;
    document.getElementById('btn-hidden-res').classList.toggle('active', hiddenResources);
    if (hiddenResources) showRuleToast('rule_desc_hidden_res');
  });

  document.getElementById('btn-balanced-res')?.addEventListener('click', () => {
    balancedResources = !balancedResources;
    document.getElementById('btn-balanced-res').classList.toggle('active', balancedResources);
    if (balancedResources) showRuleToast('rule_desc_balanced_res');
  });

  document.getElementById('btn-cities-knights')?.addEventListener('click', () => {
    citiesKnights = !citiesKnights;
    document.getElementById('btn-cities-knights').classList.toggle('active', citiesKnights);
    if (citiesKnights) showRuleToast('rule_desc_cities_knights');
  });

  // Debug mode: show dev card selector if ?debug=1 in URL
  if (_urlParams.get('debug') === '1') {
    document.getElementById('debug-dev-section')?.style && (document.getElementById('debug-dev-section').style.display='block');
  };

  document.querySelectorAll('.lang-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      setLang(btn.dataset.lang);
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTranslations();
      renderPlayerConfigs();
      renderSkins(); // re-filter skins by new language
    })
  );

  applyTranslations();
  document.getElementById('start-btn')?.addEventListener('click', startGame);

  // Join existing room by PIN
  document.getElementById('btn-join-pin')?.addEventListener('click', joinExistingRoom);
  document.getElementById('join-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinExistingRoom();
    // Only allow digits
    if (!/[0-9]/.test(e.key) && !['Backspace','Tab','ArrowLeft','ArrowRight','Delete'].includes(e.key)) {
      e.preventDefault();
    }
  });

  // Create room immediately so QR can be shown before starting
  if (!skipRoom) initRoom();
}

async function joinExistingRoom() {
  const input = document.getElementById('join-pin-input');
  const errEl = document.getElementById('join-pin-error');
  const pin   = input.value.trim();
  errEl.classList.add('hidden');

  if (pin.length !== 5 || !/^\d{5}$/.test(pin)) {
    errEl.textContent = 'Il PIN deve essere di 5 cifre';
    errEl.classList.remove('hidden');
    return;
  }

  // Try to connect to existing room
  try {
    // Test if room exists via validate-token endpoint with fake token
    // Instead: just connect via WS and send JOIN_ROOM equivalent
    // We update currentPin and reconnect
    const btn = document.getElementById('btn-join-pin');
    btn.disabled = true;
    btn.textContent = '…';

    // Close current WS, set new pin, reconnect
    if (ws) { ws.onclose = null; ws.close(); }
    currentPin = pin;

    connectWS();

    // Wait for connection then check if room exists
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        if (ws.readyState === WebSocket.OPEN) resolve();
        else if (++attempts > 30) reject(new Error('timeout'));
        else setTimeout(check, 100);
      };
      check();
    });

    // Listen for first state message to confirm room exists
    const confirmed = await new Promise((resolve) => {
      const handler = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'STATE_UPDATE') {
          ws.removeEventListener('message', handler);
          resolve(msg.state !== null);
        }
      };
      ws.addEventListener('message', handler);
      setTimeout(() => { ws.removeEventListener('message', handler); resolve(false); }, 2000);
    });

    btn.disabled = false;
    btn.textContent = '→ Entra';

    if (confirmed) {
      // Room exists — switch to game screen and render board
      document.getElementById('setup-pin')?.remove();
      renderPINBadge();
      history.replaceState({}, '', `?pin=${currentPin}`);
      showScreen('game-screen');
      // Use double rAF to ensure layout is complete before sizing canvas
      requestAnimationFrame(() => requestAnimationFrame(() => {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        if (state) { calcBoardTransform(); renderBoard(); render(); }
      }));
    } else {
      errEl.textContent = t('join_error_not_found');
      errEl.classList.remove('hidden');
      // Revert to own room
      currentPin = null;
      initRoom();
    }
  } catch(e) {
    document.getElementById('btn-join-pin').disabled = false;
    document.getElementById('btn-join-pin').textContent = '→ Entra';
    errEl.textContent = t('join_error_conn') + e.message;
    errEl.classList.remove('hidden');
  }
}

async function initRoom() {
  try {
    const res  = await fetch('/api/create-room', { method:'POST' });
    const data = await res.json();
    currentPin = data.pin;
    // Reconnect WS with pin so we're in the room
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      ws.onclose = null; // prevent auto-reconnect loop
      ws.close();
    }
    connectWS();
    // Show PIN in setup
    renderSetupPIN();
  } catch(e) {
    console.warn('Room creation failed, retrying…', e);
    setTimeout(initRoom, 2000);
  }
}

function renderSetupPIN() {
  let el = document.getElementById('setup-pin');
  if (!el) {
    el = document.createElement('div');
    el.id = 'setup-pin';
    el.className = 'setup-pin-display';
    // Insert before start button
    const btn = document.getElementById('start-btn');
    btn.parentNode.insertBefore(el, btn);
  }
  el.innerHTML = `<span class="setup-pin-label">${t('pin_game')}</span> <strong class="setup-pin-num">${currentPin}</strong> <span class="setup-pin-hint">${t('pin_hint')}</span>`;
}

function renderPlayerConfigs() {
  const c = document.getElementById('player-configs');
  // Save current names before clearing
  const savedNames = Array.from({length: playerCount}, (_, i) => {
    const el = document.getElementById(`pname-${i}`);
    return el ? el.value : t('player_n', i + 1);
  });

  c.innerHTML = '';

  for (let i = 0; i < playerCount; i++) {
    const defaultName = savedNames[i] || t('player_n', i + 1);
    const row = document.createElement('div');
    row.className = 'player-config-row';

    // Build 4 color swatches — always all clickable, clicking a taken one swaps
    const swatchesHtml = CATAN_COLORS.map(col => {
      const isSelected = playerColors[i] === col;
      const isTakenByOther = playerColors.some((c, pi) => c === col && pi !== i);
      return `<button class="catan-color-swatch ${isSelected ? 'selected' : ''} ${isTakenByOther ? 'taken-other' : ''}"
               style="background:${col}"
               onclick="selectPlayerColor(${i},'${col}')"></button>`;
    }).join('');

    row.innerHTML = `
      <label>${t('player_n', i + 1)}</label>
      <input type="text" id="pname-${i}" placeholder="${t('name_placeholder')}" value="${escHtml(defaultName)}">
      <div class="catan-color-row">${swatchesHtml}</div>
      <button class="qr-btn" onclick="showQRForPlayer(${i})" title="Accoppia telefono">📱</button>`;
    c.appendChild(row);
  }
}

window.selectPlayerColor = (playerIdx, color) => {
  // If another player already has this color, swap
  const otherIdx = playerColors.findIndex((c, pi) => c === color && pi !== playerIdx);
  if (otherIdx !== -1) {
    // Give the other player the color we're freeing up
    playerColors[otherIdx] = playerColors[playerIdx];
  }
  playerColors[playerIdx] = color;
  renderPlayerConfigs();
};

function startGame() {
  if (!currentPin) { alert('PIN non disponibile. Ricarica la pagina.'); return; }
  const players = Array.from({length: playerCount}, (_,i) => ({
    name:  document.getElementById(`pname-${i}`).value.trim() || t('player_n', i+1),
    color: playerColors[i] || CATAN_COLORS[i]
  }));
  showScreen('game-screen');
  renderPINBadge();
  // Push PIN to URL so F5 rejoins same game
  history.replaceState({}, '', `?pin=${currentPin}`);
  requestAnimationFrame(() => {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    send({ type: 'START_GAME', players, desertCenter, zeroResources, randomPorts, randomNumbers, quickGame, unlimitedDev, instantDev, hiddenResources, balancedResources, citiesKnights, skinId: selectedSkinId, debugDevCard, debugResources, debugForceDice, debugSkipSetup });
  });
}

function renderPINBadge() {
  let b = document.getElementById('pin-badge');
  if (!b) { b = document.createElement('div'); b.id='pin-badge'; b.className='pin-badge'; document.getElementById('hud-top').appendChild(b); }
  const isSpectator = location.pathname.includes('spectator') || window.__SPECTATOR_MODE;
  if (isSpectator) {
    // Show PIN + QR icon that generates a join QR for the admin page
    b.innerHTML = `PIN: <strong>${currentPin}</strong>
      <button onclick="showSpectatorQR()" style="background:none;border:none;cursor:pointer;font-size:1.1rem;padding:0 4px" title="Show QR">📱</button>`;
  } else {
    const spectatorUrl = `${location.origin}/spectator?pin=${currentPin}&lang=${LANG}`;
    b.innerHTML = `PIN: <strong>${currentPin}</strong>
      <a class="spectator-link" href="${spectatorUrl}" target="_blank" title="Open TV projection">📺</a>`;
  }
}

// ===================================================================
//  SPECTATOR QR
// ===================================================================

// ===================================================================
//  PHONE HOST MODE
// ===================================================================

let _phoneHostMode = sessionStorage.getItem('phoneHostMode') === '1';

window.startPhoneHost = function() {
  if (!currentPin) { alert('PIN non disponibile. Ricarica la pagina.'); return; }
  _phoneHostMode = true;
  sessionStorage.setItem('phoneHostMode', '1');
  const players = Array.from({length: playerCount}, (_,i) => ({
    name:  document.getElementById(`pname-${i}`)?.value?.trim() || t('player_n', i+1),
    color: playerColors[i] || CATAN_COLORS[i]
  }));
  showScreen('phone-host-screen');
  document.getElementById('ph-pin-value').textContent = currentPin;
  history.replaceState({}, '', `?pin=${currentPin}`);
  send({ type: 'START_GAME', players, desertCenter, zeroResources, randomPorts, randomNumbers, quickGame, unlimitedDev, instantDev, hiddenResources, citiesKnights,
         skinId: selectedSkinId, debugDevCard, debugResources, debugForceDice, debugSkipSetup });
};

window.phReset = function() {
  _phoneHostMode = false;
  sessionStorage.removeItem('phoneHostMode');
  if (ws) { ws.onclose = null; ws.close(); }
  currentPin = null;
  history.replaceState({}, '', '/');
  location.reload();
};

function renderPhoneHost() {
  if (!state || !_phoneHostMode) return;

  // Phase label
  const phaseEl = document.getElementById('ph-phase');
  if (phaseEl) {
    const cur = state.players[state.currentPlayerIndex];
    let phaseText = '';
    if (state.winner !== null) {
      phaseText = `🏆 ${state.players[state.winner].name} ha vinto!`;
    } else if (state.phase === 'setup1' || state.phase === 'setup2') {
      phaseText = state.waitingForRoad
        ? `${cur?.name} — ${skinLabel('road', t('phase_place_road') || 'Piazza una strada')}`
        : `${cur?.name} — ${skinLabel('settlement', t('phase_place_sett') || 'Piazza un villaggio')}`;
    } else if (!state.diceRolled) {
      phaseText = `${cur?.name} — ${t('phase_rolling') || 'Lancia i dadi'}`;
    } else if (state.pendingRobber) {
      phaseText = `${cur?.name} — ${skinLabel('robber', t('phase_robber') || 'Muovi il bandito')}`;
    } else if (state.pendingDiscard?.length) {
      phaseText = `⚠️ ${t('phase_discard') || 'Scarta risorse'}`;
    } else {
      phaseText = `${cur?.name} — ${t('phase_building') || 'Costruisci / Commercia'}`;
    }
    phaseEl.textContent = phaseText;
  }

  // Player cards
  const container = document.getElementById('ph-players');
  if (!container) return;
  container.innerHTML = '';
  const cur = state.currentPlayerIndex;

  state.players.forEach(p => {
    const webUrl = `${location.origin}/?pin=${currentPin}&token=${p.token||''}`;
    const isActive = p.id === cur && state.winner === null;
    const pts = p.points || 0;

    const card = document.createElement('div');
    card.className = 'ph-player-card' + (isActive ? ' active' : '');
    card.style.borderColor = isActive ? p.color : '';
    card.style.color = p.color;

    card.innerHTML = `
      <div class="ph-player-dot" style="background:${p.color}"></div>
      <div class="ph-player-name" style="color:${p.color}">${escHtml(p.name)}</div>
      <div class="ph-player-status">⭐ ${pts}</div>
      <div class="ph-player-btns">
        <button class="ph-qr-btn" onclick="phShowQR(${p.id})">QR</button>
        <button class="ph-link-btn" onclick="phOpenLink(${p.id})">🔗</button>
        <button class="ph-play-btn" onclick="phPlayAs(${p.id})">▶</button>
      </div>`;
    container.appendChild(card);
  });

  // Winner
  if (state.winner !== null) {
    const statusEl = document.getElementById('ph-status');
    if (statusEl) statusEl.textContent = `🏆 ${state.players[state.winner].name} ha vinto con ${state.players[state.winner].points} punti!`;
  }
}

window.phOpenLink = async function(playerId) {
  const p = state?.players?.[playerId];
  const btn = document.querySelector(`.ph-player-card:nth-child(${playerId+1}) .ph-link-btn`) ||
              [...document.querySelectorAll('.ph-link-btn')][playerId];
  try {
    const r = await fetch('/api/generate-mobile-qr', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pin: currentPin, playerIndex: playerId, playerName: p?.name, lang: LANG })
    });
    const d = await r.json();
    const url = d.mobileUrl;
    if (navigator.share) {
      await navigator.share({ title: `SuperCatan — ${p?.name||''}`, url });
    } else {
      await navigator.clipboard.writeText(url);
      if (btn) { const orig = btn.textContent; btn.textContent = '✅'; setTimeout(()=>btn.textContent=orig, 2000); }
    }
  } catch(e) {
    if (e.name !== 'AbortError') alert('Errore: ' + e.message);
  }
};

window.phPlayAs = async function(playerId) {
  const p = state?.players?.[playerId];
  try {
    const r = await fetch('/api/generate-mobile-qr', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pin: currentPin, playerIndex: playerId, playerName: p?.name, lang: LANG })
    });
    const d = await r.json();
    window.location.href = d.mobileUrl;
  } catch(e) { alert('Errore: ' + e.message); }
};

async function phShowQR(playerId) {
  const p = state?.players?.[playerId];
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:500;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:#0e1420;border:2px solid rgba(200,164,74,.4);border-radius:16px;padding:24px;text-align:center;max-width:300px;width:90%">
      <div style="color:${p?.color||'#f0c040'};font-size:1.1rem;font-weight:bold;margin-bottom:12px">${escHtml(p?.name||'')}</div>
      <img id="ph-qr-img-${playerId}" style="width:200px;height:200px;border-radius:8px" src="" alt="QR">
      <div id="ph-qr-link-${playerId}" style="color:#8a7a60;font-size:.75rem;margin-top:8px">Generazione QR...</div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="display:block;width:100%;margin-top:14px;padding:10px;background:rgba(200,164,74,.2);border:1.5px solid #c8a44a;border-radius:8px;color:#f0c040;cursor:pointer;font-size:.9rem">Chiudi</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Generate proper mobile QR with token (like normal player QR)
  try {
    const r = await fetch('/api/generate-mobile-qr', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pin: currentPin, playerIndex: playerId,
                             playerName: p?.name, lang: LANG })
    });
    const d = await r.json();
    const img = document.getElementById(`ph-qr-img-${playerId}`);
    const lnk = document.getElementById(`ph-qr-link-${playerId}`);
    if (img) img.src = d.qrDataUrl;
    if (lnk) lnk.innerHTML = `<button onclick="(async()=>{try{if(navigator.share){await navigator.share({title:'SuperCatan',url:'${d.mobileUrl}'})}else{await navigator.clipboard.writeText('${d.mobileUrl}');this.textContent='✅ Copiato!';setTimeout(()=>this.textContent='📋 Copia link',2000)}}catch(e){if(e.name!=='AbortError')alert(e.message)}})()" style="margin-top:8px;padding:6px 14px;background:rgba(200,164,74,.2);border:1.5px solid #c8a44a;border-radius:8px;color:#f0c040;cursor:pointer;font-size:.85rem">📋 Copia link</button>`;
  } catch(e) {
    const lnk = document.getElementById(`ph-qr-link-${playerId}`);
    if (lnk) lnk.textContent = 'Errore QR: ' + e.message;
  }
}

// ===================================================================
//  DRAWER SYSTEM
// ===================================================================
const drawerState = { players: false, actions: false, log: false };

function toggleDrawer(name) {
  const wasOpen = drawerState[name];
  // close all
  Object.keys(drawerState).forEach(k => {
    drawerState[k] = false;
    const el  = document.getElementById(`drawer-${k}`);
    const tab = document.getElementById(`tab-${k}`);
    if (el)  el.classList.remove('open');
    if (tab) tab.classList.remove('open');
  });
  // open requested if it was closed
  if (!wasOpen) {
    drawerState[name] = true;
    const el  = document.getElementById(`drawer-${name}`);
    const tab = document.getElementById(`tab-${name}`);
    if (el)  el.classList.add('open');
    if (tab) tab.classList.add('open');
  }
  // redraw board so HEX_SIZE respects open panel width
  if (state) { calcBoardTransform(); renderBoard(); }
}

// close drawers on canvas tap (so they don't block the board)
function closeDrawers() {
  Object.keys(drawerState).forEach(k => {
    drawerState[k] = false;
    document.getElementById(`drawer-${k}`)?.classList.remove('open');
    document.getElementById(`tab-${k}`)?.classList.remove('open');
  });
}

// ===================================================================
//  CANVAS BOARD RENDERER
// ===================================================================
const canvas = document.getElementById('board-canvas');
const ctx    = canvas.getContext('2d');
let HEX_SIZE, OFFSET_X, OFFSET_Y;

function resizeCanvas() {
  const w = window.innerWidth, h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  if (state) { calcBoardTransform(); renderBoard(); }
}
window.addEventListener('resize', resizeCanvas);

function getDrawerInsets() {
  // Returns how many pixels each side is currently occupied by open drawers
  // We read the CSS variable values at runtime
  const style  = getComputedStyle(document.body);
  const tabW   = parseInt(style.getPropertyValue('--tab-w'))   || 44;
  const leftW  = parseInt(style.getPropertyValue('--drawer-left-w'))  || 250;
  const rightW = parseInt(style.getPropertyValue('--drawer-right-w')) || 230;
  const botH   = parseInt(style.getPropertyValue('--drawer-bottom-h'))|| 150;
  const hudH = parseInt(style.getPropertyValue('--hud-h')) || 72;
  if (window.__SPECTATOR_MODE) {
    return { left: leftW, right: 0, top: hudH, bottom: 0 };
  }
  return {
    left:   drawerState.players ? leftW + tabW : tabW,
    right:  drawerState.actions ? rightW + tabW : tabW,
    top:    hudH,
    bottom: drawerState.log ? botH + tabW : tabW
  };
}

function calcBoardTransform() {
  if (!state) return;
  if (!canvas.width || !canvas.height) {
    canvas.width  = window.innerWidth  || 1280;
    canvas.height = window.innerHeight || 720;
  }

  const hexes = state.board.hexes;
  const CXS = hexes.map(h => h.cx), CYS = hexes.map(h => h.cy);
  const minCX = Math.min(...CXS), maxCX = Math.max(...CXS);
  const minCY = Math.min(...CYS), maxCY = Math.max(...CYS);
  const boardW = (maxCX - minCX) + 2.2;
  const boardH = (maxCY - minCY) + 1.8;

  const ins     = getDrawerInsets();
  const padTop  = 32; // extra top padding so ports/roads don't clip under HUD
  const availW  = canvas.width  - ins.left - ins.right  - 20;
  const availH  = canvas.height - ins.top  - ins.bottom - padTop - 20;

  HEX_SIZE = Math.min(availW / boardW, availH / boardH) * 0.92;

  // Center the board in the available area
  const centerX = ins.left + availW / 2;
  const centerY = ins.top  + padTop + availH / 2;
  OFFSET_X = centerX - ((minCX + maxCX) / 2) * HEX_SIZE;
  OFFSET_Y = centerY - ((minCY + maxCY) / 2) * HEX_SIZE;
}

function px(x) { return x * HEX_SIZE + OFFSET_X; }
function py(y) { return y * HEX_SIZE + OFFSET_Y; }

// ── Rendering ──────────────────────────────────────────────────────

function renderBoard() {
  if (!state?.board) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Sea background
  const sg = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 60, canvas.width/2, canvas.height/2, canvas.width*.7);
  sg.addColorStop(0, '#1a3a6a'); sg.addColorStop(1, '#0a1a2a');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Sea border hexagon (like the original box)
  drawSeaHexagon();
  drawHexes(); drawEdges(); drawVertices(); drawPorts(); drawRobber(); drawKnights();
  updateBoardCursor();
}

function updateBoardCursor() {
  if (!state || !canvas) return;
  const isSetup = state.phase==='setup1'||state.phase==='setup2';
  const isMain  = state.phase==='main';

  // In web-player mode only show cursor hints when it's my turn
  if (state.pendingRobber || state.pendingKnightDisplace || state.pendingBarbarianChoices?.length > 0 || state.pendingMetropolisChoice) {
    canvas.style.cursor = 'crosshair';
  } else if (isSetup && state.waitingForRoad && buildMode==='road') {
    canvas.style.cursor = 'cell';
  } else if (isSetup && !state.waitingForRoad && buildMode==='settlement') {
    canvas.style.cursor = 'cell';
  } else if (!isSetup && (buildMode==='settlement' || buildMode==='city' || buildMode==='knight')) {
    canvas.style.cursor = 'cell';
  } else if (!isSetup && (buildMode==='road' || buildMode==='knight_move_target' || buildMode==='knight_displace_target')) {
    canvas.style.cursor = 'cell';
  } else if (!isSetup && buildMode==='knight_chase_target') {
    canvas.style.cursor = 'crosshair';
  } else {
    canvas.style.cursor = 'default';
  }
}

function drawSeaHexagon() {
  if (!state?.board) return;
  // One big flat-top hexagon that frames the whole board, filled with a light sea color
  const hexes = state.board.hexes;
  const boardCx = hexes.reduce((s,h)=>s+px(h.cx),0)/hexes.length;
  const boardCy = hexes.reduce((s,h)=>s+py(h.cy),0)/hexes.length;
  // Radius = distance from center to farthest hex center + 1.6 hex sizes
  const R = Math.max(...hexes.map(h=>Math.hypot(px(h.cx)-boardCx, py(h.cy)-boardCy))) + HEX_SIZE*1.75;

  ctx.beginPath();
  for (let i=0; i<6; i++) {
    const a = Math.PI/3*i - Math.PI/6;
    const vx = boardCx + R*Math.cos(a);
    const vy = boardCy + R*Math.sin(a);
    i===0 ? ctx.moveTo(vx,vy) : ctx.lineTo(vx,vy);
  }
  ctx.closePath();

  // Fill: soft light-blue sea color like the original
  const seaFill = ctx.createRadialGradient(boardCx, boardCy, R*.1, boardCx, boardCy, R);
  seaFill.addColorStop(0, 'rgba(60,120,200,.35)');
  seaFill.addColorStop(1, 'rgba(30,70,140,.55)');
  ctx.fillStyle = seaFill;
  ctx.fill();

  // Stroke: slightly brighter border
  ctx.strokeStyle = 'rgba(100,160,240,.45)';
  ctx.lineWidth   = HEX_SIZE * .18;
  ctx.stroke();
}

function hexPath(hex) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI/3*i - Math.PI/6;
    const vx = px(hex.cx) + HEX_SIZE*.96*Math.cos(a);
    const vy = py(hex.cy) + HEX_SIZE*.96*Math.sin(a);
    i===0 ? ctx.moveTo(vx,vy) : ctx.lineTo(vx,vy);
  }
  ctx.closePath();
}

function drawHexes() {
  for (const hex of state.board.hexes) {
    hexPath(hex);
    const col = RES_COLORS[hex.resource] || '#888';
    const skinImg = SKIN?.hexImages?.[hex.resource];
    const isRobberHex = hex.id===state.robberHexId;

    if (skinImg) {
      // ── Skin texture ──
      ctx.save();
      ctx.beginPath(); hexPath(hex); ctx.clip();
      const cx = px(hex.cx), cy = py(hex.cy);
      const sw = HEX_SIZE * 2.05, sh = HEX_SIZE * 2.35;
      ctx.drawImage(skinImg, cx - sw/2, cy - sh/2, sw, sh);
      ctx.restore();
      // Robber tint
      if (isRobberHex) {
        ctx.beginPath(); hexPath(hex);
        ctx.fillStyle='rgba(220,0,0,.22)'; ctx.fill();
      }
    } else {
      // ── Fallback flat color with gradient ──
      const g = ctx.createRadialGradient(px(hex.cx),py(hex.cy),0,px(hex.cx),py(hex.cy),HEX_SIZE);
      g.addColorStop(0, lighten(col,40)); g.addColorStop(1, col);
      ctx.fillStyle = g; ctx.fill();
    }
    ctx.strokeStyle = isRobberHex ? '#ff4444' : '#0a1a2a55';
    ctx.lineWidth   = isRobberHex ? 3 : 1.5;
    ctx.stroke();

    // Emoji only when no skin texture
    if (!skinImg) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (window.__TV_MODE) {
        drawTVResIcon(ctx, hex.resource, px(hex.cx), py(hex.cy) - HEX_SIZE*.26, HEX_SIZE*.38);
      } else {
        ctx.font = `${HEX_SIZE*.48}px serif`;
        ctx.fillText(resEmoji(hex.resource)||'?', px(hex.cx), py(hex.cy) - HEX_SIZE*.26);
      }
    }

    // number token — size by probability
    if (hex.number) {
      const isRed    = hex.number===6 || hex.number===8;
      const isBig    = hex.number===5 || hex.number===9;
      const isSmall  = hex.number===2 || hex.number===12;
      const tr = isRed   ? HEX_SIZE*.28
               : isBig   ? HEX_SIZE*.26
               : isSmall ? HEX_SIZE*.21
               :            HEX_SIZE*.24;
      const fs = isRed   ? HEX_SIZE*.24
               : isBig   ? HEX_SIZE*.21
               : isSmall ? HEX_SIZE*.16
               :            HEX_SIZE*.19;
      const ty = py(hex.cy) + HEX_SIZE*.28;
      ctx.beginPath(); ctx.arc(px(hex.cx), ty, tr, 0, Math.PI*2);
      ctx.fillStyle = isRed ? '#ffe8e8' : '#fffff0'; ctx.fill();
      ctx.strokeStyle = isRed ? '#cc2200' : '#5a4a2a';
      ctx.lineWidth = isRed ? 2 : 1.5; ctx.stroke();

      ctx.fillStyle = isRed ? '#cc2200' : '#1a1200';
      ctx.font = `bold ${fs}px serif`;
      ctx.fillText(hex.number, px(hex.cx), ty);

      // dots
      const dots = {2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1}[hex.number]||0;
      const dotR = isRed ? HEX_SIZE*.030 : HEX_SIZE*.024;
      for (let d=0;d<dots;d++) {
        const dx = (d-(dots-1)/2)*HEX_SIZE*.055;
        ctx.beginPath(); ctx.arc(px(hex.cx)+dx, ty+tr*.85, dotR, 0, Math.PI*2);
        ctx.fillStyle = isRed ? '#cc2200' : '#1a1200'; ctx.fill();
      }
    }
  }
}

function drawPorts() {
  if (!state.board.ports) return;

  // Board center in canvas coords (used to compute outward push direction)
  const hexes = state.board.hexes;
  const boardCx = hexes.reduce((s,h)=>s+px(h.cx),0) / hexes.length;
  const boardCy = hexes.reduce((s,h)=>s+py(h.cy),0) / hexes.length;

  for (const port of state.board.ports) {
    if (!port.vertices?.length) continue;
    const vids = port.vertices;
    const v0 = state.board.vertices[vids[0]];
    const v1 = vids.length > 1 ? state.board.vertices[vids[1]] : v0;
    if (!v0 || !v1) continue;

    // Midpoint of the port edge in canvas coords
    const mx = (px(v0.x) + px(v1.x)) / 2;
    const my = (py(v0.y) + py(v1.y)) / 2;

    // Push badge outward from board center
    const dx = mx - boardCx, dy = my - boardCy;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    const push = HEX_SIZE * 0.72;   // enough to sit clearly outside the hex ring
    const bx = mx + (dx/len) * push;
    const by = my + (dy/len) * push;

    const isGeneric = port.type === 'any';
    // Generic port → grey/blue; specific → resource color
    const resCol    = RES_COLORS[port.type] || '#888';
    const colLine   = isGeneric ? 'rgba(160,180,200,.75)' : resCol;
    const colFill   = isGeneric ? 'rgba(60,80,110,.96)'   : darken(resCol, 50);
    const colStroke = isGeneric ? '#a0b4c8'                : lighten(resCol, 50);

    // Line from badge center to each port vertex
    for (const vid of vids) {
      const v = state.board.vertices[vid]; if (!v) continue;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(px(v.x), py(v.y));
      ctx.strokeStyle = colLine;
      ctx.lineWidth = HEX_SIZE * .07;
      ctx.setLineDash([HEX_SIZE*.07, HEX_SIZE*.05]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Badge — larger than before
    const r = HEX_SIZE * .30;

    // Outer glow
    ctx.beginPath(); ctx.arc(bx, by, r+5, 0, Math.PI*2);
    ctx.strokeStyle = colLine.replace('.7',',.25'); ctx.lineWidth = 8; ctx.stroke();

    // Fill
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI*2);
    ctx.fillStyle = colFill; ctx.fill();
    ctx.strokeStyle = colStroke; ctx.lineWidth = 2.5; ctx.stroke();

    // Resource emoji — top portion of badge
    ctx.font = `${HEX_SIZE * .23}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isGeneric ? '🌀' : resEmoji(port.type), bx, by - r * .25);

    // Ratio text — bottom portion
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${HEX_SIZE * .20}px sans-serif`;
    ctx.fillText(`${port.ratio}:1`, bx, by + r * .52);
  }
}

function drawEdges() {
  for (const edge of state.board.edges) {
    const v1=state.board.vertices[edge.v1], v2=state.board.vertices[edge.v2];
    if (!v1||!v2) continue;
    const x1=px(v1.x),y1=py(v1.y),x2=px(v2.x),y2=py(v2.y);
    if (edge.owner!==null) {
      const col = state.players[edge.owner].color;
      const rImg = skinRoadImg(col);
      if (rImg) {
        const cx=(x1+x2)/2, cy=(y1+y2)/2;
        const angle=Math.atan2(y2-y1, x2-x1)+Math.PI/2;
        const len=Math.hypot(x2-x1,y2-y1)*1.15;
        const thick=HEX_SIZE*1.0;
        ctx.save();
        ctx.translate(cx,cy); ctx.rotate(angle);
        ctx.drawImage(rImg, -thick/2, -len/2, thick, len);
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
        ctx.strokeStyle=col; ctx.lineWidth=HEX_SIZE*.14; ctx.lineCap='round'; ctx.stroke();
        ctx.strokeStyle=lighten(col,60); ctx.lineWidth=HEX_SIZE*.05; ctx.stroke();
      }
    } else if (buildMode==='road' && isValidRoad(edge.id)) {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
      ctx.strokeStyle='rgba(255,220,50,.75)'; ctx.lineWidth=HEX_SIZE*.10;
      ctx.setLineDash([HEX_SIZE*.08,HEX_SIZE*.04]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function drawVertices() {
  const barbCandidates = state.pendingBarbarianChoices?.length > 0 ? state.pendingBarbarianChoices[0].options : [];
  const metroCandidates = state.pendingMetropolisChoice ? state.pendingMetropolisChoice.options : [];
  for (const v of state.board.vertices) {
    const x=px(v.x),y=py(v.y);
    const hlSett = buildMode==='settlement' && isValidSettlement(v.id);
    const hlCity = buildMode==='city'       && isValidCity(v.id);
    const hlKnight = buildMode==='knight'   && isValidKnightSpot(v.id);
    const hlBarbarian = barbCandidates.includes(v.id);
    const hlMetropolis = metroCandidates.includes(v.id);
    if (v.building) {
      const col = state.players[v.owner].color;
      // Draw city upgrade highlight OVER the settlement if in city mode
      if (hlCity) {
        // Pulsing ring around the settlement to indicate it's upgradeable
        ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.28, 0, Math.PI*2);
        ctx.strokeStyle='rgba(255,220,50,.9)'; ctx.lineWidth=HEX_SIZE*.08; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.28, 0, Math.PI*2);
        ctx.fillStyle='rgba(255,220,50,.18)'; ctx.fill();
      }
      if (hlBarbarian) {
        // Red warning ring: this city is a candidate to be lost to barbarians
        ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.30, 0, Math.PI*2);
        ctx.strokeStyle='rgba(220,60,60,.95)'; ctx.lineWidth=HEX_SIZE*.09; ctx.stroke();
      }
      if (hlMetropolis) {
        // Gold ring: this city is a candidate to become the metropolis
        ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.30, 0, Math.PI*2);
        ctx.strokeStyle='rgba(200,164,74,.95)'; ctx.lineWidth=HEX_SIZE*.09; ctx.stroke();
      }
      const bImg = skinBuildingImg(v.building, col);
      if (bImg) {
        const bs = v.building==='city' ? HEX_SIZE*1.05 : HEX_SIZE*0.85;
        ctx.drawImage(bImg, x-bs/2, y-bs*0.4, bs, bs);
      } else {
        v.building==='settlement' ? drawSettlement(x,y,col,HEX_SIZE) : drawCity(x,y,col,HEX_SIZE);
      }
    } else if (hlSett) {
      ctx.beginPath(); ctx.arc(x,y,HEX_SIZE*.15,0,Math.PI*2);
      ctx.fillStyle='rgba(255,220,50,.88)'; ctx.fill();
      ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
    } else if (hlKnight) {
      ctx.beginPath(); ctx.arc(x,y,HEX_SIZE*.16,0,Math.PI*2);
      ctx.fillStyle='rgba(200,164,74,.85)'; ctx.fill();
      ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
    }
  }
}

function drawSettlement(x,y,color,sz) {
  const s=sz*.22; ctx.save(); ctx.translate(x,y-s*.3);
  ctx.beginPath(); ctx.rect(-s,0,s*2,s*1.3); ctx.fillStyle=color; ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s*1.2,0); ctx.lineTo(0,-s*1.2); ctx.lineTo(s*1.2,0); ctx.closePath();
  ctx.fillStyle=darken(color,30); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawCity(x,y,color,sz) {
  const s=sz*.22; ctx.save(); ctx.translate(x,y-s*.3);
  ctx.beginPath(); ctx.rect(-s*1.2,-s*.2,s*.9,s*1.5); ctx.fillStyle=color; ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.beginPath(); ctx.rect(0,0,s*1.2,s*1.3); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(s*.6,-s); ctx.lineTo(s*1.2,0); ctx.closePath();
  ctx.fillStyle=darken(color,30); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawRobber() {
  if (state.robberHexId===null) return;
  const h=state.board.hexes[state.robberHexId];
  const rx=px(h.cx), ry=py(h.cy)-HEX_SIZE*.28;
  const r=HEX_SIZE*.40;
  if (SKIN?.robberImage) {
    // Draw skin robber image
    const s = r * 2.1;
    ctx.drawImage(SKIN.robberImage, rx-s/2, ry-s/2, s, s);
  } else {
    // Fallback: antracite circle + emoji
    ctx.beginPath(); ctx.arc(rx, ry, r, 0, Math.PI*2);
    ctx.fillStyle='rgba(32,32,36,.95)'; ctx.fill();
    ctx.strokeStyle='rgba(180,180,190,.7)'; ctx.lineWidth=2.5; ctx.stroke();
    ctx.font=`${HEX_SIZE*.44}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('🦹', rx, ry);
  }
}

// ===================================================================
//  CITIES & KNIGHTS — knight pieces on the board
// ===================================================================
const KNIGHT_EMOJI = { basic: '🛡️', strong: '⚔️', mighty: '🐎' };

function drawKnights() {
  if (!state?.citiesKnights) return;

  // Highlight valid retreat spots when a displacement is awaiting a choice
  if (state.pendingKnightDisplace) {
    for (const vid of state.pendingKnightDisplace.options) {
      const v = state.board.vertices[vid];
      const x = px(v.x), y = py(v.y);
      ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.18, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba(255,220,50,.9)'; ctx.lineWidth = HEX_SIZE*.06; ctx.stroke();
    }
  }
  // Highlight valid targets while a move/displace action is being aimed
  if (buildMode==='knight_move_target' || buildMode==='knight_displace_target') {
    const fromVertex = state.board.vertices[knightActionFrom];
    if (fromVertex) {
      const rankVal = { basic:1, strong:2, mighty:3 };
      const myKnight = state.players[state.currentPlayerIndex]?.knights?.find(k=>k.vertexId===knightActionFrom);
      for (const eid of fromVertex.adjEdges) {
        const e = state.board.edges[eid];
        const otherId = e.v1===knightActionFrom ? e.v2 : e.v1;
        const other = state.board.vertices[otherId];
        let valid = false;
        if (buildMode==='knight_move_target') {
          valid = e.owner===state.currentPlayerIndex && other.owner===null && !state.players.some(p=>(p.knights||[]).some(k=>k.vertexId===otherId));
        } else if (myKnight) {
          const enemy = state.players.find(p => p.id!==state.currentPlayerIndex && (p.knights||[]).some(k=>k.vertexId===otherId));
          const enemyKnight = enemy?.knights.find(k=>k.vertexId===otherId);
          valid = e.owner!==null && !!enemyKnight && rankVal[myKnight.rank] > rankVal[enemyKnight.rank];
        }
        if (valid) {
          const x = px(other.x), y = py(other.y);
          ctx.beginPath(); ctx.arc(x, y, HEX_SIZE*.18, 0, Math.PI*2);
          ctx.strokeStyle = 'rgba(200,164,74,.9)'; ctx.lineWidth = HEX_SIZE*.06; ctx.stroke();
        }
      }
    }
  }

  for (const player of state.players) {
    for (const knight of (player.knights || [])) {
      const v = state.board.vertices[knight.vertexId];
      if (!v) continue;
      const x = px(v.x), y = py(v.y);
      const r = HEX_SIZE * .24;
      ctx.save();
      if (!knight.active) ctx.globalAlpha = .55;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
      ctx.fillStyle = player.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = `${r*1.3}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(KNIGHT_EMOJI[knight.rank] || '🛡️', x, y);
      ctx.restore();
    }
  }
}

// ===================================================================
//  MAIN RENDER
// ===================================================================
function render() {
  // Debug dev card banner
  if (state?.debugDevCard) {
    let dbg = document.getElementById('debug-dev-banner');
    if (!dbg) {
      dbg = document.createElement('div'); dbg.id='debug-dev-banner';
      dbg.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);background:#ff4400;color:#fff;font-size:.75rem;font-weight:bold;padding:3px 16px;border-radius:0 0 8px 8px;z-index:9999;pointer-events:none';
      document.body.appendChild(dbg);
    }
    const names={monopoly:skinLabel('monopoly','Monopolio'),knight:skinLabel('knight','Cavaliere'),roadBuilding:skinLabel('road_building','Strade'),yearOfPlenty:skinLabel('year_of_plenty','Abbondanza'),victoryPoint:'Punto Vittoria'};
    const parts = [];
    if (state.debugDevCard) parts.push('carta='+( names[state.debugDevCard]||state.debugDevCard));
    if (state.debugResources) parts.push(state.citiesKnights ? '10 risorse+commodity' : '10 risorse');
    if (state.debugSkipSetup) parts.push('setup saltato');
    if (state.debugForceDice) parts.push('dado='+state.debugForceDice);
    dbg.textContent = '🐛 DEBUG: ' + parts.join(' | ');
  } else { document.getElementById('debug-dev-banner')?.remove(); }
  // Update browser tab title
  if (state) {
    if (WEB_PLAYER_ID !== null) {
      const me = state.players[WEB_PLAYER_ID];
      if (me) document.title = 'Catan — ' + me.name;
    } else if (window.__SPECTATOR_MODE) {
      document.title = 'Catan — Spectator';
    } else if (currentPin) {
      document.title = 'Catan — Admin';
    }
  }
  if (_phoneHostMode) { renderPhoneHost(); return; }
  // Auto-open actions drawer during setup so buttons are immediately visible
  if (state && (state.phase==='setup1'||state.phase==='setup2') && !drawerState.actions) {
    toggleDrawer('actions');
  }
  calcBoardTransform();
  renderBoard();
  renderPlayers();
  renderHUD();
  renderLog();
  updateButtonStates();
  checkModals();
}

// Returns true if we should hide resource counts for player p
// Admin (WEB_PLAYER_ID===null) always sees all. Spectator always hides all.
// Web player: hide others if hiddenResources option is on.
function shouldHideRes(p) {
  const hidden = state?.hiddenResources ?? false; // default false if not set
  if (!hidden) return false;                       // option off → show all
  if (window.__SPECTATOR_MODE) return true;        // spectator → hide all
  if (WEB_PLAYER_ID === null) return false;        // admin → show all
  return p.id !== WEB_PLAYER_ID;                   // web player → hide others
}

function renderPlayers() {
  const panel = document.getElementById('players-panel');
  panel.innerHTML = '';
  if (!state) return;
  const curIdx = state.phase==='main' ? state.currentPlayerIndex
               : (state.setupOrder?.[state.setupStep] ?? 0);

  for (const p of state.players) {
    const card = document.createElement('div');
    card.className = ('player-card' + (p.id===curIdx ? ' active-player' : '') +
                     (WEB_PLAYER_ID!==null && p.id===WEB_PLAYER_ID ? ' web-player-me' : ''));
    card.dataset.pid = p.id;
    card.style.color       = p.color; // player color for name/dots
    card.style.borderColor = p.id===curIdx ? p.color : 'rgba(255,255,255,.12)';
    card.style.opacity     = p.id===curIdx ? '1' : '0.75';
    const res = p.resources;
    const hide = shouldHideRes(p);
    const resHtml = ['wood','brick','sheep','wheat','ore'].map(r=>
      `<div class="res-badge${hide?' res-hidden':''}" data-tip="${resName(r)}"><span class="res-icon">${resEmoji(r)}</span><span>${hide ? '?' : (res[r]||0)}</span></div>`
    ).join('');
    const devCount = p.devCards?.length||0;
    const progCount = p.progressCards?.length||0;
    const specials = badgeHTML(p);
    const ckHtml = state.citiesKnights ? `<div class="player-commodities">
        <div class="res-badge" data-tip="${commodityName('paper')}"><span class="res-icon">📜</span><span>${hide?'?':(p.commodities?.paper||0)}</span></div>
        <div class="res-badge" data-tip="${commodityName('cloth')}"><span class="res-icon">🧵</span><span>${hide?'?':(p.commodities?.cloth||0)}</span></div>
        <div class="res-badge" data-tip="${commodityName('coin')}"><span class="res-icon">🪙</span><span>${hide?'?':(p.commodities?.coin||0)}</span></div>
      </div>` : '';
    const mobConn = state.mobileConnected?.[p.id];
    const qrBtn   = `<button class="card-qr-btn" title="QR"
      onclick="event.stopPropagation();showQRForPlayer(${p.id})">📱</button>`;
    card.innerHTML = `
      <div class="player-name-row">
        <div class="player-color-dot" style="background:${p.color}"></div>
        <span class="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'player-name editable-name':'player-name'}"
          title="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'Clicca per rinominare':''}"
          onclick="promptRenamePlayer(${p.id})">${escHtml(p.name)}</span>
        ${WEB_PLAYER_ID!==null&&WEB_PLAYER_ID===p.id?'<span class="you-badge">👤 Tu</span>':''}
        ${mobConn?'<span class="mob-badge">📱✓</span>':''}
        <span class="player-pts">⭐${p.points}</span>
        ${qrBtn}
      </div>
      <div class="player-resources">${resHtml}</div>
      ${ckHtml}
      ${devCount>0?`<div style="font-size:.72rem;color:#c8b080;margin-top:4px">🃏 ${devCount} carta${devCount>1?'e':''}</div>`:''}${state.citiesKnights&&progCount>0?`<div style="font-size:.72rem;color:#a8c8d0;margin-top:2px;cursor:pointer" onclick="openProgressHandModal(${p.id})">📗 ${progCount} carta${progCount>1?'e':''} progresso</div>`:''}
      ${specials?`<div class="player-specials">${specials}</div>`:''}`;
    panel.appendChild(card);
  }
}

function renderHUD() {
  if (!state) return;
  const curIdx = state.phase==='main' ? state.currentPlayerIndex
               : (state.setupOrder?.[state.setupStep] ?? 0);
  const player = state.players[curIdx];

  const ind = document.getElementById('turn-indicator');
  ind.style.color = ind.style.borderColor = player.color;
  const phase = (state.phase==='setup1'||state.phase==='setup2')
    ? (state.waitingForRoad ? skinLabel('road', t('phase_place_road')) : skinLabel('settlement', t('phase_place_sett')))
    : (state.diceRolled ? t('phase_build') : t('phase_roll'));
  ind.textContent = `${player.name} — ${phase}`;

  const d1=document.getElementById('die1'), d2=document.getElementById('die2');
  // Show '?' while the big animation is running; reveal result only after it finishes
  if (diceAnimating && state.diceRolled) {
    d1.textContent = '?';
    d2.textContent = '?';
  } else {
    d1.textContent = state.diceValues[0] ? dieChar(state.diceValues[0]) : '?';
    d2.textContent = state.diceValues[1] ? dieChar(state.diceValues[1]) : '?';
  }

  // Cities & Knights: event die + barbarian fleet progress
  const die3 = document.getElementById('die3');
  const barbTrack = document.getElementById('barbarian-track');
  if (die3 && barbTrack) {
    const ckOn = !!state.citiesKnights;
    die3.classList.toggle('hidden', !ckOn);
    barbTrack.classList.toggle('hidden', !ckOn);
    if (ckOn) {
      const EVENT_ICON = { ships:'🚢', trade:'⚖️', politics:'👑', science:'🔬' };
      const EVENT_NAME  = { ships: t('ck_event_ships')||'Nave', trade: t('ck_track_trade')||'Commercio', politics: t('ck_track_politics')||'Politica', science: t('ck_track_science')||'Scienza' };
      if (diceAnimating && state.diceRolled) {
        die3.textContent = '?';
        die3.setAttribute('data-tip', t('ck_event_die')||'Dado evento');
      } else if (state.eventDie) {
        die3.textContent = EVENT_ICON[state.eventDie] || '?';
        die3.setAttribute('data-tip', EVENT_NAME[state.eventDie]);
      } else {
        die3.textContent = '?';
      }
      const progress = state.barbarianProgress || 0;
      barbTrack.textContent = `🚢 ${progress}/7`;
      const deckCounts = state.progressDeckCounts || {trade:0,politics:0,science:0};
      barbTrack.setAttribute('data-tip', `${t('ck_event_die')||'Dado evento'} — 🟡${deckCounts.trade} 🔵${deckCounts.politics} 🟢${deckCounts.science}`);
    }
  }

  const setupB  = document.getElementById('setup-banner');
  const robberB = document.getElementById('robber-banner');
  if (state.phase==='setup1'||state.phase==='setup2') {
    setupB.classList.remove('hidden');
    setupB.textContent = state.waitingForRoad
      ? `${player.name}: ${skinLabel('road', t('phase_place_road'))}`
      : `${player.name}: ${skinLabel('settlement', t('phase_place_sett'))}`;
  } else setupB.classList.add('hidden');
  robberB.classList.toggle('hidden', !state.pendingRobber);
  if (state.pendingRobber) robberB.textContent = skinLabel('robber', t('banner_robber'));

  const barbChoiceB = document.getElementById('barbarian-choice-banner');
  if (barbChoiceB) {
    const hasChoice = state.citiesKnights && state.pendingBarbarianChoices?.length > 0;
    barbChoiceB.classList.toggle('hidden', !hasChoice);
    if (hasChoice) barbChoiceB.textContent = `🏹 ${t('ck_pick_lost_city')||'Scegli quale città perdere'}`;
  }
  const metroChoiceB = document.getElementById('metropolis-choice-banner');
  if (metroChoiceB) {
    const hasMetroChoice = !!state.pendingMetropolisChoice;
    metroChoiceB.classList.toggle('hidden', !hasMetroChoice);
    if (hasMetroChoice) metroChoiceB.textContent = `🏛️ ${t('ck_pick_metropolis_city')||'Scegli quale città diventa la Metropoli'}`;
  }
  if (state.pendingSetupEndTurn) {
    setupB.classList.remove('hidden');
    setupB.textContent = `✅ ${t('setup_confirm')||'Placement done — press End Turn to confirm'}`;
  }

  // Road Building card — auto-enter road build mode and show banner
  const setupB2 = document.getElementById('setup-banner');
  if (state.pendingRoadBuilding > 0 && !state.pendingRobber &&
      state.phase === 'main') {
    if (buildMode !== 'road') buildMode = 'road';
    setupB2.classList.remove('hidden');
    setupB2.textContent = `🛤 ${skinLabel('road', t('btn_road'))} — ${state.pendingRoadBuilding} ${state.pendingRoadBuilding===1?skinLabel('road', t('phase_place_road')):t('sec_build')}`;
  }
}

function dieChar(n) { return ['','⚀','⚁','⚂','⚃','⚄','⚅'][n]||n; }

function renderLog() {
  const log = document.getElementById('game-log');
  if (!state?.log) return;
  log.innerHTML = state.log.map(e => {
    const msg = translateLogEntry(e);
    return `<div class="log-entry">${escHtml(msg)}</div>`;
  }).join('');
}

function translateLogEntry(e) {
  if (!e.key) return e.msg || '';
  const p = e.params || {};
  const DEV_DISPLAY = {
    knight:      skinLabel('devname_knight',     '⚔️').split(' ')[0],
    victoryPoint: '⭐', // VP not played from hand, subtype N/A in log
    roadBuilding: skinLabel('devname_road_build', '🛤').split(' ')[0],
    yearOfPlenty: skinLabel('devname_yop',        '🌻').split(' ')[0],
    monopoly:     skinLabel('devname_monopoly',   '👑').split(' ')[0]
  };
  const rn = r => resName(r); // resource name (skin-aware)
  switch (e.key) {
    case 'log_place_sett':   return t('log_place_sett', p.name);
    case 'log_place_road':   return t('log_place_road', p.name);
    case 'log_setup_done':   return t('log_setup_done');
    case 'log_turn':         return t('log_turn', p.name);
    case 'log_roll':         return t('log_roll', p.name, p.d1, p.d2, p.total);
    case 'log_build_road':   return t('log_build_road', p.name);
    case 'log_build_sett':   return t('log_build_sett', p.name);
    case 'log_build_city':   return t('log_build_city', p.name);
    case 'log_buy_dev':      return t('log_buy_dev', p.name);
    case 'log_play_card':    return t('log_play_card', p.name, p.card);
    case 'log_bank_trade':   return t('log_bank_trade', p.name, p.ratio, rn(p.give), rn(p.receive));
    case 'log_player_trade': return t('log_player_trade', p.from, p.to, p.offer, p.want);
    case 'log_steal':        return t('log_steal', p.name, p.from);
    case 'log_longest_road': return `${p.name} ${skinLabel('log_longest_road', 'ha la Strada più Lunga')} (${p.len})`;
    case 'log_largest_army': return `${p.name} ${skinLabel('log_largest_army', 'ha il Grande Esercito')}`;
    // ── Cities & Knights ──
    case 'log_barbarian_advance': return t('log_ck_barbarian_advance', p.progress);
    case 'log_barbarian_win':     return t('log_ck_barbarian_win');
    case 'log_defender_of_catan': return t('log_ck_defender', p.name);
    case 'log_defender_tie':      return t('log_ck_defender_tie', p.name);
    case 'log_build_knight':      return t('log_ck_build_knight', p.name);
    case 'log_activate_knight':   return t('log_ck_activate_knight', p.name);
    case 'log_promote_knight':    return t('log_ck_promote_knight', p.name);
    case 'log_move_knight':       return t('log_ck_move_knight', p.name);
    case 'log_displace_knight':   return t('log_ck_displace_knight', p.name);
    case 'log_knight_chase_robber': return t('log_ck_chase_robber', p.name);
    case 'log_city_improvement':  return t('log_ck_city_improvement', p.name, t('ck_track_'+p.track) || p.track, p.level);
    case 'log_metropolis_founded': return t('log_ck_metropolis_founded', p.name, t('ck_track_'+p.track) || p.track);
    case 'log_metropolis_lost':   return t('log_ck_metropolis_lost', p.name, t('ck_track_'+p.track) || p.track);
    case 'log_city_downgraded':   return t('log_ck_city_downgraded', p.name);
    case 'log_progress_drawn':    return t('log_ck_progress_drawn', p.name, t('ck_track_'+p.color) || p.color);
    case 'log_progress_vp':       return t('log_ck_progress_vp', p.name);
    default: return e.key;
  }
}

// ── Board-aware affordability checks ──────────────────────
// These mirror the server-side validation rules exactly.

function clientHasValidRoadPlacement(pid) {
  // Must have at least one free edge adjacent to own settlement/road
  // not blocked by opponent settlement at the connecting vertex
  return state.board.edges.some(e => {
    if (e.owner !== null) return false;
    for (const vid of [e.v1, e.v2]) {
      const v = state.board.vertices[vid];
      if (v.owner === pid) return true;
      if (v.owner === null || v.owner === pid) {
        if (v.adjEdges.some(eid => eid !== e.id && state.board.edges[eid].owner === pid)) return true;
      }
    }
    return false;
  });
}

function clientHasValidSettlementPlacement(pid) {
  // Must have a free vertex at distance ≥2, adjacent to own road
  return state.board.vertices.some(v => {
    if (v.owner !== null) return false;
    // distance rule: no adjacent settled vertex
    for (const eid of v.adjEdges) {
      const e = state.board.edges[eid];
      const nid = e.v1 === v.id ? e.v2 : e.v1;
      if (state.board.vertices[nid].owner !== null) return false;
    }
    // must connect to own road
    return v.adjEdges.some(eid => state.board.edges[eid].owner === pid);
  });
}

function clientHasValidCityPlacement(pid) {
  // Must have at least one own settlement to upgrade
  return state.players[pid].settlements.length > 0;
}

function clientHasValidBankTrade(res) {
  // True if there's any resource we can trade at ratio ≤ current holdings
  const p = state.players[state.currentPlayerIndex];
  return ['wood','brick','sheep','wheat','ore'].some(r => {
    const ratio = getClientTradeRatio(p, r);
    return (p.resources[r]||0) >= ratio;
  });
}

function updateButtonStates() {
  if (!state) return;
  if (window.__SPECTATOR_MODE) return; // spectator has no buttons to update
  const isMain  = state.phase==='main';
  const rolled  = state.diceRolled;
  const pending = state.pendingRobber||state.pendingSteal||state.pendingKnightDisplace||(state.pendingBarbarianChoices?.length>0)||state.pendingMetropolisChoice;
  const discard = state.pendingDiscard?.length>0;
  const rbuild  = state.pendingRoadBuilding>0;
  const pid     = state.currentPlayerIndex;
  const p       = state.players[pid];
  // Web player mode: only enable actions when it's this player's turn
  // During setup, the active player is setupOrder[setupStep], not currentPlayerIndex
  const isWebPlayer = WEB_PLAYER_ID !== null;
  const effectivePid = (state.phase==='setup1'||state.phase==='setup2')
    ? (state.setupOrder?.[state.setupStep] ?? 0)
    : pid;
  const isMyWebTurn = !isWebPlayer || effectivePid === WEB_PLAYER_ID;
  const res     = p?.resources || {};

  const isSetup = state.phase==='setup1'||state.phase==='setup2';
  document.getElementById('btn-roll').disabled = !isMain||rolled||pending||!isMyWebTurn;
  const btnEndTurn = document.getElementById('btn-end-turn');
  // During setup: end turn available when road placed (pendingSetupEndTurn)
  const setupEndOk = isSetup && state.pendingSetupEndTurn && isMyWebTurn;
  const hasPendingTrade = !!state.pendingTrade;
  btnEndTurn.disabled = setupEndOk ? false : (!isMain||!rolled||pending||discard||!isMyWebTurn||hasPendingTrade);
  // Show who must discard as tooltip
  if (discard && isMain && rolled) {
    const names = state.pendingDiscard.map(id=>state.players[id]?.name).filter(Boolean).join(', ');
    btnEndTurn.title = `${t('must_discard_first')||'Must discard first'}: ${names}`;
  } else {
    btnEndTurn.title = '';
  }

  const canAct = isMain && rolled && !pending && isMyWebTurn && !hasPendingTrade;

  // ── Road ──
  // Resources OK (or free from card) AND at least one valid placement exists
  const hasRoadRes  = rbuild || (res.wood>=1 && res.brick>=1);
  const hasRoadSpot = canAct && clientHasValidRoadPlacement(pid);
  const btnRoad = document.getElementById('btn-road');
  // During setup: enable road button only when it's my turn and waitingForRoad
  const setupRoadOk = isSetup && isMyWebTurn && state.waitingForRoad && !state.pendingSetupEndTurn;
  btnRoad.disabled = !setupRoadOk && !canAct && !rbuild;
  btnRoad.classList.toggle('cant-afford', (canAct||rbuild) && !(hasRoadRes && hasRoadSpot));

  // ── Settlement ──
  // Resources AND valid spot (distance rule + adjacent road)
  const hasSettRes  = res.wood>=1 && res.brick>=1 && res.sheep>=1 && res.wheat>=1;
  const hasSettSpot = clientHasValidSettlementPlacement(pid);
  const btnSett = document.getElementById('btn-settlement');
  // During setup: enable settlement button only when it's my turn and !waitingForRoad
  const setupSettOk = isSetup && isMyWebTurn && !state.waitingForRoad && !state.pendingSetupEndTurn;
  btnSett.disabled = !setupSettOk && (!canAct || !hasSettSpot);
  btnSett.classList.toggle('cant-afford', canAct && hasSettSpot && !hasSettRes);

  // ── City ──
  // Resources AND own settlement to upgrade
  const hasCityRes  = res.wheat>=2 && res.ore>=3;
  const hasCitySpot = canAct && clientHasValidCityPlacement(pid);
  const btnCity = document.getElementById('btn-city');
  btnCity.disabled = !canAct;
  btnCity.classList.toggle('cant-afford', canAct && !(hasCityRes && hasCitySpot));

  // ── Dev card ── (official C&K has no development cards: hide entirely)
  const canDev = !state.citiesKnights && canAct && res.sheep>=1 && res.wheat>=1 && res.ore>=1 && state.devDeckSize>0
    && (state.unlimitedDev || !state.devCardBoughtThisTurn);
  const btnDev = document.getElementById('btn-devcard');
  btnDev.style.display = state.citiesKnights ? 'none' : '';
  btnDev.disabled = !canAct || state.citiesKnights;
  btnDev.classList.toggle('cant-afford', canAct && !canDev);

  // ── Trade bank ── grey if nothing tradeable at any ratio
  const btnBank = document.getElementById('btn-trade-bank');
  btnBank.disabled = !canAct;
  btnBank.classList.toggle('cant-afford', canAct && !clientHasValidBankTrade());

  // ── Trade player ── always available if canAct (other player may have what you need)
  document.getElementById('btn-trade-player').disabled = !canAct;

  // ── Play dev card — knight can be played before rolling ──
  const hasKnight      = !state.citiesKnights && (p?.devCards||[]).some(c => !c.new && c.type==='knight');
  const hasPlayableDev = !state.citiesKnights && (p?.devCards||[]).some(c => !c.new);
  const btnPlayDev = document.getElementById('btn-play-dev');
  btnPlayDev.style.display = state.citiesKnights ? 'none' : '';
  // Enabled: main phase + not pending robber + (rolled OR has knight)
  const canPlayDev = isMain && !pending && (rolled ? hasPlayableDev : hasKnight);
  btnPlayDev.disabled = !canPlayDev;
  btnPlayDev.classList.toggle('cant-afford', isMain && !pending && !hasPlayableDev && !hasKnight);
  // Badge on the button when knight is available pre-roll
  if (!rolled && hasKnight && isMain && !pending) {
    btnPlayDev.classList.add('has-knight');
  } else {
    btnPlayDev.classList.remove('has-knight');
  }

  document.getElementById('btn-road').classList.toggle('active-mode', buildMode==='road');
  document.getElementById('btn-settlement').classList.toggle('active-mode', buildMode==='settlement');
  document.getElementById('btn-city').classList.toggle('active-mode', buildMode==='city');
  document.getElementById('btn-knight')?.classList.toggle('active-mode', buildMode==='knight' || buildMode==='knight_move_target' || buildMode==='knight_chase_target' || buildMode==='knight_displace_target');

  // Undo button — available after dice roll, not during robber/discard
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    const isSetup = state.phase==='setup1'||state.phase==='setup2';
    btnUndo.disabled = !(isMain || isSetup) || (isMain && (!rolled || pending || discard)) || !state.undoAvailable;
  }

  // ── Cities & Knights: city improvements ──
  const ckOn = !!state.citiesKnights;
  document.querySelectorAll('.ck-only').forEach(el => el.classList.toggle('hidden', !ckOn));
  if (ckOn) {
    const btnCk = document.getElementById('btn-city-improvements');
    const commodities = p?.commodities || {};
    const hasAnyCommodity = (commodities.paper||0)>0 || (commodities.cloth||0)>0 || (commodities.coin||0)>0;
    const hasCity = (p?.cities?.length||0) > 0;
    btnCk.disabled = !canAct;
    btnCk.classList.toggle('cant-afford', canAct && !(hasCity && hasAnyCommodity));

    const btnKnight = document.getElementById('btn-knight');
    const hasKnightRes = res.sheep>=1 && res.ore>=1;
    const basicKnights = (p?.knights||[]).filter(k=>k.rank==='basic').length;
    btnKnight.disabled = !canAct;
    btnKnight.classList.toggle('cant-afford', canAct && !(hasKnightRes && basicKnights<2));
  }
}

function checkModals() {
  if (!state) return;
  if (state.winner!==null) { showWinner(); return; }

  // In web-player mode, only react to actions for THIS player
  const _effectiveCurrent = (state.phase==='setup1'||state.phase==='setup2')
    ? (state.setupOrder?.[state.setupStep] ?? 0)
    : state.currentPlayerIndex;
  const amCurrentPlayer = WEB_PLAYER_ID === null || _effectiveCurrent === WEB_PLAYER_ID;

  // Discard: only show if it's MY turn to discard
  if (state.pendingDiscard?.length > 0) {
    const myDiscard = WEB_PLAYER_ID === null
      ? state.pendingDiscard[0]                                    // admin: show first needing discard
      : state.pendingDiscard.includes(WEB_PLAYER_ID) ? WEB_PLAYER_ID : null; // player: only mine
    if (myDiscard !== null && myDiscard !== undefined) {
      showDiscardModal(myDiscard); return;
    }
  }
  if (state.pendingSteal&&state.robberCandidates?.length>1&&amCurrentPlayer) { showStealModal(); return; }
  // Cities & Knights: keep the improvements modal in sync with the server —
  // it stays open across purchases so the player can chain levels, and it is
  // re-rendered here on every broadcast (never optimistically from local
  // state). If the purchase just triggered a metropolis-city choice, close
  // it instead so the board highlight/banner is visible.
  if (document.getElementById('modal-city-improvements')?.classList.contains('open')) {
    if (state.pendingMetropolisChoice) closeAllModals();
    else openCityImprovementsModal();
  }
  // Cities & Knights: progress-card hand-limit discard (same visibility rule as resource discard)
  if (state.pendingProgressDiscard?.length > 0) {
    const myProgDiscard = WEB_PLAYER_ID === null
      ? state.pendingProgressDiscard[0]
      : state.pendingProgressDiscard.includes(WEB_PLAYER_ID) ? WEB_PLAYER_ID : null;
    if (myProgDiscard !== null && myProgDiscard !== undefined) {
      showProgressDiscardModal(myProgDiscard); return;
    }
  }
  // Cities & Knights: tied Defender of Catan — each tied player picks a
  // progress-card color (same visibility rule as the progress discard)
  if (state.pendingDefenderCardChoice?.length > 0) {
    const myDefChoice = WEB_PLAYER_ID === null
      ? state.pendingDefenderCardChoice[0]
      : state.pendingDefenderCardChoice.includes(WEB_PLAYER_ID) ? WEB_PLAYER_ID : null;
    if (myDefChoice !== null && myDefChoice !== undefined) {
      showDefenderChoiceModal(myDefChoice); return;
    }
  }
  // Show trade accept modal on desktop when a pending trade arrives
  const tradeModal = document.getElementById('modal-trade-accept');
  if (state.pendingTrade) {
    // Show accept modal if not already open
    const tradeTargetOk = WEB_PLAYER_ID === null || state.pendingTrade.toId === WEB_PLAYER_ID;
    if (!tradeModal.classList.contains('open') && tradeTargetOk) {
      const pt = state.pendingTrade;
      try {
        showTradeAcceptModal(pt.toId, pt.offer, pt.want, pt.fromId);
      } catch(e) {
        console.error('[showTradeAcceptModal] ERROR:', e);
      }
    }
  } else {
    // pendingTrade cleared (accepted or rejected) — close modal if open
    if (tradeModal.classList.contains('open')) closeAllModals();
  }
}

// ===================================================================
//  CANVAS INTERACTION
// ===================================================================
canvas.addEventListener('click', onCanvasClick);

// Dynamic cursor: show pointer over valid placement targets
canvas.addEventListener('mousemove', e => {
  if (!state || !state.board) { canvas.style.cursor='default'; return; }
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX-rect.left, my = e.clientY-rect.top;
  const isSetup = state.phase==='setup1'||state.phase==='setup2';

  // Check if I can interact at all (web player mode: only on my turn)
  if (WEB_PLAYER_ID !== null) {
    const activePid = isSetup
      ? (state.setupOrder?.[state.setupStep] ?? 0)
      : state.currentPlayerIndex;
    const myDiscard = state.pendingDiscard?.includes(WEB_PLAYER_ID);
    if (activePid !== WEB_PLAYER_ID && !myDiscard) {
      canvas.style.cursor = 'default'; return;
    }
  }

  if (state.pendingRobber) {
    canvas.style.cursor = findClickedHex(mx,my) ? 'crosshair' : 'default';
  } else if (buildMode==='road' || (isSetup && state.waitingForRoad && buildMode==='road')) {
    canvas.style.cursor = findClickedEdge(mx,my) ? 'pointer' : 'default';
  } else if (buildMode==='settlement' || buildMode==='city' || (isSetup && !state.waitingForRoad && buildMode==='settlement')) {
    canvas.style.cursor = findClickedVertex(mx,my) ? 'pointer' : 'default';
  } else {
    canvas.style.cursor = 'default';
  }
});

canvas.addEventListener('mouseleave', () => { if (canvas) canvas.style.cursor='default'; });
canvas.addEventListener('touchend', e=>{
  e.preventDefault();
  const t=e.changedTouches[0];
  onCanvasClick({clientX:t.clientX,clientY:t.clientY});
},{passive:false});

function onCanvasClick(e) {
  if (!state) return;
  if (window.__SPECTATOR_MODE) return; // spectator: read-only
  // In web-player mode, block all board interactions when not my turn
  if (WEB_PLAYER_ID !== null) {
    const activePid = (state.phase==='setup1'||state.phase==='setup2')
      ? (state.setupOrder?.[state.setupStep] ?? 0)
      : state.currentPlayerIndex;
    const myDiscard = state.pendingDiscard?.includes(WEB_PLAYER_ID);
    if (activePid !== WEB_PLAYER_ID && !myDiscard) return;
  }

  // Read canvas coords BEFORE closing drawers (which recalculates board transform)
  const rect=canvas.getBoundingClientRect();
  const mx=e.clientX-rect.left, my=e.clientY-rect.top;

  // Resolve action FIRST using current transform
  if (state.pendingRobber) {
    const h=findClickedHex(mx,my);
    if (h) {
      send({type:'MOVE_ROBBER',hexId:h.id});
      closeDrawers();
    }
    return;
  }
  if (state.pendingKnightDisplace) {
    const vt=findClickedVertex(mx,my);
    if (vt && state.pendingKnightDisplace.options.includes(vt.id)) {
      send({type:'RESOLVE_KNIGHT_DISPLACE',vertexId:vt.id});
      closeDrawers();
    }
    return;
  }
  if (state.pendingBarbarianChoices?.length > 0) {
    const vt=findClickedVertex(mx,my);
    const current = state.pendingBarbarianChoices[0];
    if (vt && current.options.includes(vt.id)) {
      send({type:'RESOLVE_BARBARIAN_CITY_CHOICE',vertexId:vt.id});
      closeDrawers();
    }
    return;
  }
  if (state.pendingMetropolisChoice) {
    const vt=findClickedVertex(mx,my);
    if (vt && state.pendingMetropolisChoice.options.includes(vt.id)) {
      send({type:'RESOLVE_METROPOLIS_CHOICE',vertexId:vt.id});
      closeDrawers();
    }
    return;
  }
  // Close drawers and recalc transform AFTER reading coordinates
  // but BEFORE any non-action click (open sea tap)
  if (state.phase==='setup1'||state.phase==='setup2') {
    // Block if waiting for End Turn confirmation
    if (state.pendingSetupEndTurn) return;
    // Require explicit button press before placing — no auto-placement on canvas click
    if (state.waitingForRoad) {
      if (buildMode==='road') { const ed=findClickedEdge(mx,my); if(ed) { send({type:'PLACE_INITIAL_ROAD',edgeId:ed.id}); buildMode=null; } }
    } else {
      if (buildMode==='settlement') { const vt=findClickedVertex(mx,my); if(vt) { send({type:'PLACE_INITIAL_SETTLEMENT',vertexId:vt.id}); buildMode=null; } }
    }
    return;
  }
  if (buildMode==='road')       { const ed=findClickedEdge(mx,my);   if(ed){ send({type:'BUILD_ROAD',edgeId:ed.id});       if(state.pendingRoadBuilding<=1) buildMode=null; } }
  else if (buildMode==='settlement') { const vt=findClickedVertex(mx,my); if(vt){ send({type:'BUILD_SETTLEMENT',vertexId:vt.id}); buildMode=null; } }
  else if (buildMode==='city')  { const vt=findClickedVertex(mx,my); if(vt){ send({type:'BUILD_CITY',vertexId:vt.id});      buildMode=null; } }
  else if (buildMode==='knight') { const vt=findClickedVertex(mx,my); if(vt){ send({type:'BUILD_KNIGHT',vertexId:vt.id}); buildMode=null; } }
  else if (buildMode==='knight_move_target') {
    const vt=findClickedVertex(mx,my);
    if(vt){ send({type:'MOVE_KNIGHT',fromVertexId:knightActionFrom,toVertexId:vt.id}); buildMode=null; knightActionFrom=null; }
  }
  else if (buildMode==='knight_chase_target') {
    const h=findClickedHex(mx,my);
    if(h){ send({type:'CHASE_ROBBER_KNIGHT',vertexId:knightActionFrom,newHexId:h.id}); buildMode=null; knightActionFrom=null; }
  }
  else if (buildMode==='knight_displace_target') {
    const vt=findClickedVertex(mx,my);
    if(vt){ send({type:'DISPLACE_KNIGHT',fromVertexId:knightActionFrom,targetVertexId:vt.id}); buildMode=null; knightActionFrom=null; }
  }
  else {
    const vt = findClickedVertex(mx,my);
    if (vt && state.citiesKnights) {
      const myKnight = state.players[state.currentPlayerIndex]?.knights?.find(k=>k.vertexId===vt.id);
      if (myKnight) { openKnightActionsModal(vt.id); return; }
    }
    closeDrawers(); if (state) { calcBoardTransform(); renderBoard(); }
  }
}

function findClickedHex(mx,my) {
  let best=null, bestD=HEX_SIZE*.95;
  for (const h of state.board.hexes) {
    const d=Math.hypot(mx-px(h.cx),my-py(h.cy));
    if (d<bestD){bestD=d;best=h;}
  }
  return best;
}
function findClickedVertex(mx,my) {
  let best=null,bd=HEX_SIZE*.35;
  for(const v of state.board.vertices){ const d=Math.hypot(mx-px(v.x),my-py(v.y)); if(d<bd){bd=d;best=v;} }
  return best;
}
function findClickedEdge(mx,my) {
  let best=null,bd=HEX_SIZE*.28;
  for(const e of state.board.edges){
    const v1=state.board.vertices[e.v1],v2=state.board.vertices[e.v2]; if(!v1||!v2) continue;
    const d=Math.hypot(mx-(px(v1.x)+px(v2.x))/2,my-(py(v1.y)+py(v2.y))/2);
    if(d<bd){bd=d;best=e;}
  }
  return best;
}

// ===================================================================
//  PLACEMENT VALIDATION (client-side)
// ===================================================================
function isValidRoad(edgeId) {
  if (!state||state.phase!=='main') return false;
  const pid=state.currentPlayerIndex, edge=state.board.edges[edgeId];
  if (edge.owner!==null) return false;
  for (const vid of [edge.v1,edge.v2]) {
    const v=state.board.vertices[vid];
    if (v.owner===pid) return true;
    if (v.owner===null||v.owner===pid)
      if (v.adjEdges.some(eid=>eid!==edgeId&&state.board.edges[eid].owner===pid)) return true;
  }
  return false;
}
function isValidSettlement(vId) {
  if (!state||state.phase!=='main') return false;
  const pid=state.currentPlayerIndex, v=state.board.vertices[vId];
  if (v.owner!==null) return false;
  for (const eid of v.adjEdges) {
    const e=state.board.edges[eid];
    if (state.board.vertices[e.v1===vId?e.v2:e.v1].owner!==null) return false;
  }
  return v.adjEdges.some(eid=>state.board.edges[eid].owner===pid);
}
function isValidCity(vId) {
  if (!state||state.phase!=='main') return false;
  const v=state.board.vertices[vId];
  return v.owner===state.currentPlayerIndex && v.building==='settlement';
}
function isValidKnightSpot(vId) {
  if (!state||state.phase!=='main'||!state.citiesKnights) return false;
  const pid=state.currentPlayerIndex, v=state.board.vertices[vId];
  if (v.owner!==null) return false;
  if (state.players.some(p => (p.knights||[]).some(k=>k.vertexId===vId))) return false;
  return v.adjEdges.some(eid=>state.board.edges[eid].owner===pid);
}

// ===================================================================
//  BUTTON HANDLERS
// ===================================================================
// btn-roll is handled by initDiceButton() below (with animation)
document.getElementById('btn-end-turn')?.addEventListener('click', ()=>{
  buildMode=null;
  if (state?.pendingSetupEndTurn) send({type:'SETUP_END_TURN'});
  else send({type:'END_TURN'});
});
document.getElementById('btn-reset')?.addEventListener('click', () => {
  if (confirm(t('confirm_new_game'))) {
    send({ type: 'RESET_GAME' });
    currentPin = null;
    document.getElementById('pin-badge')?.remove();
    history.replaceState({}, '', '/');
    showScreen('setup-screen');
    initRoom(); // generate new PIN for next game
  }
});
document.getElementById('btn-undo')?.addEventListener('click', () => { send({ type: 'UNDO' }); });

document.getElementById('btn-road')?.addEventListener('click',()=>{
  buildMode=buildMode==='road'?null:'road'; renderBoard(); updateButtonStates();
});
document.getElementById('btn-settlement')?.addEventListener('click',()=>{
  buildMode=buildMode==='settlement'?null:'settlement'; renderBoard(); updateButtonStates();
});
document.getElementById('btn-city')?.addEventListener('click',()=>{
  buildMode=buildMode==='city'?null:'city'; renderBoard(); updateButtonStates();
});
document.getElementById('btn-knight')?.addEventListener('click',()=>{
  buildMode=buildMode==='knight'?null:'knight'; renderBoard(); updateButtonStates();
});
document.getElementById('btn-devcard')?.addEventListener('click',    ()=>send({type:'BUY_DEV_CARD'}));
document.getElementById('btn-trade-bank')?.addEventListener('click', openTradeBankModal);
document.getElementById('btn-trade-player')?.addEventListener('click',openPlayerTradeModal);
document.getElementById('btn-play-dev')?.addEventListener('click',   openDevCardModal);
document.getElementById('btn-city-improvements')?.addEventListener('click', openCityImprovementsModal);

// ===================================================================
//  TRADE BANK MODAL
// ===================================================================
let tradeGive=null,tradeReceive=null;

function openTradeBankModal() {
  tradeGive=null; tradeReceive=null;
  const p=state.players[state.currentPlayerIndex];
  const res=['wood','brick','sheep','wheat','ore'];
  const commodities = state.citiesKnights ? ['paper','cloth','coin'] : [];
  const CK_COMMODITY_ICON = { paper: '📜', cloth: '🧵', coin: '🪙' };

  const giveResHtml = res.map(r => {
    const ratio = getClientTradeRatio(p, r);
    const have  = p.resources[r]||0;
    const canAfford = have >= ratio;
    return `<button class="res-pick-btn${canAfford?'':' res-cant-afford'}" data-res="${r}" onclick="selectTradeGive('${r}')" ${canAfford?'':'disabled'}>
      <span class="res-emoji">${resEmoji(r)}</span>
      <span>${resName(r)}</span>
      <small>${have} / ${ratio}</small>
    </button>`;
  }).join('');
  const giveComHtml = commodities.map(c => {
    const ratio = getClientCommodityTradeRatio(p);
    const have  = p.commodities?.[c]||0;
    const canAfford = have >= ratio;
    return `<button class="res-pick-btn${canAfford?'':' res-cant-afford'}" data-res="${c}" onclick="selectTradeGive('${c}')" ${canAfford?'':'disabled'}>
      <span class="res-emoji">${CK_COMMODITY_ICON[c]}</span>
      <span>${commodityName(c)}</span>
      <small>${have} / ${ratio}</small>
    </button>`;
  }).join('');
  document.getElementById('trade-give').innerHTML = giveResHtml + giveComHtml;

  const receiveResHtml = res.map(r => {
    return `<button class="res-pick-btn" data-res="${r}" onclick="selectTradeReceive('${r}')">
      <span class="res-emoji">${resEmoji(r)}</span><span>${resName(r)}</span>
    </button>`;
  }).join('');
  const receiveComHtml = commodities.map(c => {
    return `<button class="res-pick-btn" data-res="${c}" onclick="selectTradeReceive('${c}')">
      <span class="res-emoji">${CK_COMMODITY_ICON[c]}</span><span>${commodityName(c)}</span>
    </button>`;
  }).join('');
  document.getElementById('trade-receive').innerHTML = receiveResHtml + receiveComHtml;

  document.getElementById('trade-ratio-info').textContent='';
  openModal('modal-trade-bank');
}
window.selectTradeGive    = r=>{ tradeGive=r;    document.querySelectorAll('#trade-give .res-pick-btn').forEach(b=>b.classList.toggle('selected',b.dataset.res===r)); updateTradeRatioInfo(); };
window.selectTradeReceive = r=>{ tradeReceive=r; document.querySelectorAll('#trade-receive .res-pick-btn').forEach(b=>b.classList.toggle('selected',b.dataset.res===r)); };

const CK_COMMODITY_TYPES = ['paper','cloth','coin'];
function updateTradeRatioInfo() {
  if (!tradeGive||!state) return;
  const p=state.players[state.currentPlayerIndex];
  const isCommodity = CK_COMMODITY_TYPES.includes(tradeGive);
  const ratio = isCommodity ? getClientCommodityTradeRatio(p) : getClientTradeRatio(p,tradeGive);
  const have  = isCommodity ? (p.commodities?.[tradeGive]||0) : (p.resources[tradeGive]||0);
  const icon  = isCommodity ? { paper:'📜',cloth:'🧵',coin:'🪙' }[tradeGive] : resEmoji(tradeGive);
  document.getElementById('trade-ratio-info').textContent=`Tasso: ${ratio}:1 — Hai ${have} ${icon}`;
}
function getClientTradeRatio(p,res) {
  let best=4;
  for (const vid of [...(p.settlements||[]),...(p.cities||[])]) {
    const v=state.board.vertices[vid]; if (!v?.port) continue;
    if (v.port.type===res||v.port.type==='any') best=Math.min(best,v.port.ratio);
  }
  return best;
}
// Cities & Knights: commodities only ever get the generic 3:1 harbor rate
// (no 2:1 harbor exists for a specific commodity), 4:1 with no harbor.
function getClientCommodityTradeRatio(p) {
  let best=4;
  for (const vid of [...(p.settlements||[]),...(p.cities||[])]) {
    const v=state.board.vertices[vid];
    if (v?.port?.type==='any') best=Math.min(best,v.port.ratio);
  }
  return best;
}
document.getElementById('btn-trade-confirm')?.addEventListener('click',()=>{
  if (!tradeGive||!tradeReceive) return alert('Seleziona dare e ricevere');
  send({type:'TRADE_BANK',give:tradeGive,receive:tradeReceive}); closeAllModals();
});

// ===================================================================
//  DISCARD MODAL
// ===================================================================
let discardAmounts={}, discardingPlayerId=null;

function showDiscardModal(forPlayerId) {
  if (!state.pendingDiscard?.length) return;
  const newPlayerId = forPlayerId ?? state.pendingDiscard[0];
  // Already open for the same player — don't re-render (would reset discardAmounts)
  if (document.getElementById('modal-discard').classList.contains('open') 
      && discardingPlayerId === newPlayerId) return;
  discardingPlayerId = newPlayerId;
  const p=state.players[discardingPlayerId];
  const ckOn = !!state.citiesKnights;
  const total=Object.values(p.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(p.commodities||{}).reduce((a,b)=>a+b,0) : 0);
  const must=Math.floor(total/2);
  document.getElementById('discard-title').textContent=t('discard_title',p.name);
  document.getElementById('discard-info').textContent=t('discard_info',total,must);
  discardAmounts={wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
  const resRows = ['wood','brick','sheep','wheat','ore'].map(r=>`
      <div class="discard-row">
        <label>${resEmoji(r)} ${resName(r)} (${p.resources[r]||0})</label>
        <div class="stepper">
          <button onclick="changeDiscard('${r}',-1)">−</button>
          <span id="discard-${r}">0</span>
          <button class="stepper-btn-plus" onclick="changeDiscard('${r}',1)">+</button>
        </div>
      </div>`).join('');
  const comRows = ckOn ? ['paper','cloth','coin'].map(c=>`
      <div class="discard-row">
        <label>${{paper:'📜',cloth:'🧵',coin:'🪙'}[c]} ${commodityName(c)} (${p.commodities?.[c]||0})</label>
        <div class="stepper">
          <button onclick="changeDiscard('${c}',-1)">−</button>
          <span id="discard-${c}">0</span>
          <button class="stepper-btn-plus" onclick="changeDiscard('${c}',1)">+</button>
        </div>
      </div>`).join('') : '';
  document.getElementById('discard-resources').innerHTML = resRows + comRows;
  openModal('modal-discard');
}
window.changeDiscard=(res,delta)=>{
  if (!state || discardingPlayerId === null || discardingPlayerId === undefined) return;
  const p    = state.players[discardingPlayerId];
  if (!p) return;
  const ckOn = !!state.citiesKnights;
  const tot  = Object.values(p.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(p.commodities||{}).reduce((a,b)=>a+b,0) : 0);
  const must = Math.floor(tot/2);
  const currentSum = Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  const pool = tradePool(p, res);

  if (delta > 0) {
    if (currentSum >= must) return;                    // total limit reached
    if ((discardAmounts[res]||0) >= (pool[res]||0)) return; // card limit
  }
  discardAmounts[res] = Math.max(0, (discardAmounts[res]||0) + delta);
  document.getElementById(`discard-${res}`).textContent = discardAmounts[res];

  // Update counter
  const newSum = Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  const infoEl = document.getElementById('discard-info');
  if (infoEl) infoEl.textContent = t('discard_info', tot, must) + ` (${newSum}/${must})`;

  // Grey out all + buttons when at limit
  const atLimit = newSum >= must;
  document.querySelectorAll('#discard-resources .stepper-btn-plus').forEach(b=>{
    b.disabled = atLimit;
  });
};
document.getElementById('btn-discard-confirm')?.addEventListener('click',()=>{
  const total=Object.values(discardAmounts).reduce((a,b)=>a+b,0);
  const p=state.players[discardingPlayerId];
  const ckOn = !!state.citiesKnights;
  const must=Math.floor((Object.values(p.resources).reduce((a,b)=>a+b,0) + (ckOn ? Object.values(p.commodities||{}).reduce((a,b)=>a+b,0) : 0))/2);
  if (total!==must) return alert(t('discard_error', must));
  send({type:'DISCARD_RESOURCES',playerId:discardingPlayerId,resources:discardAmounts}); closeAllModals();
});

// ===================================================================
//  STEAL MODAL
// ===================================================================
function showStealModal() {
  if (document.getElementById('modal-steal').classList.contains('open')) return;
  document.getElementById('steal-targets').innerHTML=
    state.robberCandidates.map(id=>{ const p=state.players[id];
      return `<button class="steal-target-btn" style="border-color:${p.color}" onclick="stealFrom(${id})"><span style="color:${p.color}">●</span> ${escHtml(p.name)}</button>`;
    }).join('');
  openModal('modal-steal');
}
window.stealFrom=id=>{ send({type:'STEAL_RESOURCE',targetPlayerId:id}); closeAllModals(); };

// ===================================================================
//  DEV CARD MODAL
// ===================================================================
function openDevCardModal() {
  const p     = state.players[state.currentPlayerIndex];
  const cards = p.devCards || [];
  const rolled = state.diceRolled;
  const list  = document.getElementById('dev-cards-list');
  if (!cards.length) { list.innerHTML=`<p style="color:#c8b080">${t('no_cards')}</p>`; }
  else {
    const counts={};
    for (const c of cards) {
      if (c.type === 'victoryPoint') continue;
      const k=c.type+(c.new?'_new':''); counts[k]=(counts[k]||0)+1;
    }
    list.innerHTML=Object.entries(counts).map(([k,cnt])=>{
      const isNew=k.endsWith('_new'), type=k.replace('_new','');
      const isKnight=type==='knight';
      // Disabled: new cards always; non-knight before roll
      const disabled = isNew || (!rolled && !isKnight);
      let badge='';
      if (isNew)              badge=`<span class="new-badge">${t('next_turn_badge')}</span>`;
      else if (!rolled && !isKnight) badge=`<span class="new-badge">🎲 ${t('phase_roll')}</span>`;
      else if (isKnight && !rolled)  badge=`<span class="new-badge before-roll-badge">${skinLabel('devname_knight','⚔️').split(' ')[0]} ora!</span>`;
      return `<button class="dev-card-btn${disabled?'':' playable'}" ${disabled?'disabled':''} onclick="playCard('${type}')">${DEV_NAMES[type]||type} ×${cnt}${badge}</button>`;
    }).join('');
  }
  openModal('modal-dev-play');
}
window.playCard=type=>{ closeAllModals(); if(type==='yearOfPlenty') openYOPModal(); else if(type==='monopoly') openMonopolyModal(); else send({type:'PLAY_DEV_CARD',cardType:type,params:{}}); };

// ===================================================================
//  CITIES & KNIGHTS — CITY IMPROVEMENTS MODAL
// ===================================================================
const CK_TRACKS = [
  { id: 'trade',    commodity: 'cloth', icon: '⚖️', color: '#d4a843' },
  { id: 'politics', commodity: 'coin',  icon: '👑', color: '#5a7fd4' },
  { id: 'science',  commodity: 'paper', icon: '🔬', color: '#5ac47a' }
];
const CK_COMMODITY_ICON = { cloth: '🧵', coin: '🪙', paper: '📜' };

function openCityImprovementsModal() {
  const p = state.players[state.currentPlayerIndex];
  const list = document.getElementById('city-improvements-list');
  list.innerHTML = CK_TRACKS.map(tr => {
    const level = p.cityImprovements?.[tr.id] || 0;
    const have  = p.commodities?.[tr.commodity] || 0;
    const maxed = level >= 5;
    const nextLevel = level + 1;
    const cost = nextLevel;
    // Official rule: no city-count cap on levels. An "available city" (one
    // that is not already a metropolis) is required only when this purchase
    // would found or seize the metropolis — mirror of the server check.
    const holder = state.metropolises?.[tr.id] || null;
    const holderLevel = holder ? (state.players[holder.playerId]?.cityImprovements?.[tr.id] || 0) : 0;
    const grantsMetro = (!holder || holder.playerId !== p.id) && nextLevel > holderLevel;
    const metroVertices = new Set(Object.values(state.metropolises||{}).filter(Boolean).map(m => m.vertexId));
    const hasAvailableCity = (p.cities||[]).some(v => !metroVertices.has(v));
    const needsCity = nextLevel >= 4 && grantsMetro && !hasAvailableCity;
    const cantAfford = have < cost;
    const disabled = maxed || needsCity || cantAfford;
    const holdsMetro = holder?.playerId === p.id;
    const dots = Array.from({length:5}, (_,i)=>`<span class="ck-dot${i<level?' filled':''}"></span>`).join('');
    const trackName = skinLabel(`ck_track_${tr.id}`, t(`ck_track_${tr.id}`) || tr.id);
    let reason = '';
    if (maxed) reason = t('ck_maxed') || 'MAX';
    else if (needsCity) reason = t('ck_need_city') || 'Serve una città non-metropoli';
    else if (cantAfford) reason = `${CK_COMMODITY_ICON[tr.commodity]} ${cost-have} ${t('ck_missing')||'mancanti'}`;
    return `
      <div class="ck-track-row">
        <div class="ck-track-header">
          <span class="ck-track-name">${tr.icon} ${trackName}</span>
          ${holdsMetro ? `<span class="ck-metro-badge" data-tip="${t('ck_metropolis')||'Metropoli'}">🏛️</span>` : ''}
        </div>
        <div class="ck-track-dots">${dots}</div>
        <div class="ck-track-footer">
          <span class="ck-track-commodity" data-tip="${commodityName(tr.commodity)}">${CK_COMMODITY_ICON[tr.commodity]} ${have}</span>
          <button class="dev-card-btn${disabled?'':' playable'}" ${disabled?'disabled':''}
            onclick="buyCityImprovement('${tr.id}')">
            ${maxed ? (t('ck_maxed')||'MAX') : `${t('ck_buy')||'Compra'} ${CK_COMMODITY_ICON[tr.commodity]}${cost}`}
          </button>
          ${(!maxed && disabled) ? `<span class="ck-reason">${reason}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  openModal('modal-city-improvements');
}
window.buyCityImprovement = track => {
  send({ type: 'BUY_CITY_IMPROVEMENT', track });
  // The modal is refreshed by the state-update handler when the server
  // broadcast lands (re-rendering immediately from local state showed
  // stale dots: the display lagged one purchase behind).
};

// ===================================================================
//  CITIES & KNIGHTS — KNIGHT ACTIONS MODAL
//  Clicking a vertex with one of your own knights (outside any build
//  mode) opens this modal, listing whichever actions are currently
//  valid for that specific knight.
// ===================================================================
function openKnightActionsModal(vertexId) {
  const player = state.players[state.currentPlayerIndex];
  const knight = player.knights?.find(k => k.vertexId === vertexId);
  if (!knight) return;

  const RANKS = ['basic','strong','mighty'];
  const RANK_VAL = { basic:1, strong:2, mighty:3 };
  const idx = RANKS.indexOf(knight.rank);
  const canAffordKnightCost = (player.resources.sheep||0)>=1 && (player.resources.ore||0)>=1;
  const canAffordActivate   = (player.resources.wheat||0)>=1;
  const politicsLvl = player.cityImprovements?.politics || 0;

  const vertex = state.board.vertices[vertexId];
  const adjacentToRobber = vertex.adjHexes.includes(state.robberHexId);

  // Is there a weaker enemy knight on an adjacent, road-connected vertex?
  let canDisplace = false;
  for (const eid of vertex.adjEdges) {
    const e = state.board.edges[eid];
    if (e.owner === null) continue;
    const otherId = e.v1===vertexId ? e.v2 : e.v1;
    for (const p of state.players) {
      if (p.id === player.id) continue;
      const ek = p.knights?.find(k=>k.vertexId===otherId);
      if (ek && RANK_VAL[knight.rank] > RANK_VAL[ek.rank]) { canDisplace = true; break; }
    }
    if (canDisplace) break;
  }

  const rankName = t(`ck_knight_${knight.rank}`) || knight.rank;
  const actions = [];

  if (!knight.active) {
    actions.push(`<button class="dev-card-btn${canAffordActivate?' playable':''}" ${canAffordActivate?'':'disabled'} onclick="knightAction('activate',${vertexId})">🌾 ${t('ck_activate')||'Attiva'} <small>(1🌾)</small></button>`);
  }
  if (idx < RANKS.length - 1) {
    const nextRank = RANKS[idx+1];
    const politicsBlocked = nextRank==='mighty' && politicsLvl < 3;
    const disabled = politicsBlocked || !canAffordKnightCost;
    const reason = politicsBlocked ? (t('ck_need_politics')||'Richiede Politica liv.3')
                 : (!canAffordKnightCost ? (t('ck_missing')||'risorse insufficienti') : '');
    actions.push(`<button class="dev-card-btn${disabled?'':' playable'}" ${disabled?'disabled':''} onclick="knightAction('promote',${vertexId})">⬆️ ${t('ck_promote')||'Promuovi'} <small>(1🐑1🪨)</small>${reason?`<div class="ck-reason">${reason}</div>`:''}</button>`);
  }
  if (knight.active && !knight.usedActionThisTurn) {
    actions.push(`<button class="dev-card-btn playable" onclick="knightStartMove(${vertexId})">🚶 ${t('ck_move')||'Muovi'}</button>`);
    if (adjacentToRobber) actions.push(`<button class="dev-card-btn playable" onclick="knightStartChase(${vertexId})">🦹 ${t('ck_chase_robber')||'Scaccia il Brigante'}</button>`);
    if (canDisplace) actions.push(`<button class="dev-card-btn playable" onclick="knightStartDisplace(${vertexId})">⚔️ ${t('ck_displace')||'Respingi Cavaliere'}</button>`);
  }
  if (!actions.length) actions.push(`<div class="ck-reason">${t('ck_no_actions')||'Nessuna azione disponibile per questo cavaliere ora'}</div>`);

  document.getElementById('knight-actions-list').innerHTML = `
    <div class="ck-track-header">
      <span class="ck-track-name">${KNIGHT_EMOJI[knight.rank]} ${rankName}</span>
      <span class="ck-metro-badge">${knight.active ? (t('ck_active')||'Attivo') : (t('ck_inactive')||'Inattivo')}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${actions.join('')}</div>
  `;
  openModal('modal-knight-actions');
}

window.knightAction = (action, vertexId) => {
  if (action==='activate') send({ type:'ACTIVATE_KNIGHT', vertexId });
  else if (action==='promote') send({ type:'PROMOTE_KNIGHT', vertexId });
  closeAllModals();
  setTimeout(() => {
    const stillOwned = state.players[state.currentPlayerIndex]?.knights?.some(k=>k.vertexId===vertexId);
    if (stillOwned) openKnightActionsModal(vertexId);
  }, 150);
};
window.knightStartMove = vertexId => {
  knightActionFrom = vertexId; buildMode = 'knight_move_target';
  closeAllModals(); renderBoard(); updateButtonStates();
  showGameToast(t('ck_pick_destination')||'Scegli la destinazione sulla mappa', '', 4000);
};
window.knightStartChase = vertexId => {
  knightActionFrom = vertexId; buildMode = 'knight_chase_target';
  closeAllModals(); renderBoard(); updateButtonStates();
  showGameToast(t('ck_pick_hex')||"Scegli l'esagono su cui spostare il brigante", '', 4000);
};
window.knightStartDisplace = vertexId => {
  knightActionFrom = vertexId; buildMode = 'knight_displace_target';
  closeAllModals(); renderBoard(); updateButtonStates();
  showGameToast(t('ck_pick_enemy')||'Scegli il cavaliere nemico da respingere', '', 4000);
};
window.openProgressHandModal = playerId => {
  const p = state.players[playerId];
  document.getElementById('progress-hand-title').textContent = `📗 Carte di ${p.name}`;
  const list = document.getElementById('progress-hand-list');
  if (!p.progressCards.length) {
    list.innerHTML = `<div class="ck-reason">Nessuna carta</div>`;
  } else {
    list.innerHTML = p.progressCards.map(c => `
      <div class="ck-track-row" style="padding:8px 12px">
        <span class="ck-track-name">${PROGRESS_COLOR_ICON[c.color]||'📗'} ${PROGRESS_CARD_NAMES[c.type]||c.type}</span>
      </div>`).join('');
  }
  openModal('modal-progress-hand');
};

// Cities & Knights: mandatory discard down to the 4-card progress-hand limit
let progressDiscardSelected = [];
function showProgressDiscardModal(playerId) {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  document.getElementById('progress-discard-title').textContent = `📗 ${p.name} deve scartare`;
  document.getElementById('progress-discard-info').textContent =
    `Scarta ${excess} cart${excess>1?'e':'a'} (hai ${p.progressCards.length}, il limite è 4)`;
  progressDiscardSelected = [];
  renderProgressDiscardList(playerId);
  openModal('modal-progress-discard');
}
function renderProgressDiscardList(playerId) {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  document.getElementById('progress-discard-list').innerHTML = p.progressCards.map((c,idx) => {
    const selected = progressDiscardSelected.includes(idx);
    return `<div class="ck-track-row" style="padding:8px 12px;cursor:pointer;${selected?'border-color:#dc3c3c':''}" onclick="toggleProgressDiscardCard(${idx},${playerId})">
      <span class="ck-track-name">${selected?'✅ ':''}${PROGRESS_COLOR_ICON[c.color]||'📗'} ${PROGRESS_CARD_NAMES[c.type]||c.type}</span>
    </div>`;
  }).join('');
  const btn = document.getElementById('btn-progress-discard-confirm');
  btn.disabled = progressDiscardSelected.length !== excess;
  btn.onclick = () => {
    send({ type: 'DISCARD_PROGRESS_CARDS', playerId, indices: progressDiscardSelected });
    closeAllModals();
  };
}
window.toggleProgressDiscardCard = (idx, playerId) => {
  const p = state.players[playerId];
  const excess = p.progressCards.length - 4;
  const pos = progressDiscardSelected.indexOf(idx);
  if (pos >= 0) progressDiscardSelected.splice(pos, 1);
  else if (progressDiscardSelected.length < excess) progressDiscardSelected.push(idx);
  renderProgressDiscardList(playerId);
};

// Cities & Knights: tied Defender of Catan — pick a progress-card color
function showDefenderChoiceModal(playerId) {
  const p = state.players[playerId];
  document.getElementById('defender-choice-title').textContent = `🛡️ ${p.name}`;
  document.getElementById('defender-choice-list').innerHTML =
    ['trade','politics','science'].map(c =>
      `<div class="ck-track-row" style="padding:8px 12px;cursor:pointer" onclick="pickDefenderColor(${playerId},'${c}')">
        <span class="ck-track-name">${PROGRESS_COLOR_ICON[c]||'📗'} ${t('ck_track_'+c) || c}</span>
      </div>`).join('');
  openModal('modal-defender-choice');
}
window.pickDefenderColor = (playerId, color) => {
  send({ type: 'CHOOSE_DEFENDER_PROGRESS', playerId, color });
  closeAllModals();
};

// Year of Plenty
let yopChoices=[];
function openYOPModal() {
  yopChoices=[];
  const res=['wood','brick','sheep','wheat','ore'];
  document.getElementById('yop-resources').innerHTML=res.map(r=>`<button class="res-pick-btn" data-res="${r}" onclick="toggleYOP('${r}')"><span class="res-emoji">${resEmoji(r)}</span><span>${resName(r)}</span></button>`).join('');
  openModal('modal-yop');
}
window.toggleYOP=res=>{ yopChoices.includes(res)?yopChoices=yopChoices.filter(r=>r!==res):yopChoices.length<2&&yopChoices.push(res); document.querySelectorAll('#yop-resources .res-pick-btn').forEach(b=>b.classList.toggle('selected',yopChoices.includes(b.dataset.res))); };
document.getElementById('btn-yop-confirm')?.addEventListener('click',()=>{ if(yopChoices.length!==2) return alert(t('choose_2_yop')||'Choose 2 resources'); send({type:'PLAY_DEV_CARD',cardType:'yearOfPlenty',params:{resources:yopChoices}}); closeAllModals(); });

// Monopoly
function openMonopolyModal() {
  const res=['wood','brick','sheep','wheat','ore'];
  document.getElementById('monopoly-resources').innerHTML=res.map(r=>`<button class="res-pick-btn" onclick="playMonopoly('${r}')"><span class="res-emoji">${resEmoji(r)}</span><span>${resName(r)}</span></button>`).join('');
  openModal('modal-monopoly');
}
window.playMonopoly=res=>{ send({type:'PLAY_DEV_CARD',cardType:'monopoly',params:{resource:res}}); closeAllModals(); };

// ================================================================// ===================================================================
//  PLAYER TRADE MODAL  — target-first, side-by-side resources
// ===================================================================
let ptOffer  = {wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
let ptWant   = {wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
let ptTarget = null; // currently selected target player id

const RES_LIST = ['wood','brick','sheep','wheat','ore'];
const CK_TRADE_COMMODITIES = ['paper','cloth','coin'];
const CK_TRADE_COMMODITY_ICON = { paper:'📜', cloth:'🧵', coin:'🪙' };

// Cities & Knights: progress card display names and per-color icon.
// Names are Italian-only for now (no card is playable yet — this is the
// minimal viewer needed to test the draw mechanism; proper per-language
// names + effects come with the playable-card phases).
const PROGRESS_CARD_NAMES = {
  merchant:'Mercante', resourceMonopoly:'Monopolio Risorsa', commercialHarbor:'Porto Commerciale',
  masterMerchant:'Gran Mercante', merchantFleet:'Flotta Mercantile', tradeMonopoly:'Monopolio Commercio',
  spy:'Spia', bishop:'Vescovo', deserter:'Disertore', diplomat:'Diplomatico', intrigue:'Intrigo',
  saboteur:'Sabotatore', warlord:'Signore della Guerra', wedding:'Matrimonio', constitution:'Costituzione',
  alchemist:'Alchimista', crane:'Gru', inventor:'Inventore', irrigation:'Irrigazione', medicine:'Medicina',
  mining:'Miniera', roadBuilding:'Costruzione Strade', smith:'Fabbro', engineer:'Ingegnere', printer:'Stampa'
};
const PROGRESS_COLOR_ICON = { trade:'🟡', politics:'🔵', science:'🟢' };
// Which pool (resources or commodities) a trade-row key belongs to
function tradePool(player, key) {
  return CK_TRADE_COMMODITIES.includes(key) ? (player.commodities||{}) : (player.resources||{});
}

function openPlayerTradeModal() {
  ptOffer  = {wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
  ptWant   = {wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0};
  ptTarget = null;

  renderPTFull();
  openModal('modal-trade-player');
}

function renderPTFull() {
  const me = state.players[state.currentPlayerIndex];
  const others = state.players.filter(p => p.id !== me.id);

  // ── Target selector tabs ──
  const targetsHtml = others.map(p => `
    <button class="pt-target-tab ${ptTarget===p.id?'active':''}"
            style="--pcol:${p.color}"
            onclick="selectPTTarget(${p.id})">
      <span class="pt-target-dot" style="background:${p.color}"></span>
      ${escHtml(p.name)}
    </button>`).join('');

  // ── Resource rows (side by side: my amounts | res | their amounts) ──
  const target = ptTarget !== null ? state.players[ptTarget] : null;
  const blind    = state.hiddenResources ?? false;

  function buildRow(r, icon, label, isCommodity) {
    const myPool    = tradePool(me, r);
    const targetPool = target ? tradePool(target, r) : null;
    const myHave    = myPool[r]||0;
    const theirHave = target ? (blind ? '?' : (targetPool[r]||0)) : '—';
    const wantMax   = target ? (blind ? 99 : (targetPool[r]||0)) : 0;
    const offerVal  = ptOffer[r]||0;
    const wantVal   = ptWant[r]||0;
    return `
    <div class="pt-row">
      <div class="pt-side pt-side-me">
        <span class="pt-count ${myHave>0?'has':'zero'}">${myHave}</span>
        <div class="stepper">
          <button onclick="changePT('offer','${r}',-1)">−</button>
          <span id="pt-offer-${r}" class="${offerVal>0?'pt-active':''}">${offerVal}</span>
          <button onclick="changePT('offer','${r}',1)" ${offerVal>=myHave?'disabled':''}>+</button>
        </div>
      </div>
      <div class="pt-res-center">
        <span class="pt-emoji">${icon}</span>
        <span class="pt-resname">${label}</span>
      </div>
      <div class="pt-side pt-side-them">
        <div class="stepper">
          <button onclick="changePT('want','${r}',-1)" ${!target?'disabled':''}>−</button>
          <span id="pt-want-${r}" class="${wantVal>0?'pt-active':''}">${wantVal}</span>
          <button onclick="changePT('want','${r}',1)" ${!target||wantVal>=wantMax?'disabled':''}>+</button>
        </div>
        <span class="pt-count ${target&&!blind&&(targetPool[r]||0)>0?'has':'zero'}">${theirHave}</span>
      </div>
    </div>`;
  }

  const rows = RES_LIST.map(r => buildRow(r, resEmoji(r), resName(r), false)).join('');
  const commodityRows = state.citiesKnights
    ? CK_TRADE_COMMODITIES.map(c => buildRow(c, CK_TRADE_COMMODITY_ICON[c], commodityName(c), true)).join('')
    : '';

  const targetTotalCards = target
    ? Object.values(target.resources||{}).reduce((a,b)=>a+b,0) + (state.citiesKnights ? Object.values(target.commodities||{}).reduce((a,b)=>a+b,0) : 0)
    : '';
  const headerRight = target
    ? `<span style="color:${target.color}">${escHtml(target.name)}</span>${(state.hiddenResources??false) ? '' : (' ' + t('pt_have', targetTotalCards))}`
    : `<span class="muted">${t('choose_player')}</span>`;

  document.getElementById('player-trade-offer').innerHTML = `
    <div class="pt-col-headers">
      <div class="pt-header-me"><span style="color:${me.color}">${escHtml(me.name)}</span> ${t('offer_label')} / ${t('give_label').replace(':','')}</div>
      <div class="pt-header-res"></div>
      <div class="pt-header-them">${headerRight}</div>
    </div>
    ${rows}
    ${commodityRows ? `<div class="drawer-section-title" style="margin:10px 0 4px">${t('sec_city_improvements')||'Città & Cavalieri'}</div>${commodityRows}` : ''}`;

  document.getElementById('player-trade-want').innerHTML = '';

  document.getElementById('player-trade-targets').innerHTML = `
    <div class="pt-target-row">${targetsHtml}</div>
    ${target ? `<button class="big-btn primary pt-send-btn" onclick="sendTradeOffer(${ptTarget})">
      Proponi a <span style="color:${target.color}">${escHtml(target.name)}</span>
    </button>` : ''}`;
}

window.selectPTTarget = id => { ptTarget = id; ptWant={wood:0,brick:0,sheep:0,wheat:0,ore:0,paper:0,cloth:0,coin:0}; renderPTFull(); };

window.changePT = (side, res, delta) => {
  const me = state.players[state.currentPlayerIndex];
  const target = ptTarget !== null ? state.players[ptTarget] : null;
  const blind = state.hiddenResources ?? false;
  if (side === 'offer') {
    const max = tradePool(me, res)[res]||0;
    ptOffer[res] = Math.max(0, Math.min(max, (ptOffer[res]||0) + delta));
  } else {
    if (!target) return;
    const max = blind ? 99 : (tradePool(target, res)[res]||0);
    ptWant[res] = Math.max(0, Math.min(max, (ptWant[res]||0) + delta));
  }
  renderPTFull();
};

window.sendTradeOffer = targetId => {
  const offer = Object.fromEntries(Object.entries(ptOffer).filter(([,v])=>v>0));
  const want  = Object.fromEntries(Object.entries(ptWant) .filter(([,v])=>v>0));
  if (!Object.keys(offer).length) return showTradeError(t('trade_error_offer'));
  if (!Object.keys(want).length)  return showTradeError(t('trade_error_want'));
  const me = state.players[state.currentPlayerIndex];
  for (const [r,a] of Object.entries(offer)) {
    const pool = tradePool(me, r);
    const icon = CK_TRADE_COMMODITIES.includes(r) ? CK_TRADE_COMMODITY_ICON[r] : resEmoji(r);
    if ((pool[r]||0) < a) return showTradeError('Non hai abbastanza ' + icon + ' ' + r);
  }
  // Manda proposta al server — il server salva pendingTrade e lo stato torna a tutti
  // checkModals() aprirà la modale accettazione quando arriva il nuovo state
  send({ type:'TRADE_PLAYER', fromId: state.currentPlayerIndex, toId: targetId, offer, want });
  closeAllModals();
};

function showTradeError(msg) {
  const el = document.getElementById('trade-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(()=>el.style.display='none', 3000); }
  else alert(msg);
}
function showTradeAcceptModal(targetId, offer, want, fromId) {
  const fromIdx = fromId !== undefined ? fromId : state.currentPlayerIndex;
  const from = state.players[fromIdx];
  const to   = state.players[targetId];
  const blind = state.hiddenResources ?? false;

  const chipIcon = r => CK_TRADE_COMMODITIES.includes(r) ? CK_TRADE_COMMODITY_ICON[r] : resEmoji(r);
  const chipName = r => CK_TRADE_COMMODITIES.includes(r) ? commodityName(r) : resName(r);
  const fmtRes = obj => Object.entries(obj||{})
    .filter(([,a])=>+a>0)
    .map(([r,a])=>`<span class="trade-res-chip">${a}× ${chipIcon(r)||r} <small>${chipName(r)}</small></span>`)
    .join('') || '—';

  // In blind mode: recipient checks only their own resources (what they must give = want)
  // In normal mode: also check from's resources client-side
  const toMissing = Object.entries(want)
    .filter(([r,a])=>(tradePool(to, r)[r]||0) < parseInt(a))
    .map(([r,a])=>`${chipIcon(r)} ${r}: ha ${tradePool(to, r)[r]||0}, serve ${a}`);

  document.getElementById('trade-accept-title').innerHTML =
    `<span style="color:${from.color}">⚡ ${escHtml(from.name)}</span> propone a <span style="color:${to.color}">${escHtml(to.name)}</span>`;

  document.getElementById('trade-accept-details').innerHTML = `
    <div class="trade-summary">
      <div class="trade-summary-side">
        <div class="trade-summary-label" style="color:${from.color}">${escHtml(from.name)} dà</div>
        <div class="trade-chips">${fmtRes(offer)}</div>
      </div>
      <div class="trade-summary-arrow">⇄</div>
      <div class="trade-summary-side">
        <div class="trade-summary-label" style="color:${to.color}">${escHtml(to.name)} dà</div>
        <div class="trade-chips">${fmtRes(want)}</div>
      </div>
    </div>
    ${toMissing.length ? `<div class="trade-warning">⚠️ ${escHtml(to.name)} non ha: ${toMissing.join(', ')}</div>` : ''}
    <p class="trade-confirm-prompt" style="color:${to.color};margin-top:12px;font-weight:bold">
      ${escHtml(to.name)}, accetti questo scambio?
    </p>`;

  document.getElementById('btn-trade-accept').style.display = toMissing.length ? 'none' : '';
  document.getElementById('btn-trade-accept').onclick = () => {
    send({ type:'TRADE_PLAYER', fromId:from.id, toId:targetId, offer, want, accepted:true });
    closeAllModals();
  };
  document.getElementById('btn-trade-reject').textContent = toMissing.length ? t('close_btn') : t('reject_btn');
  document.getElementById('btn-trade-reject').onclick = () => {
    send({ type:'TRADE_PLAYER', fromId:from.id, toId:targetId, rejected:true });
    closeAllModals();
  };
  openModal('modal-trade-accept');
}

// ===================================================================
//  WINNER MODAL
// ===================================================================
function showWinner() {
  if (document.getElementById('modal-winner').classList.contains('open')) return;
  const w=state.players[state.winner];
  document.getElementById('winner-content').innerHTML=`<span class="winner-emoji">🏆</span><span style="color:${w.color};font-size:1.6rem">${escHtml(w.name)}</span><br>${t('winner_text',w.name,w.points)}`;
  // Clean up any lingering UI elements
  diceAnimating = false;
  document.body.classList.remove('gain-blocking');
  const dismiss = document.getElementById('gain-dismiss');
  if (dismiss) { dismiss.classList.remove('visible'); dismiss.style.display='none'; }
  const gainPopups = document.getElementById('gain-popups');
  if (gainPopups) gainPopups.innerHTML = '';
  openModal('modal-winner');
}

// ===================================================================
//  MODAL / SCREEN UTILS
// ===================================================================
function openModal(id) { document.getElementById(id).classList.add('open'); }
window.closeAllModals=()=>document.querySelectorAll('.modal').forEach(m=>m.classList.remove('open'));

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (_isMobile) {
    if (id === 'game-screen') { document.body.classList.add('ui-xlarge'); }
    else { document.body.classList.remove('ui-xlarge','ui-large'); }
  }
}

// ===================================================================
//  COLOR UTILS
// ===================================================================
function lighten(hex,pct){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),f=pct/100; return `rgb(${Math.min(255,r+f*200)},${Math.min(255,g+f*200)},${Math.min(255,b+f*200)})`; }
function darken(hex,pct) { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),f=pct/100; return `rgb(${Math.max(0,r-f*200)},${Math.max(0,g-f*200)},${Math.max(0,b-f*200)})`; }
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===================================================================
//  PLAYER RENAME (runtime)
// ===================================================================
function promptRenamePlayer(playerId) {
  if (window.__SPECTATOR_MODE) return;
  const p = state?.players?.[playerId];
  if (!p) return;
  // Admin can rename anyone; web player can only rename themselves
  if (WEB_PLAYER_ID !== null && WEB_PLAYER_ID !== playerId) return;
  const newName = prompt(t('rename_prompt', p.name), p.name);
  if (newName && newName.trim() && newName.trim() !== p.name) {
    send({ type: 'RENAME_PLAYER', playerId, name: newName.trim() });
  }
}

// ===================================================================
//  QR CODE + MOBILE PAIRING
// ===================================================================



async function showSpectatorQR() {
  const joinUrl = `${location.origin}/?pin=${currentPin}&lang=${LANG}`;
  try {
    const res = await fetch('/api/generate-qr', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url: joinUrl })
    });
    const data = await res.json();
    showSpectatorQRModal(joinUrl, data.qrDataUrl);
  } catch(e) {
    showSpectatorQRModal(joinUrl, null);
  }
}

function showSpectatorQRModal(url, qrDataUrl) {
  document.getElementById('spec-qr-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'spec-qr-modal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:500;
    display:flex;align-items:center;justify-content:center;`;
  modal.onclick = () => modal.remove();
  modal.innerHTML = `
    <div onclick="event.stopPropagation()" style="background:#1a1200;border:2px solid rgba(200,164,74,.4);
      border-radius:16px;padding:24px;text-align:center;max-width:320px">
      <h3 style="color:#c8a44a;margin:0 0 12px">📱 Unisciti alla partita</h3>
      ${qrDataUrl ? `<img src="${qrDataUrl}" style="width:220px;height:220px;border-radius:10px">` : ''}
      <p style="color:#5a4a2a;font-size:.7rem;margin:10px 0 4px;word-break:break-all">${url}</p>
      <button onclick="navigator.clipboard?.writeText('${url}');this.textContent='✅ Copiato!';setTimeout(()=>this.textContent='📋 Copia link',2000)"
        style="background:rgba(200,164,74,.2);border:1px solid rgba(200,164,74,.4);color:#c8a44a;
        border-radius:8px;padding:6px 16px;cursor:pointer;margin-top:8px">📋 Copia link</button>
      <br><button onclick="document.getElementById('spec-qr-modal').remove()"
        style="background:rgba(200,164,74,.15);border:1px solid rgba(200,164,74,.3);color:#c8a44a;
        border-radius:8px;padding:6px 16px;cursor:pointer;margin-top:8px">✕ Chiudi</button>
    </div>`;
  document.body.appendChild(modal);
}

async function showQRForPlayer(playerIdx) {
  if (window.__SPECTATOR_MODE) { showSpectatorQR(); return; }
  const name = document.getElementById(`pname-${playerIdx}`)?.value?.trim()
             || t('player_n', playerIdx + 1);
  try {
    const res  = await fetch('/api/generate-token', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ playerIndex: playerIdx, playerName: name, pin: currentPin, lang: LANG })
    });
    const data = await res.json();
    currentQRLink  = data.mobileUrl;
    currentWebLink = data.webUrl; // same token, points to main web client

    document.getElementById('qr-title').textContent       = t('add_player_title') || '➕ Add a player';
    document.getElementById('qr-player-name').textContent = name;
    document.getElementById('qr-image').src               = data.qrDataUrl;
    document.getElementById('qr-url').textContent         = data.mobileUrl;
    document.getElementById('qr-web-url').textContent     = currentWebLink;
    switchQRTab('phone'); // always start on phone tab
    openModal('modal-qr');
  } catch(e) {
    alert('Cannot generate QR: ' + e.message);
  }
}

function switchQRTab(tab) {
  document.getElementById('qr-tab-phone').classList.toggle('hidden', tab !== 'phone');
  document.getElementById('qr-tab-web').classList.toggle('hidden', tab !== 'web');
  document.getElementById('qr-tab-phone').classList.toggle('active', tab === 'phone');
  document.getElementById('qr-tab-web').classList.toggle('active', tab === 'web');
}

function copyQRLink(type) {
  const link = type === 'web' ? currentWebLink : currentQRLink;
  const btnId = type === 'web' ? 'qr-copy-web-btn' : 'qr-copy-btn';
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById(btnId);
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    const el = document.getElementById(type === 'web' ? 'qr-web-url' : 'qr-url');
    const range = document.createRange();
    range.selectNode(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
}

// ===================================================================
//  INIT
// ===================================================================
// Apply default scale (Maxi) — on mobile only when entering game-screen
if (!_isMobile) document.body.classList.add("ui-xlarge");
// ── Check URL params FIRST ──
// Close all modals immediately on page load (may be stale from previous session)
document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));

// Mobile detection moved to top of file

const _urlParams  = new URLSearchParams(location.search);
const urlPin      = _urlParams.get('pin');
const urlPlayerId = _urlParams.get('playerId');
const urlLang     = _urlParams.get('lang');
const rejoinPin   = (urlPin && /^\d{5}$/.test(urlPin)) ? urlPin : null;

// Apply language from URL if present
if (urlLang && ['en','it','fr','de'].includes(urlLang)) {
  setLang(urlLang);
  applyTranslations();
}

// ── Load available skins ──────────────────────────────────────────
async function loadSkins() {
  try {
    const res = await fetch('/api/skins');
    if (!res.ok) return;
    const skins = await res.json();
    window._availableSkins = skins;
    renderSkins();
  } catch(e) { /* skins not available */ }
}

function renderSkins() {
  const skins = window._availableSkins;
  if (!skins || skins.length <= 1) return;
  const container = document.getElementById('skin-selector');
  const cards = document.getElementById('skin-cards');
  if (!container || !cards) return;

  // Show skins with no lang (universal) or matching current lang
  const filtered = skins.filter(s => !s.lang || s.lang === LANG);

  // If current selection is now hidden, reset to standard
  if (selectedSkinId && selectedSkinId !== 'standard' && !filtered.find(s => s.id === selectedSkinId)) {
    selectSkin('standard');
  }

  container.style.display = filtered.length > 1 ? 'flex' : 'none';
  cards.innerHTML = filtered.map(s => `
    <div class="skin-card ${s.id===(selectedSkinId||'standard')?'active':''}" data-skin="${s.id}"
         onclick="selectSkin('${s.id}')">
      ${s.preview ? `<img src="${s.preview}" class="skin-preview" alt="${s.name}">` : '<div class="skin-preview-placeholder">🎨</div>'}
      <span>${s.name}</span>
    </div>`).join('');
}

loadSkins();

window.toggleDebugRes = function() {
  debugResources = !debugResources;
  document.getElementById('dbg-res')?.classList.toggle('active', debugResources);
};
window.toggleDebugSkipSetup = function() {
  debugSkipSetup = !debugSkipSetup;
  document.getElementById('dbg-skip-setup')?.classList.toggle('active', debugSkipSetup);
};
window.setDebugDice = function(val) {
  debugForceDice = val || null;
};

window.setDebugCard = function(type) {
  debugDevCard = type;
  ['none','monopoly','knight','road','yop','vp'].forEach(k => {
    document.getElementById('dbg-'+k)?.classList.toggle('active',
      (type===null&&k==='none')||(type==='roadBuilding'&&k==='road')||(type==='yearOfPlenty'&&k==='yop')||(type==='victoryPoint'&&k==='vp')||type===k);
  });
};

window.selectSkin = function(id) {
  selectedSkinId = id;
  document.querySelectorAll('.skin-card').forEach(c => c.classList.toggle('active', c.dataset.skin===id));
};

// ── Auto-detect browser language ──────────────────────────────────
(function detectLang() {
  // Skip if URL already specifies a language
  if (_urlParams.get('lang')) return;
  const supported = ['it','fr','de','en'];
  const browserLang = (navigator.language || navigator.userLanguage || 'en')
    .toLowerCase().slice(0,2);
  const detected = supported.includes(browserLang) ? browserLang : 'en';
  if (detected !== 'en') {
    setLang(detected);
    // Update active button
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === detected);
    });
  }
})();

initDiceButton();
if (window.__TV_MODE) buildTVIcons();

// Spectator mode: skip setup screen and auto-connect handled by spectator.html
if (!window.__SPECTATOR_MODE) {
  initSetupScreen(rejoinPin);

  if (rejoinPin && _urlParams.get('token')) {
    currentPin = rejoinPin;
    (async () => {
      try {
        const r = await fetch(`/api/validate-token?token=${_urlParams.get('token')}&pin=${rejoinPin}`);
        const info = await r.json();
        if (info.playerId !== undefined) {
          WEB_PLAYER_ID = info.playerId;
          history.replaceState({}, '', `?pin=${currentPin}&lang=${urlLang||LANG}`);
          // If game not yet started, show waiting screen
          if (!info.gameActive) {
            const nameEl = document.getElementById('waiting-player-name');
            if (nameEl) nameEl.textContent = info.playerName || '';
            showScreen('waiting-screen');
          }
        }
      } catch(e) {}
      connectWS();
      resizeCanvas();
    })();
  } else if (rejoinPin) {
    currentPin = rejoinPin;
    // Pre-fill the join PIN input so user sees what's happening
    const joinInput = document.getElementById('join-pin-input');
    if (joinInput) joinInput.value = rejoinPin;
    connectWS();
    resizeCanvas();
  } else {
    connectWS();
    resizeCanvas();
  }
}

// ===================================================================
//  DICE ANIMATION SYSTEM
// ===================================================================

// diceAnimating declared at top of file
let diceHighlightHexes = []; // hex ids to flash after dice roll
let diceHighlightTimer = null;

// Called when ROLL_DICE is clicked — intercept and animate
function initDiceButton() {
  document.getElementById('btn-roll')?.addEventListener('click', () => {
    if (diceAnimating) return;
    send({ type: 'ROLL_DICE' });
  });
}

// Called from onMessage when new state arrives with fresh dice values
function handleDiceRollAnimation(newState, prevDiceRolled) {
  if (newState.winner !== null) return; // game over, skip animation
  if (!newState) return;
  // Detect a fresh dice roll: was not rolled before, now is rolled
  if (!prevDiceRolled && newState.diceRolled && newState.diceValues[0]) {
    const d1 = newState.diceValues[0], d2 = newState.diceValues[1];
    const total = d1 + d2;
    startDiceAnimation(d1, d2, total, newState);
  }
}

function startDiceAnimation(d1, d2, total, gameState) {
  diceAnimating = true; // may already be true from onMessage, that's fine

  // ── Phase 1: show big overlay with rolling dice ──
  const overlay = document.getElementById('dice-overlay');
  const bigD1   = document.getElementById('dice-big-1');
  const bigD2   = document.getElementById('dice-big-2');
  const diceSum = document.getElementById('dice-sum');

  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  bigD1.classList.add('rolling');
  bigD2.classList.add('rolling');
  bigD1.textContent = '?';
  bigD2.textContent = '?';
  diceSum.textContent = '';
  diceSum.classList.remove('visible');

  // Animate random faces while "rolling"
  let ticks = 0;
  const rollInterval = setInterval(() => {
    bigD1.textContent = dieChar(Math.floor(Math.random()*6)+1);
    bigD2.textContent = dieChar(Math.floor(Math.random()*6)+1);
    ticks++;
    if (ticks >= 10) {
      clearInterval(rollInterval);
      // ── Phase 2: land on final values ──
      bigD1.textContent = dieChar(d1);
      bigD2.textContent = dieChar(d2);
      bigD1.classList.remove('rolling');
      bigD2.classList.remove('rolling');
      bigD1.classList.add('landed');
      bigD2.classList.add('landed');
      diceSum.textContent = `= ${total}`;
      diceSum.classList.add('visible');
      if (total === 7) diceSum.classList.add('seven');

      // ── Phase 3: after 1.5s, hide overlay and highlight hexes ──
      setTimeout(() => {
        overlay.classList.remove('visible');
        overlay.classList.add('hidden');
        bigD1.classList.remove('landed');
        bigD2.classList.remove('landed');
        diceSum.classList.remove('visible','seven');

        if (total !== 7) {
          // Find hexes that produce this number
          const producing = gameState.board.hexes.filter(h =>
            h.number === total && h.id !== gameState.robberHexId
          );
          if (producing.length > 0) {
            startHexFlash(producing.map(h => h.id), gameState);
          } else {
            diceAnimating = false;
            document.body.classList.remove('gain-blocking'); // no producers: unblock
          }
        } else {
          diceAnimating = false;
          document.body.classList.remove('gain-blocking'); // 7: no gain popup, remove blocking now
          // Reveal HUD dice after animation for 7 (no gain popup shown)
          if (state?.diceValues[0]) {
            document.getElementById('die1').textContent = dieChar(state.diceValues[0]);
            document.getElementById('die2').textContent = dieChar(state.diceValues[1]);
          }
        }
      }, 1600);
    }
  }, 80);
}

// Flash hexes, then show resource gain popups
function startHexFlash(hexIds, gameState) {
  diceHighlightHexes = hexIds;
  let flashCount = 0;
  const totalFlashes = 5;

  const flashInterval = setInterval(() => {
    if (!state) { clearInterval(flashInterval); diceHighlightHexes = []; return; }
    flashCount++;
    renderBoardWithHighlight(diceHighlightHexes, flashCount % 2 === 1);
    if (flashCount >= totalFlashes * 2) {
      clearInterval(flashInterval);
      diceHighlightHexes = [];
      renderBoard(); // restore normal
      // ── Phase 4: resource gain popups ──
      showResourceGainPopups(gameState);
    }
  }, 220);
}

function renderBoardWithHighlight(hexIds, lit) {
  if (!state) return;
  renderBoard();
  if (!hexIds.length) return;
  const hexSet = new Set(hexIds);
  for (const hex of state.board.hexes) {
    if (!hexSet.has(hex.id)) continue;
    const cx = px(hex.cx), cy = py(hex.cy);
    if (lit) {
      ctx.beginPath();
      for (let i=0;i<6;i++){
        const a=Math.PI/3*i-Math.PI/6;
        const vx=cx+HEX_SIZE*.96*Math.cos(a), vy=cy+HEX_SIZE*.96*Math.sin(a);
        i===0?ctx.moveTo(vx,vy):ctx.lineTo(vx,vy);
      }
      ctx.closePath();
      ctx.strokeStyle='#ffee44';
      ctx.lineWidth = HEX_SIZE * .12;
      ctx.stroke();
      // Inner glow
      ctx.fillStyle='rgba(255,238,68,.18)';
      ctx.fill();
    }
  }
}

// Resource gain popups + expanded left drawer
function showResourceGainPopups(gameState) {
  if (!gameState || !state) return; // guard against rejoin/reset
  // Don't show resource popups if game is over
  if (gameState.winner !== null) return;
  const total = gameState.diceValues[0] + gameState.diceValues[1];

  // ── Calculate gains (mirrors server _distributeResources, including the
  // Cities & Knights commodity split when that variant is on) ──
  const HEX_COMMODITY = { wood: 'paper', sheep: 'cloth', ore: 'coin' };
  const ck = !!gameState.citiesKnights;
  const gains = {};
  const commodityGains = {};
  for (const hex of gameState.board.hexes) {
    if (hex.number !== total || hex.id === gameState.robberHexId) continue;
    for (const vid of hex.vertices) {
      const v = gameState.board.vertices[vid];
      if (v.owner === null) continue;
      const isCity = v.building === 'city';
      if (!gains[v.owner]) gains[v.owner] = {};
      if (ck && isCity && HEX_COMMODITY[hex.resource]) {
        gains[v.owner][hex.resource] = (gains[v.owner][hex.resource]||0) + 1;
        const commodity = HEX_COMMODITY[hex.resource];
        if (!commodityGains[v.owner]) commodityGains[v.owner] = {};
        commodityGains[v.owner][commodity] = (commodityGains[v.owner][commodity]||0) + 1;
      } else {
        const amt = isCity ? 2 : 1;
        gains[v.owner][hex.resource] = (gains[v.owner][hex.resource]||0) + amt;
      }
    }
  }

  const anyGains = Object.keys(gains).length > 0 || Object.keys(commodityGains).length > 0;

  // ── Force-open left drawer and wait for CSS transition (280ms) ──
  drawerState.players = true;
  // Also close other drawers to give maximum space
  drawerState.actions = false;
  drawerState.log     = false;
  document.getElementById('drawer-actions')?.classList.remove('open');
  document.getElementById('tab-actions')?.classList.remove('open');
  document.getElementById('drawer-log')?.classList.remove('open');
  document.getElementById('tab-log')?.classList.remove('open');
  document.getElementById('drawer-players').classList.add('open');
  document.getElementById('tab-players').classList.add('open');

  // Recalculate board with new insets, redraw
  calcBoardTransform();
  renderBoard();

  // Block all interactive buttons while waiting for dismiss
  document.body.classList.add('gain-blocking');

  // Rebuild player cards with gain highlights
  renderPlayersWithGains(gameState, gains, commodityGains);

  // ── After drawer transition finishes, position floating badges ──
  const popupContainer = document.getElementById('gain-popups');
  popupContainer.innerHTML = '';

  setTimeout(() => {
    if (anyGains) {
      const panel = document.getElementById('players-panel');
      const cards = panel.querySelectorAll('.player-card');
      const CK_COMMODITY_ICON = { paper: '📜', cloth: '🧵', coin: '🪙' };
      for (const card of cards) {
        const pid = parseInt(card.dataset.pid);
        if (isNaN(pid) || (!gains[pid] && !commodityGains[pid])) continue;
        const rect = card.getBoundingClientRect();
        const pop  = document.createElement('div');
        pop.className = 'gain-popup';
        pop.style.left = (rect.right + 10) + 'px';
        pop.style.top  = (rect.top + rect.height / 2 - 24) + 'px';
        pop.style.borderColor = gameState.players[pid].color;
        const resPart = Object.entries(gains[pid]||{})
          .map(([r,a]) => `<span>+${a} ${resEmoji(r)}</span>`)
          .join('');
        const comPart = Object.entries(commodityGains[pid]||{})
          .map(([c,a]) => `<span>+${a} ${CK_COMMODITY_ICON[c]}</span>`)
          .join('');
        pop.innerHTML = resPart + comPart;
        popupContainer.appendChild(pop);
        requestAnimationFrame(() => pop.classList.add('visible'));
      }
    }

    // ── Show dismiss banner ──
    const dismiss = document.getElementById('gain-dismiss');
    dismiss.classList.add('visible');

    const onDismiss = () => {
      dismiss.classList.remove('visible');
      dismiss.removeEventListener('click', onDismiss);
      document.body.classList.remove('gain-blocking');
      document.querySelectorAll('.res-badge.gained').forEach(b => b.classList.remove('gained'));
      document.querySelectorAll('.gain-popup').forEach(p => p.classList.remove('visible'));
      setTimeout(() => {
        popupContainer.innerHTML = '';
        diceAnimating = false;
        // Now reveal the real dice values in the HUD
        if (state?.diceValues[0]) {
          document.getElementById('die1').textContent = dieChar(state.diceValues[0]);
          document.getElementById('die2').textContent = dieChar(state.diceValues[1]);
        }
        // Re-render to show correct active player
        render();
      }, 350);
    };
    dismiss.addEventListener('click', onDismiss);
  }, 320); // wait for drawer CSS transition (280ms) + small buffer
}

// Render player panel with gained resources highlighted
function renderPlayersWithGains(gameState, gains, commodityGains = {}) {
  const panel = document.getElementById('players-panel');
  panel.innerHTML = '';
  const curIdx = gameState.phase==='main' ? gameState.currentPlayerIndex
               : (gameState.setupOrder?.[gameState.setupStep] ?? 0);

  for (const p of gameState.players) {
    const card = document.createElement('div');
    card.className = ('player-card' + (p.id===curIdx ? ' active-player' : '') +
                     (WEB_PLAYER_ID!==null && p.id===WEB_PLAYER_ID ? ' web-player-me' : ''));
    card.style.color       = p.color;
    card.style.borderColor = p.id===curIdx ? p.color : 'rgba(255,255,255,.15)';
    card.dataset.pid = p.id;

    const playerGains = gains[p.id] || {};
    const playerCommodityGains = commodityGains[p.id] || {};
    const res = p.resources;
    const hide = shouldHideRes(p);

    const resHtml = ['wood','brick','sheep','wheat','ore'].map(r => {
      const gained = playerGains[r] || 0;
      const total  = res[r] || 0;
      const cls    = gained > 0 ? ' gained' : '';
      const gainBadge = gained > 0
        ? `<span class="res-gain-delta">+${gained}</span>`
        : '';
      return `<div class="res-badge${cls}${hide?' res-hidden':''}" data-tip="${resName(r)}">
        <span class="res-icon">${resEmoji(r)}</span>
        <span>${hide ? (gained > 0 ? '' : '?') : total}</span>
        ${gainBadge}
      </div>`;
    }).join('');

    const ckHtml = gameState.citiesKnights ? `<div class="player-commodities">${
      [['paper','📜'],['cloth','🧵'],['coin','🪙']].map(([c,icon]) => {
        const gained = playerCommodityGains[c] || 0;
        const total  = p.commodities?.[c] || 0;
        const cls    = gained > 0 ? ' gained' : '';
        const gainBadge = gained > 0 ? `<span class="res-gain-delta">+${gained}</span>` : '';
        return `<div class="res-badge${cls}" data-tip="${commodityName(c)}">
          <span class="res-icon">${icon}</span>
          <span>${hide ? (gained > 0 ? '' : '?') : total}</span>
          ${gainBadge}
        </div>`;
      }).join('')
    }</div>` : '';

    const devCount = p.devCards?.length||0;
    const progCount = p.progressCards?.length||0;
    const specials = badgeHTML(p);
    const mobConnected = state.mobileConnected?.[p.id];

    // 📱 button to re-show QR at any time during game
    const qrBtnHtml = `<button class="card-qr-btn" title="Mostra QR per ${escHtml(p.name)}"
      onclick="event.stopPropagation();showQRForPlayer(${p.id})">📱</button>`;

    card.innerHTML = `
      <div class="player-name-row">
        <div class="player-color-dot" style="background:${p.color}"></div>
        <span class="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'player-name editable-name':'player-name'}"
          title="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'Clicca per rinominare':''}"
          onclick="promptRenamePlayer(${p.id})">${escHtml(p.name)}</span>
        ${mobConnected ? '<span class="mob-badge" title="Telefono connesso">📱✓</span>' : ''}
        <span class="player-pts">⭐${p.points}</span>
        ${qrBtnHtml}
      </div>
      <div class="player-resources">${resHtml}</div>
      ${ckHtml}
      ${devCount>0?`<div style="font-size:.72rem;color:#c8b080;margin-top:4px">🃏 ${devCount} carta${devCount>1?'e':''}</div>`:''}${state.citiesKnights&&progCount>0?`<div style="font-size:.72rem;color:#a8c8d0;margin-top:2px;cursor:pointer" onclick="openProgressHandModal(${p.id})">📗 ${progCount} carta${progCount>1?'e':''} progresso</div>`:''}
      ${specials?`<div class="player-specials">${specials}</div>`:''}`;

    panel.appendChild(card);
  }
}

// ===================================================================
//  TRADE RESOLUTION FEEDBACK
// ===================================================================

function handleTradeResolution(prevTrade, prevResources, prevCommodities) {
  if (!state || !prevResources) return;

  // Did resources actually change? → trade was accepted
  const fromId = prevTrade.fromId;
  const toId   = prevTrade.toId;
  const from   = state.players[fromId];
  const to     = state.players[toId];
  if (!from || !to) return;

  // Compare resources (and commodities, if C&K is on) to detect accept vs reject
  let anyChange = false;
  for (const res of ['wood','brick','sheep','wheat','ore']) {
    if ((state.players[fromId].resources[res]||0) !== (prevResources[fromId][res]||0)) { anyChange = true; break; }
    if ((state.players[toId].resources[res]||0)   !== (prevResources[toId][res]||0))   { anyChange = true; break; }
  }
  if (!anyChange && state.citiesKnights && prevCommodities) {
    for (const c of ['paper','cloth','coin']) {
      if ((state.players[fromId].commodities?.[c]||0) !== (prevCommodities[fromId]?.[c]||0)) { anyChange = true; break; }
      if ((state.players[toId].commodities?.[c]||0)   !== (prevCommodities[toId]?.[c]||0))   { anyChange = true; break; }
    }
  }

  if (anyChange) {
    // Trade ACCEPTED — compute deltas and show panel like dice gains
    showTradeExchangePanel(prevTrade, prevResources, prevCommodities);
  } else {
    // Trade REJECTED — show notification to proposer only
    showTradeRejectedToast(prevTrade);
  }
}

// Show resource changes panel after a steal (robber/knight)
function showStealExchangePanel(deltas, commodityDeltas = {}) {
  // Open left drawer
  drawerState.players = true;
  drawerState.actions = false;
  drawerState.log     = false;
  document.getElementById('drawer-actions')?.classList.remove('open');
  document.getElementById('tab-actions')?.classList.remove('open');
  document.getElementById('drawer-players').classList.add('open');
  document.getElementById('tab-players').classList.add('open');
  calcBoardTransform(); renderBoard();

  renderPlayersWithTradeDeltas(deltas, commodityDeltas);
  document.body.classList.add('gain-blocking');

  // Floating badges
  const popupContainer = document.getElementById('gain-popups');
  popupContainer.innerHTML = '';

  setTimeout(() => {
    const panel = document.getElementById('players-panel');
    const cards  = panel.querySelectorAll('.player-card');
    const CK_COMMODITY_ICON = { paper: '📜', cloth: '🧵', coin: '🪙' };
    for (const card of cards) {
      const pid = parseInt(card.dataset.pid);
      const hasResDelta = deltas[pid] && Object.keys(deltas[pid]).length;
      const hasComDelta = commodityDeltas[pid] && Object.keys(commodityDeltas[pid]).length;
      if (isNaN(pid) || (!hasResDelta && !hasComDelta)) continue;
      const rect = card.getBoundingClientRect();
      const pop  = document.createElement('div');
      pop.className = 'gain-popup trade-popup';
      pop.style.left        = (rect.right + 10) + 'px';
      pop.style.top         = (rect.top + rect.height/2 - 24) + 'px';
      pop.style.borderColor = state.players[pid].color;
      const resPart = Object.entries(deltas[pid]||{})
        .map(([r,d]) => `<span class="${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d} ${resEmoji(r)}</span>`)
        .join('');
      const comPart = Object.entries(commodityDeltas[pid]||{})
        .map(([c,d]) => `<span class="${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d} ${CK_COMMODITY_ICON[c]}</span>`)
        .join('');
      pop.innerHTML = resPart + comPart;
      popupContainer.appendChild(pop);
      requestAnimationFrame(() => pop.classList.add('visible'));
    }

    const dismiss = document.getElementById('gain-dismiss');
    const span = dismiss.querySelector('span');
    if (span) span.textContent = t('tap_to_continue') || 'Tocca per continuare';
    dismiss.classList.add('visible');

    const onDismiss = () => {
      dismiss.classList.remove('visible');
      dismiss.removeEventListener('click', onDismiss);
      if (span) span.setAttribute('data-t','tap_continue');
      applyTranslations();
      document.body.classList.remove('gain-blocking');
      document.querySelectorAll('.res-badge.trade-gained,.res-badge.trade-lost').forEach(b => {
        b.classList.remove('trade-gained','trade-lost');
      });
      document.querySelectorAll('.gain-popup').forEach(p => p.classList.remove('visible'));
      setTimeout(() => { popupContainer.innerHTML = ''; render(); }, 350);
    };
    dismiss.addEventListener('click', onDismiss);
  }, 320);
}

// Show resource changes panel (like dice gains) after a trade
function showTradeExchangePanel(trade, prevResources, prevCommodities) {
  const fromId = trade.fromId, toId = trade.toId;
  const fromP  = state.players[fromId], toP = state.players[toId];

  // Build gains/losses per player
  const deltas = {};
  const commodityDeltas = {};
  for (const pid of [fromId, toId]) {
    deltas[pid] = {};
    for (const res of ['wood','brick','sheep','wheat','ore']) {
      const diff = (state.players[pid].resources[res]||0) - (prevResources[pid][res]||0);
      if (diff !== 0) deltas[pid][res] = diff;
    }
    if (state.citiesKnights) {
      commodityDeltas[pid] = {};
      for (const c of ['paper','cloth','coin']) {
        const diff = (state.players[pid].commodities?.[c]||0) - (prevCommodities?.[pid]?.[c]||0);
        if (diff !== 0) commodityDeltas[pid][c] = diff;
      }
    }
  }

  // Notify all: show accepted toast
  const toastMsg = t('trade_accepted_toast', escHtml(toP.name));
  showGameToast(toastMsg, 'toast-accepted', 2500);

  // Open left drawer
  drawerState.players = true;
  drawerState.actions = false;
  drawerState.log     = false;
  document.getElementById('drawer-actions')?.classList.remove('open');
  document.getElementById('tab-actions')?.classList.remove('open');
  document.getElementById('drawer-players').classList.add('open');
  document.getElementById('tab-players').classList.add('open');
  calcBoardTransform(); renderBoard();

  // Render player cards with trade deltas highlighted
  renderPlayersWithTradeDeltas(deltas, commodityDeltas);

  document.body.classList.add('gain-blocking');

  // Floating badges
  const popupContainer = document.getElementById('gain-popups');
  popupContainer.innerHTML = '';

  setTimeout(() => {
    const panel = document.getElementById('players-panel');
    const cards  = panel.querySelectorAll('.player-card');
    const CK_COMMODITY_ICON = { paper: '📜', cloth: '🧵', coin: '🪙' };
    for (const card of cards) {
      const pid = parseInt(card.dataset.pid);
      const hasResDelta = deltas[pid] && Object.keys(deltas[pid]).length;
      const hasComDelta = commodityDeltas[pid] && Object.keys(commodityDeltas[pid]).length;
      if (isNaN(pid) || (!hasResDelta && !hasComDelta)) continue;
      const rect = card.getBoundingClientRect();
      const pop  = document.createElement('div');
      pop.className = 'gain-popup trade-popup';
      pop.style.left        = (rect.right + 10) + 'px';
      pop.style.top         = (rect.top + rect.height/2 - 24) + 'px';
      pop.style.borderColor = state.players[pid].color;
      const resPart = Object.entries(deltas[pid]||{})
        .map(([r,d]) => `<span class="${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d} ${resEmoji(r)}</span>`)
        .join('');
      const comPart = Object.entries(commodityDeltas[pid]||{})
        .map(([c,d]) => `<span class="${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d} ${CK_COMMODITY_ICON[c]}</span>`)
        .join('');
      pop.innerHTML = resPart + comPart;
      popupContainer.appendChild(pop);
      requestAnimationFrame(() => pop.classList.add('visible'));
    }

    // Dismiss banner
    const dismiss = document.getElementById('gain-dismiss');
    // Customize dismiss text for trade
    const span = dismiss.querySelector('span');
    if (span) span.textContent = t('trade_completed_banner');
    dismiss.classList.add('visible');

    const onDismiss = () => {
      dismiss.classList.remove('visible');
      dismiss.removeEventListener('click', onDismiss);
      if (span) span.setAttribute('data-t','tap_continue');
      applyTranslations();
      document.body.classList.remove('gain-blocking');
      document.querySelectorAll('.res-badge.trade-gained,.res-badge.trade-lost').forEach(b => {
        b.classList.remove('trade-gained','trade-lost');
      });
      document.querySelectorAll('.gain-popup').forEach(p => p.classList.remove('visible'));
      setTimeout(() => { popupContainer.innerHTML = ''; render(); }, 350);
    };
    dismiss.addEventListener('click', onDismiss);
  }, 320);
}

function renderPlayersWithTradeDeltas(deltas, commodityDeltas = {}) {
  const panel  = document.getElementById('players-panel');
  panel.innerHTML = '';
  const curIdx = state.phase==='main' ? state.currentPlayerIndex
               : (state.setupOrder?.[state.setupStep] ?? 0);

  for (const p of state.players) {
    const card = document.createElement('div');
    card.className = ('player-card' + (p.id===curIdx ? ' active-player' : '') +
                     (WEB_PLAYER_ID!==null && p.id===WEB_PLAYER_ID ? ' web-player-me' : ''));
    card.style.color = card.style.borderColor = p.id===curIdx ? p.color : 'rgba(255,255,255,.15)';
    card.dataset.pid = p.id;

    const playerDeltas = deltas[p.id] || {};
    const playerCommodityDeltas = commodityDeltas[p.id] || {};
    const res = p.resources;
    const hide = shouldHideRes(p);
    const resHtml = ['wood','brick','sheep','wheat','ore'].map(r => {
      const d = playerDeltas[r];
      const cls = d > 0 ? ' trade-gained' : d < 0 ? ' trade-lost' : '';
      const badge = d ? `<span class="res-delta ${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d}</span>` : '';
      return `<div class="res-badge${cls}${hide?' res-hidden':''}" data-tip="${resName(r)}"><span class="res-icon">${resEmoji(r)}</span><span>${hide ? (d ? '' : '?') : (res[r]||0)}</span>${badge}</div>`;
    }).join('');

    const ckHtml = state.citiesKnights ? `<div class="player-commodities">${
      [['paper','📜'],['cloth','🧵'],['coin','🪙']].map(([c,icon]) => {
        const d = playerCommodityDeltas[c];
        const cls = d > 0 ? ' trade-gained' : d < 0 ? ' trade-lost' : '';
        const badge = d ? `<span class="res-delta ${d>0?'delta-pos':'delta-neg'}">${d>0?'+':''}${d}</span>` : '';
        const total = p.commodities?.[c] || 0;
        return `<div class="res-badge${cls}" data-tip="${commodityName(c)}"><span class="res-icon">${icon}</span><span>${hide ? (d ? '' : '?') : total}</span>${badge}</div>`;
      }).join('')
    }</div>` : '';

    const devCount = p.devCards?.length||0;
    const progCount = p.progressCards?.length||0;
    const specials = badgeHTML(p);
    const mobConnected = state.mobileConnected?.[p.id];
    const qrBtnHtml = `<button class="card-qr-btn" onclick="event.stopPropagation();showQRForPlayer(${p.id})">📱</button>`;

    card.innerHTML = `
      <div class="player-name-row">
        <div class="player-color-dot" style="background:${p.color}"></div>
        <span class="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'player-name editable-name':'player-name'}"
          title="${WEB_PLAYER_ID===null||WEB_PLAYER_ID===p.id?'Clicca per rinominare':''}"
          onclick="promptRenamePlayer(${p.id})">${escHtml(p.name)}</span>
        ${mobConnected?'<span class="mob-badge">📱✓</span>':''}
        <span class="player-pts">⭐${p.points}</span>
        ${qrBtnHtml}
      </div>
      <div class="player-resources">${resHtml}</div>
      ${ckHtml}
      ${devCount>0?`<div style="font-size:.72rem;color:#c8b080;margin-top:4px">🃏 ${devCount} carta${devCount>1?'e':''}</div>`:''}${state.citiesKnights&&progCount>0?`<div style="font-size:.72rem;color:#a8c8d0;margin-top:2px;cursor:pointer" onclick="openProgressHandModal(${p.id})">📗 ${progCount} carta${progCount>1?'e':''} progresso</div>`:''}
      ${specials?`<div class="player-specials">${specials}</div>`:''}`;
    panel.appendChild(card);
  }
}

// Toast notification for rejected trade (shown to proposer)
function showTradeRejectedToast(trade) {
  const toPlayer = state.players[trade.toId];
  if (!toPlayer) return;
  showGameToast(
    t('trade_rejected_toast', escHtml(toPlayer.name)),
    'toast-rejected',
    3000
  );
}

function showPointsToast(player, delta) {
  // Shows a persistent points bar for this player
  const containerId = 'pts-toast-' + player.id;
  let el = document.getElementById(containerId);
  if (!el) {
    el = document.createElement('div');
    el.id = containerId;
    el.className = 'pts-toast';
    document.getElementById('game-screen').appendChild(el);
  }
  el.style.color = player.color;
  el.style.borderColor = player.color;
  const stars = '⭐'.repeat(player.points);
  el.innerHTML = `<span class="pts-name">${escHtml(player.name)}</span>
    <span class="pts-delta">+${delta} ⭐</span>
    <span class="pts-total">${player.points} ${t('pt_label')||'pts'}</span>`;
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3500);
}

function showGameToast(msg, cls='', duration=2500) {
  let el = document.getElementById('game-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'game-toast';
    el.className = 'game-toast';
    document.getElementById('game-screen').appendChild(el);
  }
  el.textContent = msg;
  el.className   = 'game-toast visible ' + cls;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.remove('visible'); }, duration);
}

// ===================================================================
//  TV RESOURCE ICONS (canvas fallback for browsers without emoji)
// ===================================================================

const TV_RES_ICONS = {};

function buildTVIcons() {
  const defs = {
    wood:   (ctx,x,y,s) => {
      // Tree: trunk + triangle crown
      ctx.fillStyle='#8B5E3C';
      ctx.fillRect(x-s*.08,y+s*.1,s*.16,s*.4);
      ctx.fillStyle='#2d7a2d';
      ctx.beginPath(); ctx.moveTo(x,y-s*.5); ctx.lineTo(x+s*.35,y+s*.15); ctx.lineTo(x-s*.35,y+s*.15); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x,y-s*.7); ctx.lineTo(x+s*.28,y-s*.15); ctx.lineTo(x-s*.28,y-s*.15); ctx.closePath(); ctx.fill();
    },
    brick:  (ctx,x,y,s) => {
      // Stack of bricks
      ctx.fillStyle='#a03010';
      [[-1,-1],[0,-1],[1,-1],[-0.5,0],[0.5,0],[-1,1],[0,1],[1,1]].forEach(([bx,by])=>{
        ctx.fillRect(x+bx*s*.22-s*.1, y+by*s*.2-s*.07, s*.18, s*.12);
      });
      ctx.fillStyle='#c84020';
      ctx.fillRect(x-s*.32,y-s*.27,s*.18,s*.12);
      ctx.fillRect(x+s*.05,y-s*.07,s*.18,s*.12);
      ctx.fillRect(x-s*.32,y+s*.13,s*.18,s*.12);
    },
    sheep:  (ctx,x,y,s) => {
      // Round fluffy sheep body
      ctx.fillStyle='#e8e8e8';
      ctx.beginPath(); ctx.arc(x,y-s*.05,s*.32,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(x-s*.18,y-s*.15,s*.2,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(x+s*.18,y-s*.15,s*.2,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(x,y-s*.28,s*.18,0,Math.PI*2); ctx.fill();
      // Head
      ctx.fillStyle='#c8b090';
      ctx.beginPath(); ctx.ellipse(x,y+s*.2,s*.1,s*.14,0,0,Math.PI*2); ctx.fill();
      // Legs
      ctx.strokeStyle='#c8b090'; ctx.lineWidth=s*.08;
      ctx.beginPath(); ctx.moveTo(x-s*.12,y+s*.22); ctx.lineTo(x-s*.12,y+s*.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x+s*.12,y+s*.22); ctx.lineTo(x+s*.12,y+s*.5); ctx.stroke();
    },
    wheat:  (ctx,x,y,s) => {
      // Wheat stalks
      ctx.strokeStyle='#c8a020'; ctx.lineWidth=s*.06;
      [-s*.2,0,s*.2].forEach(ox=>{
        ctx.beginPath(); ctx.moveTo(x+ox,y+s*.45); ctx.lineTo(x+ox,y-s*.3); ctx.stroke();
        // Grain head
        ctx.fillStyle='#e8c040';
        ctx.beginPath(); ctx.ellipse(x+ox,y-s*.4,s*.07,s*.18,0,0,Math.PI*2); ctx.fill();
      });
    },
    ore:    (ctx,x,y,s) => {
      // Mountain peaks
      ctx.fillStyle='#607090';
      ctx.beginPath(); ctx.moveTo(x,y-s*.5); ctx.lineTo(x+s*.4,y+s*.3); ctx.lineTo(x-s*.4,y+s*.3); ctx.closePath(); ctx.fill();
      ctx.fillStyle='#7890a8';
      ctx.beginPath(); ctx.moveTo(x-s*.15,y-s*.2); ctx.lineTo(x+s*.2,y+s*.3); ctx.lineTo(x-s*.4,y+s*.3); ctx.closePath(); ctx.fill();
      // Snow cap
      ctx.fillStyle='#d8e8f0';
      ctx.beginPath(); ctx.moveTo(x,y-s*.5); ctx.lineTo(x+s*.12,y-s*.28); ctx.lineTo(x-s*.12,y-s*.28); ctx.closePath(); ctx.fill();
    },
    desert: (ctx,x,y,s) => {
      // Sun + sand dune
      ctx.fillStyle='#c8b070';
      ctx.beginPath(); ctx.ellipse(x,y+s*.2,s*.4,s*.2,0,0,Math.PI*2); ctx.fill();
      // Sun
      ctx.fillStyle='#f0c040';
      ctx.beginPath(); ctx.arc(x,y-s*.2,s*.18,0,Math.PI*2); ctx.fill();
      // Rays
      ctx.strokeStyle='#f0c040'; ctx.lineWidth=s*.06;
      for(let a=0;a<8;a++){
        const angle=a*Math.PI/4;
        ctx.beginPath();
        ctx.moveTo(x+Math.cos(angle)*s*.22,y-s*.2+Math.sin(angle)*s*.22);
        ctx.lineTo(x+Math.cos(angle)*s*.34,y-s*.2+Math.sin(angle)*s*.34);
        ctx.stroke();
      }
    },
  };

  // Pre-render each icon to an offscreen canvas
  const SIZE = 128;
  Object.entries(defs).forEach(([res, draw]) => {
    const oc = document.createElement('canvas');
    oc.width = oc.height = SIZE;
    const octx = oc.getContext('2d');
    draw(octx, SIZE/2, SIZE/2, SIZE/2);
    TV_RES_ICONS[res] = oc;
  });
}

function drawTVResIcon(ctx, resource, x, y, size) {
  if (!TV_RES_ICONS[resource]) return;
  ctx.drawImage(TV_RES_ICONS[resource], x-size/2, y-size/2, size, size);
}

// ===================================================================
//  SKIN ASSET LOADER
// ===================================================================

async function loadSkinAssets(skinId) {
  if (skinId === 'standard') { SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, commodityNames:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} }; if (state) { renderBoard(); render(); } return; }
  try {
    const res = await fetch(`/skins/${skinId}/skin.json`);
    if (!res.ok) { SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, commodityNames:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} }; return; }
    const meta = await res.json();
    const hexImages = {};
    if (meta.provides?.includes('hex') && meta.hex) {
      const loads = Object.entries(meta.hex).map(([type, path]) =>
        new Promise(resolve => {
          const img = new window.Image();
          img.onload  = () => { hexImages[type] = img; resolve(); };
          img.onerror = () => resolve();
          img.src = `/skins/${skinId}/${path}`;
        })
      );
      await Promise.all(loads);
    }
    // Load robber image if provided
    let robberImage = null;
    if (meta.provides?.includes('robber') && meta.robber) {
      robberImage = await new Promise(resolve => {
        const img = new window.Image();
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `/skins/${skinId}/${meta.robber}`;
      });
    }
    // Load building images {settlement:{red:Image,...}, city:{red:Image,...}}
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
    // Load road images
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
    // Load resource name overrides from skin (optional)
    const resourceNames = {};
    if (meta.resource_names) {
      for (const [res, name] of Object.entries(meta.resource_names)) {
        if (name) resourceNames[res] = name; // only override if non-empty
      }
    }
    // Load resource emoji overrides from skin (optional)
    const resourceEmojis = {};
    if (meta.resource_emojis) {
      for (const [res, emoji] of Object.entries(meta.resource_emojis)) {
        if (emoji) resourceEmojis[res] = emoji; // only override if non-empty
      }
    }
    // Cities & Knights: load commodity name overrides from skin (optional, none define it yet)
    const commodityNames = {};
    if (meta.commodity_names) {
      for (const [com, name] of Object.entries(meta.commodity_names)) {
        if (name) commodityNames[com] = name;
      }
    }
    // Load generic label overrides from skin (optional)
    const labels = meta.labels || {};
    const vpCards = meta.vp_cards || {};
    const devCards = meta.dev_cards || {};

    // Preload VP card images if defined
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

    // Preload dev card images if defined
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

    SKIN = { id: skinId, hexImages, robberImage, buildingImages, roadImages, resourceNames, resourceEmojis, commodityNames, labels, vpCards, vpImages, devCards, devImages };
    if (state && !window.__SPECTATOR_MODE) { renderBoard(); render(); } // re-render board + all labels/banners
    if (!window.__SPECTATOR_MODE) applyTranslations(); // re-apply skin label overrides to static DOM
    console.log(`Skin "${skinId}" loaded: ${Object.keys(hexImages).length} hex + ${Object.keys(roadImages).length} road textures`);
  } catch(e) {
    console.warn('Skin load failed:', e);
    SKIN = { id:'standard', hexImages:{}, robberImage:null, buildingImages:{}, roadImages:{}, resourceNames:{}, resourceEmojis:{}, commodityNames:{}, labels:{}, vpCards:{}, vpImages:{}, devCards:{}, devImages:{} };
  }
}

// ===================================================================
//  DEV CARD DRAWN POPUP
// ===================================================================

const DEV_CARD_DESC = {
  knight:        () => skinLabel('devcard_knight_desc', t('devcard_knight_desc')  || 'Move the robber and steal a resource'),
  victoryPoint:  () => t('devcard_vp_desc')      || '+1 Victory Point (kept secret)',
  roadBuilding:  () => skinLabel('devcard_road_desc',   t('devcard_road_desc')    || 'Place 2 free roads'),
  yearOfPlenty:  () => skinLabel('devcard_yop_desc',    t('devcard_yop_desc')     || 'Take any 2 resources from the bank'),
  monopoly:      () => skinLabel('devcard_mono_desc',   t('devcard_mono_desc')    || 'Claim all of one resource from everyone'),
};
const VP_CLASSIC = {
  chapel:     { name: '⛪ Cappella',    emoji: '⛪', desc: 'Un luogo di preghiera che porta prosperità al villaggio' },
  library:    { name: '📚 Biblioteca',  emoji: '📚', desc: 'La conoscenza è potere' },
  market:     { name: '🏪 Mercato',     emoji: '🏪', desc: 'Il cuore pulsante del commercio della colonia' },
  university: { name: '🎓 Università',  emoji: '🎓', desc: 'Menti brillanti che fanno prosperare la comunità' },
  palace:     { name: '🏰 Sala Grande', emoji: '🏰', desc: 'Il simbolo del potere e della grandezza del tuo regno' },
};

function getVPCardInfo(subtype) {
  const skinVP = SKIN?.vpCards?.[subtype];
  if (skinVP) return skinVP;
  return VP_CLASSIC[subtype] || { name: '⭐ Punto Vittoria', emoji: '⭐', desc: '' };
}

function getDevCardEmoji(card, subtype) {
  const map = {
    knight:       skinLabel('devname_knight',     '⚔️').split(' ')[0],
    victoryPoint: '⭐',
    roadBuilding: skinLabel('devname_road_build', '🛤').split(' ')[0],
    yearOfPlenty: skinLabel('devname_yop',        '🌻').split(' ')[0],
    monopoly:     skinLabel('devname_monopoly',   '👑').split(' ')[0],
  };
  return map[card] || '🃏';
}

function showDevCardDrawnPopup(drawn) {
  const player = state.players[drawn.playerId];
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

  // Create modal overlay
  const vpImg  = (isVP && subtype) ? SKIN?.vpImages?.[subtype] : null;
  const devImg = (!isVP) ? SKIN?.devImages?.[card] : null;
  const cardImg = vpImg || devImg || null;

  let el = document.getElementById('modal-dev-drawn');
  if (!el) {
    el = document.createElement('div');
    el.id = 'modal-dev-drawn';
    el.className = 'modal';
    el.innerHTML = `
      <div class="modal-content dev-drawn-modal" onclick="this.parentElement.classList.remove('open')">
        <div class="dev-drawn-emoji" id="dev-drawn-emoji"></div>
        <div class="dev-drawn-name" id="dev-drawn-name"></div>
        <div class="dev-drawn-player" id="dev-drawn-player"></div>
        <div class="dev-drawn-desc" id="dev-drawn-desc"></div>
        ${isVP ? '' : `<p class="dev-drawn-hint">(${t('next_turn_badge')||'next turn'})</p>`}
        <button class="big-btn primary" onclick="document.getElementById('modal-dev-drawn').classList.remove('open')">OK</button>
      </div>`;
    document.getElementById('game-screen').appendChild(el);
  }

  // Show image if available, otherwise emoji
  const emojiEl = document.getElementById('dev-drawn-emoji');
  if (cardImg) {
    emojiEl.innerHTML = '';
    const imgEl = document.createElement('img');
    imgEl.src = cardImg.src;
    imgEl.style.cssText = 'width:120px;height:120px;object-fit:cover;border-radius:12px;margin-bottom:8px;';
    emojiEl.appendChild(imgEl);
  } else {
    emojiEl.innerHTML = '';
    emojiEl.textContent = emoji;
  }
  document.getElementById('dev-drawn-name').textContent   = name;
  document.getElementById('dev-drawn-player').textContent = player.name;
  document.getElementById('dev-drawn-player').style.color = player.color;
  document.getElementById('dev-drawn-desc').textContent   = desc;

  // Update hint visibility
  const hint = el.querySelector('.dev-drawn-hint');
  if (hint) hint.style.display = isVP ? 'none' : '';

  el.classList.add('open');
  // Auto-close after 5s if not dismissed
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('open'), 30000);
}
