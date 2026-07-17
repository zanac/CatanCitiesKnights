// ============================================================
//  CATAN GAME ENGINE  —  server/game.js
//
//  Pure game logic, no I/O. The server (index.js) is the only
//  caller. A single CatanGame instance lives per room and is
//  mutated in place on every action; undo is implemented by
//  serialising the full state before each action and restoring
//  on demand (see getSerializableState / restoreFromState).
//
//  Internal resource keys are always lowercase English
//  ('wood', 'brick', 'sheep', 'wheat', 'ore') and are NEVER
//  changed — only display labels are overridden by skins.
// ============================================================

const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const DESERT = 'desert';

// Standard Catan tile counts (19 hexes total)
const TILE_COUNTS = {
  wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1
};

// 18 number tokens (no 7 — 7 triggers the robber instead)
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// Resource costs for each buildable item
const COSTS = {
  road:       { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city:       { wheat: 2, ore: 3 },
  devCard:    { sheep: 1, wheat: 1, ore: 1 }
};

// Cities & Knights: which commodity a city produces from each resource hex
// (wheat/brick hexes yield no commodity, only the base resource)
const HEX_COMMODITY = { wood: 'paper', sheep: 'cloth', ore: 'coin' };

// Cities & Knights: which commodity funds each city-improvement track
const TRACK_COMMODITY = { trade: 'cloth', politics: 'coin', science: 'paper' };

// Standard Catan dev card deck composition
const DEV_CARD_COUNTS = {
  knight: 14, victoryPoint: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2
};

// VP card subtypes — each victoryPoint card gets a unique subtype so
// skins can assign distinct artwork and names to each one
const VP_SUBTYPES = ['library', 'chapel', 'market', 'university', 'palace'];

// Hex grid layout: rows of 3-4-5-4-3 hexes (standard Catan board)
const HEX_LAYOUT = [3, 4, 5, 4, 3];

class CatanGame {
  constructor(playerConfigs, options = {}) {
    // ── Game rules / options ─────────────────────────────────────
    // Note: options that default to TRUE use `!== false` so that
    //       omitting the key in the START_GAME message keeps the default.
    //       Options that default to FALSE use `!!` for the same reason.
    this.desertCenter   = options.desertCenter  || false;
    this.zeroResources  = options.zeroResources !== false; // default ON: setup2 gives no starting resources
    this.randomPorts    = options.randomPorts   || false;
    this.randomNumbers  = options.randomNumbers || false;
    this.skinId         = options.skinId        || 'standard';
    this.debugDevCard   = options.debugDevCard  || null;
    this.unlimitedDev   = options.unlimitedDev !== false; // default ON: house rule, multiple buys per turn
    this.instantDev    = !!options.instantDev;            // default OFF: cards are playable next turn
    this.winPoints      = options.quickGame ? 7 : 10;
    this.debugResources = options.debugResources || false;
    this.debugForceDice = options.debugForceDice || null;
    this.hiddenResources = !!options.hiddenResources;   // default OFF: clients hide other players' counts
    this.balancedResources = !!options.balancedResources; // default OFF: no-cluster tile placement
    this.citiesKnights = !!options.citiesKnights;        // default OFF: Cities & Knights variant
    this.winPoints = this.citiesKnights && !options.quickGame ? 13 : this.winPoints;

    // ── Player state ─────────────────────────────────────────────
    this.players = playerConfigs.map((p, i) => ({
      id: i,
      name: p.name,
      color: p.color,
      resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      devCards: [],
      playedDevCards: [],
      settlements: [],
      cities: [],
      roads: [],
      points: 0,
      hasLongestRoad: false,
      hasLargestArmy: false,
      knightsPlayed: 0,
      // ── Cities & Knights (unused unless this.citiesKnights) ──────
      commodities: { paper: 0, cloth: 0, coin: 0 },
      cityImprovements: { trade: 0, politics: 0, science: 0 }, // 0..5 per track
      knights: [],        // { vertexId, rank: 'basic'|'strong'|'mighty', active }
      progressCards: [],  // { type, subtype }
      cityWalls: [],      // vertexId list
      defenderPoints: 0   // Defender of Catan cards held
    }));

    // ── Board and deck ───────────────────────────────────────────
    this.board = this._generateBoard();
    this.devDeck = this._generateDevDeck();
    this.devCardBoughtThisTurn = false;

    // ── Turn state ───────────────────────────────────────────────
    this.currentPlayerIndex = 0;
    this.phase = 'setup1'; // 'setup1' | 'setup2' | 'main'

    // Setup order: players in order, then reverse (snake draft)
    // e.g. 4 players: 0,1,2,3,3,2,1,0
    this.setupOrder = this._buildSetupOrder();
    this.setupStep = 0;
    this.waitingForRoad = false;
    this.pendingSetupEndTurn = false; // true after road placed, waiting for explicit confirm
    this.lastSettlementPlaced = null; // used to enforce road adjacency in setup

    // ── Dice & robber ────────────────────────────────────────────
    this.diceRolled = false;
    this.diceValues = [0, 0];
    this.robberHexId = this.board.hexes.find(h => h.resource === DESERT).id;

    // ── Specials ─────────────────────────────────────────────────
    this.longestRoadOwner = null;
    this.longestRoadLength = 0;
    this.largestArmyOwner = null;
    this.largestArmySize = 0;
    this.winner = null;
    this.log = [];

    // ── Pending actions ──────────────────────────────────────────
    // These flags gate what the current player (or others) may do next.
    this.pendingRobber = false;       // must place robber before acting
    this.pendingDiscard = [];          // player ids that owe a discard (dice=7)
    this.pendingSteal = false;         // must choose steal target
    this.robberCandidates = [];        // players adjacent to new robber hex
    this.pendingYearOfPlenty = 0;      // resources still to claim (0, 1, or 2)
    this.pendingRoadBuilding = 0;      // free roads still to place (0, 1, or 2)
    this.pendingMonopoly = false;
    this.currentTradeOffer = null;

    // ── Cities & Knights globals (unused unless this.citiesKnights) ─
    this.barbarianProgress = 0; // 0..7, resets after each attack
    this.metropolises = { trade: null, politics: null, science: null }; // playerId or null
  }

  // ================================================================
  //  BOARD GENERATION
  // ================================================================

  _generateBoard() {
    // Hex indices by row (layout 3-4-5-4-3):
    //   row0: 0  1  2
    //   row1: 3  4  5  6
    //   row2: 7  8  9 10 11   ← center hex = 9
    //   row3:12 13 14 15
    //   row4:16 17 18
    const CENTER_HEX_INDEX = 9;

    // Choose tile placement algorithm
    const tiles = this.balancedResources
      ? this._balancedShuffleTiles()
      : this._shuffleTiles();

    // If desertCenter is on, force-swap desert to the center hex
    if (this.desertCenter) {
      const dIdx = tiles.indexOf(DESERT);
      if (dIdx !== CENTER_HEX_INDEX) {
        const tmp = tiles[CENTER_HEX_INDEX];
        tiles[CENTER_HEX_INDEX] = DESERT;
        tiles[dIdx] = tmp;
      }
    }

    // Official Catan spiral order for number tokens (clockwise from top-left)
    // Letter sequence A→R visits hexes in this exact index order:
    const SPIRAL_ORDER = [0,3,7,12,16,17,18,15,11,6,2,1,4,8,13,14,10,5,9];

    // Standard number assignment (same spiral, same official sequence)
    // 6 and 8 are red dots — in official layout they are never adjacent
    const OFFICIAL_NUMBERS = [5,2,6,3,8,10,9,12,11,4,8,10,9,4,5,6,3,11];

    const hexNumbers = new Array(19).fill(null);
    let numbers = [...OFFICIAL_NUMBERS];

    if (this.randomNumbers) {
      // Fisher-Yates shuffle of the number tokens
      for (let i = numbers.length-1; i > 0; i--) {
        const j = Math.floor(Math.random()*(i+1));
        [numbers[i],numbers[j]] = [numbers[j],numbers[i]];
      }
      let ni = 0;
      for (const hexIdx of SPIRAL_ORDER) {
        if (tiles[hexIdx] !== DESERT) hexNumbers[hexIdx] = numbers[ni++];
      }
    } else {
      // Place official numbers in spiral order, skipping the desert
      let numIdx = 0;
      for (const hexIdx of SPIRAL_ORDER) {
        if (tiles[hexIdx] !== DESERT) hexNumbers[hexIdx] = OFFICIAL_NUMBERS[numIdx++];
      }
    }

    // Build hex objects
    const layout = HEX_LAYOUT;
    const hexes = [];
    let hexId = 0;
    for (let row = 0; row < layout.length; row++) {
      const count = layout[row];
      for (let col = 0; col < count; col++) {
        const idx = hexId;
        const resource = tiles[idx];
        hexes.push({
          id: hexId++,
          resource,
          number: hexNumbers[idx],
          row,
          col,
          hasRobber: resource === DESERT
        });
      }
    }

    // Generate graph structures on top of the hex grid
    const vertices = this._generateVertices(hexes, layout);
    const edges = this._generateEdges(vertices, hexes, layout);
    const ports = this._generatePorts(hexes, layout, vertices, edges);

    return { hexes, vertices, edges, ports };
  }

  // Standard Fisher-Yates shuffle of the 19 tile types
  _shuffleTiles() {
    const tiles = [];
    for (const [res, count] of Object.entries(TILE_COUNTS)) {
      for (let i = 0; i < count; i++) tiles.push(res);
    }
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    return tiles;
  }

  // Pre-computed adjacency map for the 19-hex board (layout [3,4,5,4,3]).
  // Index i → array of hex indices that share an edge with hex i.
  // Used by _balancedShuffleTiles to check cluster violations.
  static get HEX_ADJACENCY() {
    return [
      [1,3,4],          // 0
      [0,2,4,5],        // 1
      [1,5,6],          // 2
      [0,4,7,8],        // 3
      [0,1,3,5,8,9],    // 4
      [1,2,4,6,9,10],   // 5
      [2,5,10,11],      // 6
      [3,8,12],         // 7
      [3,4,7,9,12,13],  // 8
      [4,5,8,10,13,14], // 9  ← center
      [5,6,9,11,14,15], // 10
      [6,10,15],        // 11
      [7,8,13,16],      // 12
      [8,9,12,14,16,17],// 13
      [9,10,13,15,17,18],// 14
      [10,11,14,18],    // 15
      [12,13,17],       // 16
      [13,14,16,18],    // 17
      [14,15,17],       // 18
    ];
  }

  // Balanced tile placement: no resource type may have more than 1
  // adjacent hex of the same type (desert is exempt — it's unique).
  //
  // Algorithm: start from a random shuffle, then iteratively swap
  // a violating hex with a random non-adjacent hex of a different type.
  // Accepts the swap if it reduces or keeps the violation count
  // (hillclimbing with lateral moves to escape local minima).
  // Restarts from a fresh shuffle every 200 failed attempts.
  _balancedShuffleTiles() {
    const adj = CatanGame.HEX_ADJACENCY;

    // A violation is a pair (i,j) where i<j, tiles[i]===tiles[j], and j is adjacent to i
    const countViolations = (tiles) => {
      let v = 0;
      for (let i = 0; i < tiles.length; i++) {
        for (const j of adj[i]) {
          if (j > i && tiles[i] === tiles[j] && tiles[i] !== DESERT) v++;
        }
      }
      return v;
    };

    let tiles = this._shuffleTiles();
    let violations = countViolations(tiles);
    let attempts = 0;

    while (violations > 0 && attempts < 2000) {
      attempts++;

      // Collect all violating hexes (those with ≥1 same-type neighbor)
      const violators = [];
      for (let i = 0; i < tiles.length; i++) {
        if (adj[i].some(j => tiles[j] === tiles[i] && tiles[i] !== DESERT)) {
          violators.push(i);
        }
      }

      // Pick a random violator to fix
      const a = violators[Math.floor(Math.random() * violators.length)];

      // Candidate swap targets: non-adjacent, different type
      const nonAdj = [];
      for (let k = 0; k < tiles.length; k++) {
        if (k !== a && !adj[a].includes(k) && tiles[k] !== tiles[a]) nonAdj.push(k);
      }

      // If no valid swap exists, restart entirely
      if (nonAdj.length === 0) {
        tiles = this._shuffleTiles();
        violations = countViolations(tiles);
        continue;
      }

      const b = nonAdj[Math.floor(Math.random() * nonAdj.length)];
      [tiles[a], tiles[b]] = [tiles[b], tiles[a]];
      const newV = countViolations(tiles);

      if (newV <= violations) {
        violations = newV; // accept improvement or lateral move
      } else {
        [tiles[a], tiles[b]] = [tiles[b], tiles[a]]; // revert worsening move
      }

      // Periodic full restart to break out of deep local minima
      if (attempts % 200 === 0 && violations > 0) {
        tiles = this._shuffleTiles();
        violations = countViolations(tiles);
      }
    }

    return tiles;
  }

  // ── Vertex generation ──────────────────────────────────────────
  // Each hex has 6 corners (vertices). Adjacent hexes share vertices,
  // so we deduplicate by rounding the computed (x,y) position to 3dp.
  _generateVertices(hexes, layout) {
    const SIZE = 1; // unit hex size; all coordinates are multiples of this
    const vertices = [];
    const vertexMap = new Map(); // "x,y" → vertex id

    const getOrCreateVertex = (x, y) => {
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      if (vertexMap.has(key)) return vertexMap.get(key);
      const id = vertices.length;
      const v = { id, x, y, building: null, owner: null, port: null, adjHexes: [], adjEdges: [] };
      vertices.push(v);
      vertexMap.set(key, id);
      return id;
    };

    for (const hex of hexes) {
      const { cx, cy } = this._hexCenter(hex.row, hex.col, layout);
      hex.cx = cx;
      hex.cy = cy;
      hex.vertices = [];

      // Flat-top hex: vertex angles at -30°, 30°, 90°, 150°, 210°, 270°
      for (let i = 0; i < 6; i++) {
        const angle = Math.PI / 180 * (60 * i - 30);
        const vx = cx + SIZE * Math.cos(angle);
        const vy = cy + SIZE * Math.sin(angle);
        const vid = getOrCreateVertex(vx, vy);
        hex.vertices.push(vid);
        if (!vertices[vid].adjHexes.includes(hex.id)) {
          vertices[vid].adjHexes.push(hex.id);
        }
      }
    }

    return vertices;
  }

  // Compute the pixel centre of a hex given its row/col in the offset grid
  _hexCenter(row, col, layout) {
    const SIZE = 1;
    const W = Math.sqrt(3) * SIZE; // horizontal distance between hex centres
    const H = 2 * SIZE;             // vertical distance between hex centres
    const maxCols = Math.max(...layout);
    // Offset each row so shorter rows are centred
    const offsetX = (maxCols - layout[row]) / 2;
    const cx = (col + offsetX + 0.5) * W;
    const cy = row * H * 0.75 + SIZE;
    return { cx, cy };
  }

  // ── Edge generation ────────────────────────────────────────────
  // Edges are shared between adjacent hexes; deduplicated by the
  // sorted pair of vertex ids they connect.
  _generateEdges(vertices, hexes, layout) {
    const edges = [];
    const edgeMap = new Map();

    const getOrCreateEdge = (v1, v2) => {
      const key = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`;
      if (edgeMap.has(key)) return edgeMap.get(key);
      const id = edges.length;
      const e = { id, v1, v2, road: null, owner: null };
      edges.push(e);
      edgeMap.set(key, id);
      vertices[v1].adjEdges.push(id);
      vertices[v2].adjEdges.push(id);
      return id;
    };

    for (const hex of hexes) {
      hex.edges = [];
      const verts = hex.vertices;
      for (let i = 0; i < 6; i++) {
        const eid = getOrCreateEdge(verts[i], verts[(i + 1) % 6]);
        if (!hex.edges.includes(eid)) hex.edges.push(eid);
      }
    }

    return edges;
  }

  // ── Port generation ─────────────────────────────────────────────
  // Ports sit on outer edges of the board. We discover outer vertices
  // dynamically (those touching ≤2 hexes), sort them clockwise, then
  // pick 9 evenly-spaced consecutive border pairs and assign port types.
  // This avoids hardcoding vertex IDs that depend on generation order.
  _generatePorts(hexes, layout, vertices, edges) {
    const STANDARD_PORT_TYPES = [
      'ore',   // top-left     2:1
      'any',   // top          3:1
      'brick', // top-right    2:1
      'any',   // right-upper  3:1
      'any',   // right-lower  3:1
      'wood',  // bottom-right 2:1
      'any',   // bottom       3:1
      'wheat', // bottom-left  2:1
      'sheep', // left         2:1
    ];

    // Outer vertices: those adjacent to ≤2 hexes
    const outerVids = new Set(
      vertices.flatMap((v,i) => v.adjHexes.length <= 2 ? [i] : [])
    );

    // Sort outer vertices clockwise using their angle from the board centroid
    const outerArr = [...outerVids].map(i => ({id:i, x:vertices[i].x, y:vertices[i].y}));
    const cx = outerArr.reduce((s,v)=>s+v.x,0) / outerArr.length;
    const cy = outerArr.reduce((s,v)=>s+v.y,0) / outerArr.length;
    outerArr.sort((a,b) => Math.atan2(a.y-cy, a.x-cx) - Math.atan2(b.y-cy, b.x-cx));

    // Identify consecutive outer vertex pairs that share a board edge
    const edgeSet = new Set();
    edges.forEach(e => edgeSet.add(`${Math.min(e.v1,e.v2)}-${Math.max(e.v1,e.v2)}`));

    const borderPairs = [];
    for (let i = 0; i < outerArr.length; i++) {
      const a = outerArr[i].id;
      const b = outerArr[(i+1) % outerArr.length].id;
      const key = `${Math.min(a,b)}-${Math.max(a,b)}`;
      if (edgeSet.has(key)) borderPairs.push([a, b]);
    }

    // Choose port types (random or standard)
    let portTypes;
    if (this.randomPorts) {
      const types = [...STANDARD_PORT_TYPES];
      for (let i=types.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[types[i],types[j]]=[types[j],types[i]];}
      portTypes = types;
    } else {
      portTypes = STANDARD_PORT_TYPES;
    }

    // Distribute 9 ports evenly across the border pairs
    const total = borderPairs.length;
    const step  = total / 9;
    const chosen = Array.from({length:9}, (_,i) => borderPairs[Math.round(i*step) % total]);

    const ports = [];
    for (let i = 0; i < 9; i++) {
      const [va, vb] = chosen[i];
      const type  = portTypes[i] || 'any';
      const ratio = type === 'any' ? 3 : 2;
      const port  = { id: i, type, ratio, vertices: [va, vb] };
      ports.push(port);
      [va, vb].forEach(vid => { vertices[vid].port = { type, ratio }; });
    }
    return ports;
  }

  // ── Dev deck ───────────────────────────────────────────────────
  // VP cards each get a unique subtype ('library', 'chapel', …) so
  // skins can assign distinct names/artwork to each one.
  // debugDevCard forces the chosen card type to be last in the array
  // (deck.pop() draws from the end).
  _generateDevDeck() {
    const deck = [];
    let vpIndex = 0;
    for (const [type, count] of Object.entries(DEV_CARD_COUNTS)) {
      for (let i = 0; i < count; i++) {
        if (type === 'victoryPoint') {
          deck.push({ type, subtype: VP_SUBTYPES[vpIndex++ % VP_SUBTYPES.length] });
        } else {
          deck.push(type);
        }
      }
    }
    deck.sort(() => Math.random() - 0.5);

    if (this.debugDevCard) {
      const mi = deck.findIndex(c => (typeof c === 'object' ? c.type : c) === this.debugDevCard);
      if (mi >= 0) [deck[deck.length-1], deck[mi]] = [deck[mi], deck[deck.length-1]];
    }
    return deck;
  }

  // Setup snake-draft order: 0,1,2,3,3,2,1,0 for 4 players
  _buildSetupOrder() {
    const n = this.players.length;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    for (let i = n - 1; i >= 0; i--) order.push(i);
    return order;
  }

  // ================================================================
  //  SETUP PHASE
  // ================================================================

  placeInitialSettlement(vertexId) {
    if (this.phase !== 'setup1' && this.phase !== 'setup2') return { error: 'Not in setup phase' };
    if (this.waitingForRoad) return { error: 'Place road first' };

    const player = this.players[this.setupOrder[this.setupStep]];
    const vertex = this.board.vertices[vertexId];

    if (vertex.owner !== null) return { error: 'Vertex occupied' };
    if (!this._isValidSettlementPlacement(vertexId, null)) return { error: 'Too close to another settlement' };

    vertex.building = 'settlement';
    vertex.owner = player.id;
    player.settlements.push(vertexId);
    player.points += 1;

    this.lastSettlementPlaced = vertexId;
    this.waitingForRoad = true;

    // In setup2 (reverse round), the placed settlement gives adjacent resources
    // unless the "Start without resources" rule is active
    if (this.phase === 'setup2' && !this.zeroResources) {
      for (const hexId of vertex.adjHexes) {
        const hex = this.board.hexes[hexId];
        if (hex.resource !== DESERT) {
          player.resources[hex.resource] = (player.resources[hex.resource] || 0) + 1;
        }
      }
    }

    this._checkWin(player);
    this._log('log_place_sett', {name: player.name});
    return { ok: true };
  }

  placeInitialRoad(edgeId) {
    if (!this.waitingForRoad) return { error: 'Place settlement first' };
    const player = this.players[this.setupOrder[this.setupStep]];
    const edge = this.board.edges[edgeId];

    if (edge.owner !== null) return { error: 'Edge occupied' };

    // Setup road must touch the settlement placed in the same sub-turn
    const lastV = this.lastSettlementPlaced;
    if (edge.v1 !== lastV && edge.v2 !== lastV) return { error: 'Road must connect to settlement' };

    edge.road = 'road';
    edge.owner = player.id;
    player.roads.push(edgeId);

    this._log('log_place_road', {name: player.name});
    this.waitingForRoad = false;
    this.lastSettlementPlaced = null;

    // Don't auto-advance — player must confirm via SETUP_END_TURN.
    // This allows undo on both the settlement and road before committing.
    this.pendingSetupEndTurn = true;

    this._updateLongestRoad();
    return { ok: true };
  }

  setupEndTurn() {
    if (!this.pendingSetupEndTurn) return { error: 'Not waiting for setup end turn' };
    this.pendingSetupEndTurn = false;
    this.setupStep++;

    if (this.setupStep >= this.setupOrder.length) {
      // All setup placements done — enter main game
      this.phase = 'main';
      this.currentPlayerIndex = 0;
      this._log('log_setup_done');
      if (this.debugResources) {
        for (const p of this.players) {
          p.resources = { wood:10, brick:10, sheep:10, wheat:10, ore:10 };
        }
      }
    } else {
      // Halfway through the order → switch from forward to reverse round
      const half = this.players.length;
      if (this.setupStep === half) this.phase = 'setup2';
    }
    return { ok: true };
  }

  // ================================================================
  //  MAIN GAME
  // ================================================================

  rollDice() {
    this.lastDrawnCard = null; // clear previous drawn-card notification
    if (this.phase !== 'main') return { error: 'Not in main phase' };
    if (this.diceRolled) return { error: 'Already rolled' };

    let d1, d2;
    if (this.debugForceDice) {
      // Force a specific total while keeping both dice valid (1-6)
      const target = parseInt(this.debugForceDice);
      d1 = Math.min(6, Math.max(2, Math.ceil(target/2)));
      d2 = target - d1;
      if (d2 < 1) { d1--; d2 = target-d1; }
      if (d2 > 6) { d2 = 6; d1 = target-6; }
    } else {
      d1 = Math.floor(Math.random() * 6) + 1;
      d2 = Math.floor(Math.random() * 6) + 1;
    }
    const total = d1 + d2;
    this.diceValues = [d1, d2];
    this.diceRolled = true;

    this._log('log_roll', {name: this.currentPlayer.name, d1, d2, total});

    if (total === 7) {
      // Anyone with >7 cards must discard half (rounded down) before the robber moves
      this.pendingDiscard = this.players
        .filter(p => this._totalResources(p) > 7)
        .map(p => p.id);

      if (this.pendingDiscard.length === 0) {
        this.pendingRobber = true; // nobody discards → move robber immediately
      }
    } else {
      this._distributeResources(total);
    }

    return { ok: true, dice: [d1, d2], total };
  }

  // Give resources to every player with a settlement/city on a hex matching `number`
  // (robber hex is exempt even if the number matches)
  _distributeResources(number) {
    for (const hex of this.board.hexes) {
      if (hex.number === number && hex.id !== this.robberHexId) {
        for (const vid of hex.vertices) {
          const vertex = this.board.vertices[vid];
          if (vertex.owner !== null) {
            const player = this.players[vertex.owner];
            const isCity = vertex.building === 'city';
            if (this.citiesKnights && isCity && HEX_COMMODITY[hex.resource]) {
              // C&K: a city on a commodity hex gives 1 base resource + 1 commodity
              // (wheat/brick hexes still give the old 2x base resource, no commodity exists for them)
              player.resources[hex.resource] = (player.resources[hex.resource] || 0) + 1;
              const commodity = HEX_COMMODITY[hex.resource];
              player.commodities[commodity] = (player.commodities[commodity] || 0) + 1;
            } else {
              const amount = isCity ? 2 : 1;
              player.resources[hex.resource] = (player.resources[hex.resource] || 0) + amount;
            }
          }
        }
      }
    }
  }

  discardResources(playerId, resources) {
    const player = this.players[playerId];
    const total = this._totalResources(player);
    const discard = Object.values(resources).reduce((a, b) => a + b, 0);

    // Must discard exactly floor(total/2)
    if (discard !== Math.floor(total / 2)) return { error: 'Wrong discard amount' };

    for (const [res, amt] of Object.entries(resources)) {
      if ((player.resources[res] || 0) < amt) return { error: 'Not enough resources' };
      player.resources[res] -= amt;
    }

    this.pendingDiscard = this.pendingDiscard.filter(id => id !== playerId);

    // Once everyone has discarded, the current player moves the robber
    if (this.pendingDiscard.length === 0) {
      this.pendingRobber = true;
    }

    return { ok: true };
  }

  moveRobber(hexId) {
    if (!this.pendingRobber) return { error: 'No robber action pending' };
    if (hexId === this.robberHexId) return { error: 'Must move robber to a different hex' };

    const oldHex = this.board.hexes[this.robberHexId];
    oldHex.hasRobber = false;

    this.robberHexId = hexId;
    const newHex = this.board.hexes[hexId];
    newHex.hasRobber = true;
    this.pendingRobber = false;

    // Collect players with buildings adjacent to the new robber hex
    const candidates = new Set();
    for (const vid of newHex.vertices) {
      const vertex = this.board.vertices[vid];
      if (vertex.owner !== null && vertex.owner !== this.currentPlayerIndex) {
        candidates.add(vertex.owner);
      }
    }

    this.robberCandidates = [...candidates];

    if (this.robberCandidates.length === 1) {
      return this.stealResource(this.robberCandidates[0]); // auto-steal if only one target
    } else if (this.robberCandidates.length > 1) {
      this.pendingSteal = true; // player must choose who to steal from
    }

    return { ok: true, candidates: this.robberCandidates };
  }

  stealResource(targetPlayerId) {
    const target = this.players[targetPlayerId];

    // Pick a random resource from the target's hand
    const resources = Object.entries(target.resources)
      .filter(([, amt]) => amt > 0)
      .flatMap(([res, amt]) => Array(amt).fill(res));

    if (resources.length > 0) {
      const stolen = resources[Math.floor(Math.random() * resources.length)];
      target.resources[stolen]--;
      this.currentPlayer.resources[stolen] = (this.currentPlayer.resources[stolen] || 0) + 1;
      this._log('log_steal', {name: this.currentPlayer.name, from: target.name});
    }

    this.pendingSteal = false;
    this.robberCandidates = [];
    return { ok: true };
  }

  buildSettlement(vertexId) {
    if (!this.diceRolled) return { error: 'Roll dice first' };
    const player = this.currentPlayer;

    if (!this._canAfford(player, COSTS.settlement)) return { error: 'Not enough resources' };
    if (!this._isValidSettlementPlacement(vertexId, player.id)) return { error: 'Invalid placement' };

    const vertex = this.board.vertices[vertexId];
    vertex.building = 'settlement';
    vertex.owner = player.id;
    player.settlements.push(vertexId);
    player.points += 1;
    this._spend(player, COSTS.settlement);
    this._updateLongestRoad();
    this._checkWin(player);
    this._log('log_build_sett', {name: player.name});
    return { ok: true };
  }

  buildCity(vertexId) {
    if (!this.diceRolled) return { error: 'Roll dice first' };
    const player = this.currentPlayer;

    if (!this._canAfford(player, COSTS.city)) return { error: 'Not enough resources' };

    const vertex = this.board.vertices[vertexId];
    if (vertex.owner !== player.id || vertex.building !== 'settlement') return { error: 'No settlement here' };

    vertex.building = 'city';
    player.settlements = player.settlements.filter(id => id !== vertexId);
    player.cities.push(vertexId);
    player.points += 1; // city replaces settlement: net +1 (was already +1 from settlement)
    this._spend(player, COSTS.city);
    this._checkWin(player);
    this._log('log_build_city', {name: player.name});
    return { ok: true };
  }

  buildRoad(edgeId) {
    // Road Building card bypasses the dice-rolled check and the cost
    if (!this.diceRolled && this.pendingRoadBuilding === 0) return { error: 'Roll dice first' };
    const player = this.currentPlayer;

    if (this.pendingRoadBuilding === 0 && !this._canAfford(player, COSTS.road)) return { error: 'Not enough resources' };
    if (!this._isValidRoadPlacement(edgeId, player.id)) return { error: 'Invalid road placement' };

    const edge = this.board.edges[edgeId];
    edge.road = 'road';
    edge.owner = player.id;
    player.roads.push(edgeId);

    if (this.pendingRoadBuilding > 0) {
      this.pendingRoadBuilding--;
    } else {
      this._spend(player, COSTS.road);
    }

    this._updateLongestRoad();
    this._log('log_build_road', {name: player.name});
    return { ok: true };
  }

  buyDevCard() {
    if (!this.diceRolled) return { error: 'Roll dice first' };
    const player = this.currentPlayer;

    if (this.devDeck.length === 0) return { error: 'No dev cards left' };
    if (!this.unlimitedDev && this.devCardBoughtThisTurn) return { error: 'One dev card per turn' };
    if (!this._canAfford(player, COSTS.devCard)) return { error: 'Not enough resources' };

    const drawn = this.devDeck.pop();
    const card = typeof drawn === 'object' ? drawn.type : drawn;
    const cardSubtype = typeof drawn === 'object' ? drawn.subtype : null;

    // card.new = true means it cannot be played this turn (unless instantDev is on)
    player.devCards.push({ type: card, subtype: cardSubtype, new: !this.instantDev });
    if (card === 'victoryPoint') { player.points += 1; this._checkWin(player); }
    this._spend(player, COSTS.devCard);
    this.devCardBoughtThisTurn = true;
    this._log('log_buy_dev', {name: player.name});

    // lastDrawnCard is broadcast so the client can show a card-drawn popup
    // It is cleared at the start of the next action (rollDice / endTurn)
    this.lastDrawnCard = { playerId: player.id, card, subtype: cardSubtype };
    return { ok: true, card };
  }

  // ── Cities & Knights: buy the next level of a city-improvement track ──
  // Cost = nextLevel commodities of the track's color; level is capped at
  // the player's city count; the metropolis on a track is founded by the
  // first player to reach level 4, and seized by anyone who later reaches
  // a strictly higher level than the current holder (i.e. level 5).
  buyCityImprovement(track) {
    if (!this.citiesKnights) return { error: 'Cities & Knights variant is not enabled' };
    if (!this.diceRolled) return { error: 'Roll dice first' };
    if (!TRACK_COMMODITY[track]) return { error: 'Invalid improvement track' };

    const player = this.currentPlayer;
    const currentLevel = player.cityImprovements[track];
    if (currentLevel >= 5) return { error: 'Track already at maximum level' };

    const nextLevel = currentLevel + 1;
    if (nextLevel > player.cities.length) return { error: 'Not enough cities for this level' };

    const commodity = TRACK_COMMODITY[track];
    const cost = nextLevel;
    if ((player.commodities[commodity] || 0) < cost) return { error: `Not enough ${commodity}` };

    player.commodities[commodity] -= cost;
    player.cityImprovements[track] = nextLevel;
    this._log('log_city_improvement', { name: player.name, track, level: nextLevel });

    if (nextLevel >= 4) {
      const holder = this.metropolises[track];
      const holderLevel = holder !== null ? this.players[holder].cityImprovements[track] : 0;
      if (holder !== player.id && nextLevel > holderLevel) {
        if (holder !== null) {
          this.players[holder].points -= 2;
          this._log('log_metropolis_lost', { name: this.players[holder].name, track });
        }
        this.metropolises[track] = player.id;
        player.points += 2;
        this._log('log_metropolis_founded', { name: player.name, track });
      }
    }

    this._checkWin(player);
    return { ok: true, track, level: nextLevel };
  }

  playDevCard(cardType, params = {}) {
    // Knight is the only card playable before rolling dice
    if (!this.diceRolled && cardType !== 'knight') return { error: 'Roll dice first (except knight)' };
    const player = this.currentPlayer;

    // card.new = true cards are blocked (bought this turn, unless instantDev)
    const cardIdx = player.devCards.findIndex(c => c.type === cardType && !c.new);
    if (cardIdx === -1) return { error: 'Card not available' };

    player.devCards.splice(cardIdx, 1);
    player.playedDevCards.push(cardType);

    switch (cardType) {
      case 'knight':
        player.knightsPlayed++;
        this.pendingRobber = true;
        this._updateLargestArmy();
        break;
      case 'victoryPoint': break; // points assigned at buy time, nothing to do here
      case 'roadBuilding':
        this.pendingRoadBuilding = 2;
        break;
      case 'yearOfPlenty':
        if (params.resources) {
          for (const res of params.resources) {
            player.resources[res] = (player.resources[res] || 0) + 1;
          }
        } else {
          this.pendingYearOfPlenty = 2;
        }
        break;
      case 'monopoly':
        if (params.resource) {
          for (const p of this.players) {
            if (p.id !== player.id) {
              const amt = p.resources[params.resource] || 0;
              p.resources[params.resource] = 0;
              player.resources[params.resource] = (player.resources[params.resource] || 0) + amt;
            }
          }
        } else {
          this.pendingMonopoly = true;
        }
        break;
    }

    this._log('log_play_card', {name: player.name, card: cardType});
    return { ok: true };
  }

  // Player-to-player trade.
  // When msg.accepted is false this is just a proposal — it is stored in
  // room.pendingTrade (in index.js) and broadcast so the target sees it.
  // When msg.accepted is true the trade executes here; we validate both
  // sides before touching any resources so a blind trade (hiddenResources)
  // that turns out to be impossible fails cleanly and returns an error.
  tradeOffer(msg) {
    if (!msg.accepted) return { ok: true, pending: true };

    const from = this.players[msg.fromId];
    const to   = this.players[msg.toId];
    if (!from || !to) return { error: 'Invalid players' };

    // Validate proposer's side
    for (const [r, a] of Object.entries(msg.offer || {})) {
      const amt = parseInt(a) || 0;
      if (amt <= 0) continue;
      if ((from.resources[r] || 0) < amt)
        return { error: `${from.name} non ha abbastanza ${r} (serve ${amt}, ha ${from.resources[r]||0})` };
    }
    // Validate acceptor's side
    for (const [r, a] of Object.entries(msg.want || {})) {
      const amt = parseInt(a) || 0;
      if (amt <= 0) continue;
      if ((to.resources[r] || 0) < amt)
        return { error: `${to.name} non ha abbastanza ${r} (serve ${amt}, ha ${to.resources[r]||0})` };
    }

    // Execute the exchange atomically
    for (const [r, a] of Object.entries(msg.offer || {})) {
      const amt = parseInt(a) || 0; if (amt <= 0) continue;
      from.resources[r] -= amt;
      to.resources[r] = (to.resources[r] || 0) + amt;
    }
    for (const [r, a] of Object.entries(msg.want || {})) {
      const amt = parseInt(a) || 0; if (amt <= 0) continue;
      to.resources[r] -= amt;
      from.resources[r] = (from.resources[r] || 0) + amt;
    }

    const offerStr = Object.entries(msg.offer||{}).filter(([,v])=>v>0).map(([r,v])=>`${v}×${r}`).join('+');
    const wantStr  = Object.entries(msg.want ||{}).filter(([,v])=>v>0).map(([r,v])=>`${v}×${r}`).join('+');
    this._log('log_player_trade', {from: from.name, to: to.name, offer: offerStr, want: wantStr});
    return { ok: true };
  }

  tradeWithBank(give, receive) {
    if (!this.diceRolled) return { error: 'Roll dice first' };
    if (give === receive) return { error: 'Cannot trade same resource' };
    const player = this.currentPlayer;
    const ratio = this._getTradeRatio(player, give); // 2 if specific port, 3 if any-port, 4 otherwise
    if ((player.resources[give] || 0) < ratio) {
      return { error: `Servono ${ratio} ${give} (hai ${player.resources[give]||0})` };
    }
    player.resources[give] -= ratio;
    player.resources[receive] = (player.resources[receive] || 0) + 1;
    this._log('log_bank_trade', {name: player.name, ratio, give, receive});
    return { ok: true, ratio };
  }

  endTurn() {
    this.lastDrawnCard = null;
    if (!this.diceRolled && this.phase === 'main') return { error: 'Roll dice first' };
    if (this.pendingRobber || this.pendingSteal) return { error: 'Resolve robber first' };
    if (this.pendingTrade) return { error: 'Resolve pending trade first' };
    if (this.pendingDiscard.length > 0) return { error: 'Players must discard first' };

    // Mark all cards bought this turn as playable next turn
    for (const card of this.currentPlayer.devCards) {
      card.new = false;
    }
    this.devCardBoughtThisTurn = false;

    this.diceRolled = false;
    this.diceValues = [0, 0];
    this.pendingRoadBuilding = 0;
    this.pendingYearOfPlenty = 0;
    this.pendingMonopoly = false;

    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this._log('log_turn', {name: this.currentPlayer.name});
    return { ok: true };
  }

  // ================================================================
  //  HELPERS
  // ================================================================

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  _totalResources(player) {
    return Object.values(player.resources).reduce((a, b) => a + b, 0);
  }

  _canAfford(player, cost) {
    for (const [res, amt] of Object.entries(cost)) {
      if ((player.resources[res] || 0) < amt) return false;
    }
    return true;
  }

  _spend(player, cost) {
    for (const [res, amt] of Object.entries(cost)) {
      player.resources[res] -= amt;
    }
  }

  _isValidSettlementPlacement(vertexId, playerId) {
    const vertex = this.board.vertices[vertexId];
    if (vertex.owner !== null) return false;

    // Distance rule: no settlement may be placed adjacent to another settlement/city
    for (const eid of vertex.adjEdges) {
      const edge = this.board.edges[eid];
      const neighborId = edge.v1 === vertexId ? edge.v2 : edge.v1;
      if (this.board.vertices[neighborId].owner !== null) return false;
    }

    // In main phase, must connect to own road (not required in setup)
    if (playerId !== null && this.phase === 'main') {
      const connectedRoad = vertex.adjEdges.some(eid => this.board.edges[eid].owner === playerId);
      if (!connectedRoad) return false;
    }

    return true;
  }

  _isValidRoadPlacement(edgeId, playerId) {
    const edge = this.board.edges[edgeId];
    if (edge.owner !== null) return false;

    // Road must connect to own settlement/city OR to an existing own road
    // (but NOT through an opponent's settlement — that breaks the road)
    for (const vid of [edge.v1, edge.v2]) {
      const vertex = this.board.vertices[vid];
      if (vertex.owner === playerId) return true;
      if (vertex.owner === null || vertex.owner === playerId) {
        for (const adjEid of vertex.adjEdges) {
          if (adjEid !== edgeId && this.board.edges[adjEid].owner === playerId) return true;
        }
      }
    }
    return false;
  }

  // Return the best trade ratio available to the player for a given resource:
  // 2 if they have a specific 2:1 port, 3 if a generic 3:1 port, 4 otherwise
  _getTradeRatio(player, resource) {
    let best = 4;
    for (const v of [...player.settlements, ...player.cities]) {
      const port = this.board.vertices[v].port;
      if (!port) continue;
      if (port.type === resource) best = Math.min(best, port.ratio);
      else if (port.type === 'any') best = Math.min(best, port.ratio);
    }
    return best;
  }

  // ── Longest Road ──────────────────────────────────────────────
  // Recomputes the longest road for every player after any road/settlement
  // change. The badge (worth 2 VP) transfers to the new leader if they
  // strictly exceed the current holder. The current holder keeps it on ties.
  _updateLongestRoad() {
    const lengths = this.players.map(p => this._computeLongestRoad(p.id));
    const maxLen  = Math.max(...lengths);

    const currentHolder = this.longestRoadOwner;

    if (maxLen < 5) {
      // Nobody qualifies for the badge
      if (currentHolder !== null) {
        this.players[currentHolder].points -= 2;
        this.players[currentHolder].hasLongestRoad = false;
        this.longestRoadOwner  = null;
        this.longestRoadLength = 0;
      }
      return;
    }

    this.longestRoadLength = maxLen;

    // Tie-breaking: current holder keeps badge if still tied for max
    let newHolder = null;
    if (currentHolder !== null && lengths[currentHolder] === maxLen) {
      newHolder = currentHolder;
    } else {
      newHolder = lengths.findIndex(l => l === maxLen);
    }

    if (newHolder !== currentHolder) {
      if (currentHolder !== null) {
        this.players[currentHolder].points -= 2;
        this.players[currentHolder].hasLongestRoad = false;
      }
      this.players[newHolder].points += 2;
      this.players[newHolder].hasLongestRoad = true;
      this.longestRoadOwner  = newHolder;
      this._log('log_longest_road', {name: this.players[newHolder].name, len: maxLen});
    }
  }

  // DFS to find the longest road for a player.
  // Visits edges without repeating, starting from each end of each road.
  // An opponent's settlement at a vertex breaks the chain (cannot pass through).
  _computeLongestRoad(playerId) {
    const playerEdges = this.board.edges.filter(e => e.owner === playerId);
    if (playerEdges.length === 0) return 0;

    let maxLen = 0;

    const dfs = (edgeId, visitedEdges, lastVertex) => {
      if (visitedEdges.has(edgeId)) return 0;
      visitedEdges.add(edgeId);

      const edge = this.board.edges[edgeId];
      const nextV = edge.v1 === lastVertex ? edge.v2 : edge.v1;
      const nextVertex = this.board.vertices[nextV];

      // Opponent settlement blocks the road
      if (nextVertex.owner !== null && nextVertex.owner !== playerId) {
        visitedEdges.delete(edgeId);
        return 1;
      }

      let maxBranch = 0;
      for (const adjEid of nextVertex.adjEdges) {
        if (this.board.edges[adjEid].owner === playerId) {
          const len = dfs(adjEid, visitedEdges, nextV);
          maxBranch = Math.max(maxBranch, len);
        }
      }

      visitedEdges.delete(edgeId);
      return 1 + maxBranch;
    };

    for (const edge of playerEdges) {
      const len1 = dfs(edge.id, new Set(), edge.v1);
      const len2 = dfs(edge.id, new Set(), edge.v2);
      maxLen = Math.max(maxLen, len1, len2);
    }

    return maxLen;
  }

  // ── Largest Army ──────────────────────────────────────────────
  // Badge transfers when a player strictly exceeds the current holder's
  // knight count and has at least 3 knights played.
  _updateLargestArmy() {
    const player = this.currentPlayer;
    if (player.knightsPlayed >= 3 && player.knightsPlayed > this.largestArmySize) {
      if (this.largestArmyOwner !== null && this.largestArmyOwner !== player.id) {
        const old = this.players[this.largestArmyOwner];
        old.points -= 2;
        old.hasLargestArmy = false;
      }
      if (this.largestArmyOwner !== player.id) {
        player.points += 2;
        player.hasLargestArmy = true;
        this.largestArmyOwner = player.id;
        this._log('log_largest_army', {name: player.name});
      }
      this.largestArmySize = player.knightsPlayed;
    }
  }

  _checkWin(player) {
    if (player.points >= this.winPoints) {
      this.winner = player.id;
    }
  }

  // Prepend to log, cap at 50 entries
  _log(key, params = {}) {
    this.log.unshift({ time: Date.now(), key, params });
    if (this.log.length > 50) this.log.pop();
  }

  // ================================================================
  //  STATE SERIALISATION
  //
  //  IMPORTANT: getState() is used by broadcastState() to send the
  //  live game state to all clients on every update. Any field that
  //  the client UI depends on MUST appear here — omitting it means
  //  clients will see undefined and bugs will be subtle.
  //
  //  getSerializableState() / restoreFromState() are used only for
  //  undo: they deep-clone the full engine state so any action can
  //  be rolled back by popping the undo stack.
  // ================================================================

  getState() {
    return {
      players: this.players,
      board: this.board,
      phase: this.phase,
      currentPlayerIndex: this.currentPlayerIndex,
      setupStep: this.setupStep,
      setupOrder: this.setupOrder,
      waitingForRoad: this.waitingForRoad,
      pendingSetupEndTurn: this.pendingSetupEndTurn,
      diceRolled: this.diceRolled,
      diceValues: this.diceValues,
      robberHexId: this.robberHexId,
      pendingRobber: this.pendingRobber,
      pendingDiscard: this.pendingDiscard,
      pendingSteal: this.pendingSteal,
      robberCandidates: this.robberCandidates,
      pendingRoadBuilding: this.pendingRoadBuilding,
      pendingYearOfPlenty: this.pendingYearOfPlenty,
      pendingMonopoly: this.pendingMonopoly,
      longestRoadOwner: this.longestRoadOwner,
      longestRoadLength: this.longestRoadLength,
      largestArmyOwner: this.largestArmyOwner,
      devDeckSize: this.devDeck.length,
      devCardBoughtThisTurn: this.devCardBoughtThisTurn,
      unlimitedDev: this.unlimitedDev,
      instantDev: this.instantDev,
      winner: this.winner,
      log: this.log.slice(0, 10),
      tradeOffer: this.currentTradeOffer,
      lastDrawnCard: this.lastDrawnCard || null,
      skinId:        this.skinId,
      debugDevCard:   this.debugDevCard  || null,
      winPoints:      this.winPoints || 10,
      debugResources: this.debugResources || false,
      debugForceDice: this.debugForceDice || null,
      hiddenResources: this.hiddenResources || false,
      balancedResources: this.balancedResources || false,
      citiesKnights: this.citiesKnights || false,
      barbarianProgress: this.barbarianProgress || 0,
      metropolises: this.metropolises || { trade: null, politics: null, science: null }
    };
  }

  // Deep-clone the full engine state for undo snapshot
  getSerializableState() {
    return JSON.parse(JSON.stringify({
      players:            this.players,
      board:              this.board,
      devDeck:            this.devDeck,
      currentPlayerIndex: this.currentPlayerIndex,
      phase:              this.phase,
      setupOrder:         this.setupOrder,
      setupStep:          this.setupStep,
      waitingForRoad:     this.waitingForRoad,
      lastSettlementPlaced: this.lastSettlementPlaced,
      diceRolled:         this.diceRolled,
      diceValues:         this.diceValues,
      robberHexId:        this.robberHexId,
      longestRoadOwner:   this.longestRoadOwner,
      longestRoadLength:  this.longestRoadLength,
      largestArmyOwner:   this.largestArmyOwner,
      largestArmySize:    this.largestArmySize,
      winner:             this.winner,
      log:                this.log,
      pendingRobber:      this.pendingRobber,
      pendingDiscard:     this.pendingDiscard,
      pendingSteal:       this.pendingSteal,
      robberCandidates:   this.robberCandidates,
      pendingRoadBuilding:this.pendingRoadBuilding,
      pendingYearOfPlenty:this.pendingYearOfPlenty,
      pendingMonopoly:    this.pendingMonopoly,
      currentTradeOffer:  this.currentTradeOffer,
      skinId:             this.skinId,
      unlimitedDev:       this.unlimitedDev,
      instantDev:         this.instantDev,
      devCardBoughtThisTurn: this.devCardBoughtThisTurn,
      pendingSetupEndTurn:this.pendingSetupEndTurn,
      hiddenResources:    this.hiddenResources,
      balancedResources:  this.balancedResources,
      citiesKnights:      this.citiesKnights,
      barbarianProgress:  this.barbarianProgress,
      metropolises:       this.metropolises,
    }));
  }

  // Restore engine state from an undo snapshot
  restoreFromState(s) {
    this.players             = s.players;
    this.board               = s.board;
    this.devDeck             = s.devDeck;
    this.currentPlayerIndex  = s.currentPlayerIndex;
    this.phase               = s.phase;
    this.setupOrder          = s.setupOrder;
    this.setupStep           = s.setupStep;
    this.waitingForRoad      = s.waitingForRoad;
    this.pendingSetupEndTurn = s.pendingSetupEndTurn || false;
    this.lastSettlementPlaced= s.lastSettlementPlaced;
    this.diceRolled          = s.diceRolled;
    this.diceValues          = s.diceValues;
    this.robberHexId         = s.robberHexId;
    this.longestRoadOwner    = s.longestRoadOwner;
    this.longestRoadLength   = s.longestRoadLength;
    this.largestArmyOwner    = s.largestArmyOwner;
    this.largestArmySize     = s.largestArmySize;
    this.winner              = s.winner;
    this.log                 = s.log;
    this.pendingRobber       = s.pendingRobber;
    this.pendingDiscard      = s.pendingDiscard;
    this.skinId              = s.skinId || 'standard';
    this.unlimitedDev        = s.unlimitedDev !== false;
    this.instantDev          = !!s.instantDev;
    this.devCardBoughtThisTurn = s.devCardBoughtThisTurn || false;
    this.hiddenResources     = !!s.hiddenResources;
    this.balancedResources   = !!s.balancedResources;
    this.citiesKnights       = !!s.citiesKnights;
    this.barbarianProgress   = s.barbarianProgress || 0;
    this.metropolises        = s.metropolises || { trade: null, politics: null, science: null };
    this.pendingSteal        = s.pendingSteal;
    this.robberCandidates    = s.robberCandidates;
    this.pendingRoadBuilding = s.pendingRoadBuilding;
    this.pendingYearOfPlenty = s.pendingYearOfPlenty;
    this.pendingMonopoly     = s.pendingMonopoly;
    this.currentTradeOffer   = s.currentTradeOffer;
    // Sync hasRobber flag on hex objects (not stored per-hex in the snapshot)
    for (const h of this.board.hexes) h.hasRobber = (h.id === this.robberHexId);
  }

}
module.exports = { CatanGame };
