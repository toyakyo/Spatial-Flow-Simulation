// 室內人流模擬核心 — 不碰 DOM，瀏覽器 (main.js) 與 Node (headless.js) 共用。
// 做法：社會力模型（Social Force）+ 導航場（Dijkstra 距離場）。
//   導航場負責「繞過牆與障礙走去目標」，社會力負責「人與人、人與牆之間的推擠與閃避」。
// 標線的作用方式：
//   駐足區 stay — 守規矩的駐足者會站進區內（並挑較空的位置）；守規矩的路過者把穿越該區的路徑成本 ×4，會繞開。
//   通行帶 walk — 守規矩的路過者路徑成本 ×0.6，偏好走在帶內；守規矩的駐足者不會挑帶內的位置站。
//   「守規矩」是每個人各自抽籤（遵守率），標線總開關關掉時全部人都當標線不存在。
(function (root) {
'use strict';

const CELL = 0.3;        // 導航格邊長（公尺）
const DT = 0.05;         // 模擬步長（秒）
const HASH = 1.5;        // 鄰居搜尋格，同時是人際作用力的截斷距離
const TAU = 0.5;         // 加速到期望速度的反應時間
const K_BODY = 100;      // 身體接觸的彈性係數
const STAY_COST = 4, WALK_COST = 0.6;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const gauss = r => Math.sqrt(-2 * Math.log(1 - r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/* ---------- 場景資料 ---------- */
const TYPES = ['wall', 'pillar', 'box', 'attractor', 'entrance', 'exit', 'stay', 'walk'];

function blankScene(W = 36, H = 22) {
  return {
    v: 1, W, H, nextId: 1, objects: [],
    params: {total: 500, spawnSec: 120, compliance: 80, markings: true, seed: 1},
  };
}

// 外部輸入（JSON 檔、localStorage、server）一律走這裡，逐欄檢查，認不得的丟掉
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects)) throw new Error('不是場景檔');
  const num = (v, d, lo, hi) => { v = +v; return clamp(isFinite(v) ? v : d, lo, hi); };
  const s = blankScene(num(raw.W, 36, 10, 100), num(raw.H, 22, 8, 80));
  const p = raw.params || {};
  s.params = {
    total: Math.round(num(p.total, 500, 1, 5000)),
    spawnSec: Math.round(num(p.spawnSec, 120, 5, 1800)),
    compliance: Math.round(num(p.compliance, 80, 0, 100)),
    markings: p.markings !== false,
    seed: Math.round(num(p.seed, 1, 0, 999999)),
  };
  const seen = new Set();
  for (const o of raw.objects) {
    if (!o || !TYPES.includes(o.type)) continue;
    let id = Math.round(+o.id);
    if (!(id > 0) || seen.has(id)) id = Math.max(0, ...seen) + 1;
    seen.add(id);
    const out = {id, type: o.type};
    const X = (v, d = 0) => num(v, d, -1, s.W + 1), Y = (v, d = 0) => num(v, d, -1, s.H + 1);
    if (o.type === 'wall' || o.type === 'entrance' || o.type === 'exit') {
      out.x1 = X(o.x1); out.y1 = Y(o.y1); out.x2 = X(o.x2); out.y2 = Y(o.y2);
    } else if (o.type === 'pillar') {
      out.x = X(o.x); out.y = Y(o.y); out.r = num(o.r, 0.4, 0.1, 3);
    } else {
      out.x = X(o.x); out.y = Y(o.y); out.w = num(o.w, 2, 0.3, s.W); out.h = num(o.h, 2, 0.3, s.H);
    }
    if (o.type === 'box' || o.type === 'attractor') out.label = String(o.label || '').slice(0, 12);
    if (o.type === 'attractor') {
      out.pStop = num(o.pStop, 30, 0, 100);
      out.dwell = num(o.dwell, 40, 3, 600);
      out.attn = num(o.attn, 7, 1, 30);
    }
    if (o.type === 'entrance') { out.weight = num(o.weight, 1, 0, 100); out.dest = o.dest === 'any' ? 'any' : Math.round(+o.dest) || 'any'; }
    if (o.type === 'exit') out.weight = num(o.weight, 1, 0, 100);
    if (o.type === 'entrance' || o.type === 'exit') out.name = String(o.name || '').slice(0, 12);
    s.objects.push(out);
  }
  s.nextId = Math.max(0, ...seen) + 1;
  return s;
}

// 台南火車站前站大廳（概略示意，非實測尺寸）：南大門進、北側月台閘門出，另有月台出站的反向人流，
// 公共鋼琴就放在南進北出的主動線旁。
function demoScene() {
  const s = blankScene(36, 22);
  let id = 1;
  const add = o => s.objects.push(Object.assign({id: id++}, o));
  [[6, 6], [6, 16], [28, 6], [28, 16]].forEach(([x, y]) => add({type: 'pillar', x, y, r: 0.45}));
  add({type: 'box', x: 1.5, y: 15.5, w: 1.5, h: 5, label: '售票櫃台'});
  add({type: 'box', x: 33.3, y: 5, w: 1.2, h: 6, label: '售票機'});
  add({type: 'box', x: 24, y: 10.5, w: 5, h: 0.8, label: '候車椅'});
  add({type: 'attractor', x: 15, y: 9.2, w: 2, h: 1.6, label: '公共鋼琴', pStop: 30, dwell: 40, attn: 7});
  add({type: 'stay', x: 12.5, y: 6.5, w: 7, h: 7});
  add({type: 'walk', x: 8.2, y: 1, w: 3.8, h: 20});
  add({type: 'entrance', x1: 13, y1: 22, x2: 21, y2: 22, weight: 5, dest: 0, name: '南大門'});
  add({type: 'entrance', x1: 0, y1: 9, x2: 0, y2: 14, weight: 1.5, dest: 0, name: '西側門'});
  add({type: 'entrance', x1: 22, y1: 0, x2: 30, y2: 0, weight: 3, dest: 0, name: '月台出站'});
  add({type: 'exit', x1: 8, y1: 0, x2: 16, y2: 0, weight: 4, name: '月台閘門'});
  add({type: 'exit', x1: 22, y1: 22, x2: 30, y2: 22, weight: 3, name: '南出口'});
  const gate = s.objects.find(o => o.name === '月台閘門').id, south = s.objects.find(o => o.name === '南出口').id;
  s.objects.forEach(o => { if (o.type === 'entrance') o.dest = o.name === '月台出站' ? south : gate; });
  s.nextId = id;
  return s;
}

/* ---------- 幾何 ---------- */
// 最近點查詢的回傳值放模組變數，避免每個人每步都配置新物件
let ND = 0, NX = 0, NY = 0;   // 有號距離（表面外為正）、由障礙指向該點的單位向量

function nearest(o, px, py) {
  if (o.k === 'circ') {
    const dx = px - o.x, dy = py - o.y, d = Math.hypot(dx, dy) || 1e-6;
    ND = d - o.r; NX = dx / d; NY = dy / d;
  } else if (o.k === 'seg') {
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - o.x1) * dx + (py - o.y1) * dy) / l2, 0, 1) : 0;
    const qx = px - (o.x1 + t * dx), qy = py - (o.y1 + t * dy), d = Math.hypot(qx, qy) || 1e-6;
    ND = d - o.r; NX = qx / d; NY = qy / d;
  } else {
    const cx = clamp(px, o.x, o.x + o.w), cy = clamp(py, o.y, o.y + o.h);
    const dx = px - cx, dy = py - cy;
    if (dx || dy) { const d = Math.hypot(dx, dy); ND = d; NX = dx / d; NY = dy / d; return; }
    const l = px - o.x, r = o.x + o.w - px, t = py - o.y, b = o.y + o.h - py, m = Math.min(l, r, t, b);
    ND = -m; NX = m === l ? -1 : m === r ? 1 : 0; NY = m === t ? -1 : m === b ? 1 : 0;
    if (NX && NY) NY = 0;
  }
}

function segDist(px, py, o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - o.x1) * dx + (py - o.y1) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - o.x1 - t * dx, py - o.y1 - t * dy);
}
const rectDist = (z, px, py) => Math.hypot(px - clamp(px, z.x, z.x + z.w), py - clamp(py, z.y, z.y + z.h));
const inRect = (z, px, py) => px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h;

/* ---------- 距離場 ---------- */
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
            [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function dijkstra(nx, ny, blocked, cost, sources) {
  const dist = new Float64Array(nx * ny).fill(Infinity);   // 要與堆裡的鍵同精度，否則舊節點檢查會誤殺正常節點
  const hk = [], hi = [];
  const push = (k, i) => {
    let p = hk.length; hk.push(k); hi.push(i);
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (hk[q] <= k) break;
      hk[p] = hk[q]; hi[p] = hi[q]; p = q;
    }
    hk[p] = k; hi[p] = i;
  };
  const pop = () => {
    const i0 = hi[0], k = hk.pop(), i = hi.pop(), n = hk.length;
    if (n) {
      let p = 0;
      for (;;) {
        let c = 2 * p + 1;
        if (c >= n) break;
        if (c + 1 < n && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[p] = hk[c]; hi[p] = hi[c]; p = c;
      }
      hk[p] = k; hi[p] = i;
    }
    return i0;
  };
  for (const s of sources) { dist[s] = 0; push(0, s); }
  while (hk.length) {
    const k = hk[0], i = pop();
    if (k > dist[i]) continue;
    const x = i % nx, y = (i / nx) | 0;
    for (const [ox, oy, len] of NB) {
      const X = x + ox, Y = y + oy;
      if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const j = Y * nx + X;
      if (blocked[j]) continue;
      if (ox && oy && (blocked[y * nx + X] || blocked[Y * nx + x])) continue;   // 不抄斜角穿過牆角
      const nd = k + len * CELL * (cost[i] + cost[j]) / 2;
      if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
    }
  }
  // 每格存下「往目標」的單位方向，走路時再對四個鄰格做雙線性內插
  const dx = new Float32Array(nx * ny), dy = new Float32Array(nx * ny);
  for (let i = 0; i < dist.length; i++) {
    if (blocked[i] || !isFinite(dist[i])) continue;
    const x = i % nx, y = (i / nx) | 0;
    let gx = 0, gy = 0;
    for (const [ox, oy, len] of NB) {
      const X = x + ox, Y = y + oy;
      if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const g = dist[i] - dist[Y * nx + X];
      if (g > 0) { gx += g * ox / len; gy += g * oy / len; }
    }
    const l = Math.hypot(gx, gy);
    if (l > 1e-6) { dx[i] = gx / l; dy[i] = gy / l; }
  }
  return {dist, dx, dy};
}

/* ---------- 模擬 ---------- */
class Sim {
  // opts: {seed, markings, total} 可覆蓋場景內的參數，批次比較時用
  constructor(scene, opts = {}) {
    const P = scene.params;
    this.scene = scene;
    this.W = scene.W; this.H = scene.H;
    this.total = opts.total ?? P.total;
    this.spawnSec = P.spawnSec;
    this.compliance = P.compliance / 100;
    this.markings = opts.markings ?? P.markings;
    this.seed = opts.seed ?? P.seed;

    const of = t => scene.objects.filter(o => o.type === t);
    this.entrances = of('entrance').filter(o => o.weight > 0);
    this.exits = of('exit').filter(o => o.weight > 0);
    this.attractors = of('attractor');
    this.stays = of('stay');
    this.walks = of('walk');
    this.obs = [];
    for (const o of scene.objects) {
      if (o.type === 'wall') this.obs.push({k: 'seg', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, r: 0.1});
      else if (o.type === 'pillar') this.obs.push({k: 'circ', x: o.x, y: o.y, r: o.r});
      else if (o.type === 'box' || o.type === 'attractor') this.obs.push({k: 'rect', x: o.x, y: o.y, w: o.w, h: o.h});
    }
    for (const b of this.obs) {            // 外接框，作用力查詢時先用它快速排除
      if (b.k === 'circ') { b.x0 = b.x - b.r; b.y0 = b.y - b.r; b.x1b = b.x + b.r; b.y1b = b.y + b.r; }
      else if (b.k === 'seg') { b.x0 = Math.min(b.x1, b.x2) - b.r; b.y0 = Math.min(b.y1, b.y2) - b.r; b.x1b = Math.max(b.x1, b.x2) + b.r; b.y1b = Math.max(b.y1, b.y2) + b.r; }
      else { b.x0 = b.x; b.y0 = b.y; b.x1b = b.x + b.w; b.y1b = b.y + b.h; }
    }

    this.agents = [];
    this.t = 0; this.spawned = 0; this.owed = 0; this.nextSample = 0;
    this.fields = new Map();
    this._buildNav();

    this.hx = Math.ceil(this.W / HASH) + 1; this.hy = Math.ceil(this.H / HASH) + 1;
    this.head = new Int32Array(this.hx * this.hy);
    this.next = new Int32Array(0);

    this.dnx = Math.ceil(this.W); this.dny = Math.ceil(this.H);          // 密度格：1 公尺
    this.heatAcc = new Float32Array(this.dnx * this.dny);
    this.heatN = 0;
    this.samples = [];
    this.peakNow = 0;
    this.st = {pass: {n: 0, T: 0, ideal: 0}, stop: {n: 0, T: 0, ideal: 0, dwell: 0}, exited: 0};
    this.finished = false;
    this.noFlow = !this.entrances.length || !this.exits.length;
    this.ex = 0; this.ey = 0;
  }

  _buildNav() {
    const nx = this.nx = Math.ceil(this.W / CELL), ny = this.ny = Math.ceil(this.H / CELL);
    const N = nx * ny;
    const clear = new Float32Array(N).fill(9);
    for (const b of this.obs) {
      const m = 2.5;
      const x0 = Math.max(0, Math.floor((b.x0 - m) / CELL)), x1 = Math.min(nx - 1, Math.ceil((b.x1b + m) / CELL));
      const y0 = Math.max(0, Math.floor((b.y0 - m) / CELL)), y1 = Math.min(ny - 1, Math.ceil((b.y1b + m) / CELL));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        nearest(b, (x + 0.5) * CELL, (y + 0.5) * CELL);
        const i = y * nx + x;
        if (ND < clear[i]) clear[i] = ND;
      }
    }
    this.clear = clear;
    this.blocked = new Uint8Array(N);
    this.costP = new Float32Array(N);
    this.costM = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.blocked[i] = clear[i] < 0.24 ? 1 : 0;
      this.costP[i] = this.costM[i] = 1 + Math.max(0, 0.8 - clear[i]) * 2;   // 貼牆走比較貴，人會稍微離牆
    }
    for (const z of [...this.stays, ...this.walks]) {
      const mul = z.type === 'stay' ? STAY_COST : WALK_COST;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
        if (inRect(z, (x + 0.5) * CELL, (y + 0.5) * CELL)) this.costM[y * nx + x] *= mul;
    }
    this.hasZones = this.stays.length + this.walks.length > 0;
  }

  _field(key, build) {
    let f = this.fields.get(key);
    if (!f) { f = build(); this.fields.set(key, f); }
    return f;
  }
  _exitField(ex, marked) {
    return this._field('x' + ex.id + (marked ? 'm' : 'p'), () => {
      const src = [];
      for (let y = 0; y < this.ny; y++) for (let x = 0; x < this.nx; x++)
        if (segDist((x + 0.5) * CELL, (y + 0.5) * CELL, ex) < 0.8) src.push(y * this.nx + x);
      return dijkstra(this.nx, this.ny, this.blocked, marked ? this.costM : this.costP, src);
    });
  }
  _attrField(at) {
    return this._field('a' + at.id, () => {
      const src = [];
      for (let y = 0; y < this.ny; y++) for (let x = 0; x < this.nx; x++)
        if (!this.blocked[y * this.nx + x] && rectDist(at, (x + 0.5) * CELL, (y + 0.5) * CELL) < 1.0) src.push(y * this.nx + x);
      return dijkstra(this.nx, this.ny, this.blocked, this.costP, src);
    });
  }

  // 在場景座標取導航場方向，結果放 this.ex/ey；四周都沒有方向資料時回傳 false
  _dir(f, x, y) {
    const gx = x / CELL - 0.5, gy = y / CELL - 0.5, ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    let sx = 0, sy = 0;
    for (let k = 0; k < 4; k++) {
      const ox = k & 1, oy = k >> 1, cx = ix + ox, cy = iy + oy;
      if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) continue;
      const i = cy * this.nx + cx, w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
      sx += w * f.dx[i]; sy += w * f.dy[i];
    }
    const l = Math.hypot(sx, sy);
    if (l < 1e-4) return false;
    this.ex = sx / l; this.ey = sy / l;
    return true;
  }

  _free(x, y, margin) {
    if (x < margin || y < margin || x > this.W - margin || y > this.H - margin) return false;
    for (const b of this.obs) {
      if (x < b.x0 - margin || x > b.x1b + margin || y < b.y0 - margin || y > b.y1b + margin) continue;
      nearest(b, x, y);
      if (ND < margin) return false;
    }
    return true;
  }
  _los(x1, y1, x2, y2) {
    const d = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(d / 0.25);
    for (let i = 1; i < n; i++) {
      const t = i / n, cx = Math.floor((x1 + (x2 - x1) * t) / CELL), cy = Math.floor((y1 + (y2 - y1) * t) / CELL);
      if (this.blocked[cy * this.nx + cx]) return false;
    }
    return true;
  }

  /* ----- 產生人 ----- */
  _makeAgent(k) {
    const rng = mulberry32((this.seed * 1000003 + k * 7919 + 12345) >>> 0);
    const pickW = (list, w) => {
      let u = rng() * list.reduce((a, o) => a + w(o), 0);
      for (const o of list) { u -= w(o); if (u <= 0) return o; }
      return list[list.length - 1];
    };
    const en = pickW(this.entrances, o => o.weight);
    const t = rng();
    const px = en.x1 + (en.x2 - en.x1) * (0.1 + 0.8 * t), py = en.y1 + (en.y2 - en.y1) * (0.1 + 0.8 * t);
    // 入口大多貼在邊界上，往場地中心的那一側推進 0.4 公尺再出生
    let nx = -(en.y2 - en.y1), ny = en.x2 - en.x1;
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    if (nx * (this.W / 2 - px) + ny * (this.H / 2 - py) < 0) { nx = -nx; ny = -ny; }
    const exU = rng();
    let pool = this.exits.filter(e => e.id === en.dest);
    if (!pool.length) {
      pool = this.exits.filter(e => Math.hypot((e.x1 + e.x2) / 2 - px, (e.y1 + e.y2) / 2 - py) > 3);
      if (!pool.length) pool = this.exits;
    }
    let u = exU * pool.reduce((a, o) => a + o.weight, 0), exit = pool[pool.length - 1];
    for (const e of pool) { u -= e.weight; if (u <= 0) { exit = e; break; } }
    const a = {
      x: px + nx * 0.4, y: py + ny * 0.4, vx: 0, vy: 0,
      r: clamp(0.23 + gauss(rng) * 0.02, 0.18, 0.3),
      v0: clamp(1.34 + gauss(rng) * 0.25, 0.8, 1.9),
      st: 0, exit, comply: rng() < this.compliance, uStop: rng() * 100, zDwell: gauss(rng),
      attr: null, spot: null, visited: false, dwellLeft: 0, approachT: 0,
      t0: this.t, stoppedT: 0, ideal: 0, rng, dead: false, ex: 0, ey: 0, speed: 0,
    };
    a.ideal = this._exitField(exit, false).dist[Math.floor(a.y / CELL) * this.nx + Math.floor(a.x / CELL)] / a.v0;
    if (!isFinite(a.ideal)) a.ideal = 0;
    return a;
  }

  _spawn() {
    if (this.noFlow || this.spawned >= this.total) return;
    this.owed = Math.min(this.owed + this.total / this.spawnSec * DT, this.total - this.spawned);
    while (this.owed >= 1) {
      const a = this._makeAgent(this.spawned);
      if (!this._free(a.x, a.y, a.r)) break;
      let ok = true;
      for (const b of this.agents) if (Math.abs(b.x - a.x) < 0.5 && Math.abs(b.y - a.y) < 0.5) { ok = false; break; }
      if (!ok) break;                                   // 入口前堵住了：人留在「排隊」，下一步再試
      this.agents.push(a); this.spawned++; this.owed--;
    }
  }
  get queued() { return Math.floor(this.owed); }

  /* ----- 駐足 ----- */
  _decideStop(a) {
    for (const at of this.attractors) {
      const cx = at.x + at.w / 2, cy = at.y + at.h / 2;
      if (Math.hypot(a.x - cx, a.y - cy) > at.attn) continue;
      a.visited = true;                                 // 靠近時抽一次籤，抽不中就不會再回頭看
      if (a.uStop >= at.pStop) return;
      a.attr = at; a.st = 1; a.approachT = 0;
      a.spot = this._pickSpot(a, at);
      a.dwellLeft = Math.max(5, at.dwell * (1 + 0.4 * a.zDwell));
      return;
    }
  }
  _marked(a) { return this.markings && a.comply && this.hasZones; }

  _pickSpot(a, at) {
    const rng = a.rng, cx = at.x + at.w / 2, cy = at.y + at.h / 2;
    let zone = null;
    if (this._marked(a)) {
      let best = 4;
      for (const z of this.stays) { const d = rectDist(z, cx, cy); if (d < best) { best = d; zone = z; } }
    }
    let spot = null, bestScore = Infinity;
    for (let k = 0; k < (zone ? 12 : 6); k++) {
      let x, y;
      if (zone) { x = zone.x + rng() * zone.w; y = zone.y + rng() * zone.h; }
      else {                                            // 沒標線：貼著吸引物外緣隨意圍成一圈
        const th = rng() * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
        const sup = Math.min(at.w / 2 / (Math.abs(c) || 1e-6), at.h / 2 / (Math.abs(s) || 1e-6));
        const rho = sup + 0.5 + rng() * 1.3;
        x = cx + c * rho; y = cy + s * rho;
      }
      if (!this._free(x, y, a.r + 0.1)) continue;
      if (zone && this.walks.some(w => inRect(w, x, y))) continue;
      let score = 0;
      if (zone) for (const b of this.agents) if (b.spot && Math.hypot(b.spot.x - x, b.spot.y - y) < 0.6) score++;
      if (score < bestScore) { bestScore = score; spot = {x, y}; }
      if (!zone || score === 0) break;
    }
    return spot || {x: cx, y: at.y + at.h + 1};
  }

  /* ----- 一步 ----- */
  step() {
    this.t += DT;
    this._spawn();
    const A = this.agents, n = A.length;
    if (this.next.length < n) this.next = new Int32Array(n * 2);
    this.head.fill(-1);
    for (let i = 0; i < n; i++) {
      const a = A[i];
      const h = Math.floor(clamp(a.y, 0, this.H) / HASH) * this.hx + Math.floor(clamp(a.x, 0, this.W) / HASH);
      this.next[i] = this.head[h]; this.head[h] = i;
    }

    for (let i = 0; i < n; i++) {
      const a = A[i];
      let v0 = a.v0, dirOk = false;
      if (a.st === 0) {
        if (!a.visited && this.attractors.length) this._decideStop(a);
      }
      if (a.st === 0) {
        dirOk = this._dir(this._exitField(a.exit, this._marked(a)), a.x, a.y);
        if (!dirOk) this._toward(a, (a.exit.x1 + a.exit.x2) / 2, (a.exit.y1 + a.exit.y2) / 2);
      } else if (a.st === 1) {
        a.approachT += DT;
        const d = Math.hypot(a.spot.x - a.x, a.spot.y - a.y);
        if (d < 0.45 || a.approachT > 30) a.st = 2;   // 到位，或在人群裡擠不進去就地停下
        else if (d < 4 && this._los(a.x, a.y, a.spot.x, a.spot.y)) this._toward(a, a.spot.x, a.spot.y);
        else if (!this._dir(this._attrField(a.attr), a.x, a.y)) this._toward(a, a.spot.x, a.spot.y);
      }
      if (a.st === 2) {
        a.stoppedT += DT; a.dwellLeft -= DT;
        const d = Math.hypot(a.spot.x - a.x, a.spot.y - a.y);
        v0 = d < 0.08 ? 0 : Math.min(0.6, d * 1.5);
        if (d > 1e-6) { this.ex = (a.spot.x - a.x) / d; this.ey = (a.spot.y - a.y) / d; } else { this.ex = this.ey = 0; }
        if (a.dwellLeft <= 0) { a.st = 0; a.spot = null; a.attr = null; }
      }
      a.ex = this.ex; a.ey = this.ey;
      let ax = (v0 * this.ex - a.vx) / TAU, ay = (v0 * this.ey - a.vy) / TAU;

      // 人與人
      const gx = Math.floor(clamp(a.x, 0, this.W) / HASH), gy = Math.floor(clamp(a.y, 0, this.H) / HASH);
      for (let cy = Math.max(0, gy - 1); cy <= Math.min(this.hy - 1, gy + 1); cy++)
        for (let cx = Math.max(0, gx - 1); cx <= Math.min(this.hx - 1, gx + 1); cx++)
          for (let j = this.head[cy * this.hx + cx]; j !== -1; j = this.next[j]) {
            if (j === i) continue;
            const b = A[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
            if (d2 > HASH * HASH || d2 < 1e-8) continue;
            const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, rij = a.r + b.r;
            // 走路的人對站著不動的人保持更大的距離（看得到、繞得開）；後方的人影響較小
            const still = b.st === 2 && a.st !== 2;
            const w = 0.4 + 0.6 * (1 - (a.ex * nx + a.ey * ny)) / 2;
            let f = (still ? 6 : 5) * Math.exp((rij - d) / (still ? 0.45 : 0.3)) * w;
            if (d < rij) f += K_BODY * (rij - d);
            ax += f * nx; ay += f * ny;
          }
      // 人與牆、柱、障礙物
      for (const b of this.obs) {
        if (a.x < b.x0 - 1.5 || a.x > b.x1b + 1.5 || a.y < b.y0 - 1.5 || a.y > b.y1b + 1.5) continue;
        nearest(b, a.x, a.y);
        if (ND > 1.5) continue;
        let f = 8 * Math.exp((a.r - ND) / 0.2);
        if (ND < a.r) f += K_BODY * (a.r - ND);
        ax += f * NX; ay += f * NY;
      }
      a.vx += ax * DT; a.vy += ay * DT;
      const sp = Math.hypot(a.vx, a.vy), cap = Math.max(a.v0, 0.8) * 1.3;
      if (sp > cap) { a.vx *= cap / sp; a.vy *= cap / sp; }
    }

    for (const a of A) {
      a.x += a.vx * DT; a.y += a.vy * DT;
      // 硬碰撞：真的陷進障礙就推回表面，並拿掉朝內的速度分量，避免穿牆
      for (const b of this.obs) {
        if (a.x < b.x0 - 1 || a.x > b.x1b + 1 || a.y < b.y0 - 1 || a.y > b.y1b + 1) continue;
        nearest(b, a.x, a.y);
        const lim = a.r * 0.85;
        if (ND < lim) {
          a.x += NX * (lim - ND); a.y += NY * (lim - ND);
          const vn = a.vx * NX + a.vy * NY;
          if (vn < 0) { a.vx -= vn * NX; a.vy -= vn * NY; }
        }
      }
      a.x = clamp(a.x, a.r, this.W - a.r); a.y = clamp(a.y, a.r, this.H - a.r);
      a.speed = Math.hypot(a.vx, a.vy);
      if (a.st === 0 && segDist(a.x, a.y, a.exit) < 0.7) this._leave(a);
    }
    if (A.some(a => a.dead)) this.agents = A.filter(a => !a.dead);

    if (this.t >= this.nextSample) { this.nextSample += 1; this._sample(); }
    if (!this.finished && !this.noFlow && this.spawned >= this.total && this.agents.length === 0) this.finished = true;
    if (!this.finished && this.t > this.spawnSec + 900) this.finished = true;   // 擠死了也要收尾
  }

  _toward(a, x, y) {
    const d = Math.hypot(x - a.x, y - a.y) || 1;
    this.ex = (x - a.x) / d; this.ey = (y - a.y) / d;
  }

  _leave(a) {
    a.dead = true;
    const T = this.t - a.t0, g = a.stoppedT > 0 ? this.st.stop : this.st.pass;
    g.n++; g.T += T; g.ideal += a.ideal;
    if (g === this.st.stop) g.dwell += a.stoppedT;
    this.st.exited++;
  }

  densityNow() {
    const d = new Float32Array(this.dnx * this.dny);
    for (const a of this.agents) {
      const x = Math.min(this.dnx - 1, Math.max(0, Math.floor(a.x))), y = Math.min(this.dny - 1, Math.max(0, Math.floor(a.y)));
      d[y * this.dnx + x]++;
    }
    return d;
  }

  _sample() {
    const d = this.densityNow();
    let peak = 0;
    for (let i = 0; i < d.length; i++) { this.heatAcc[i] += d[i]; if (d[i] > peak) peak = d[i]; }
    this.heatN++;
    this.peakNow = peak;
    let w = 0, slow = 0, vs = 0, stopped = 0, appr = 0;
    for (const a of this.agents) {
      if (a.st === 2) stopped++;
      else if (a.st === 1) appr++;
      else { w++; vs += a.speed; if (a.speed < 0.5) slow++; }
    }
    this.samples.push({t: this.t, present: this.agents.length, walking: w, stopped, appr,
      v: w ? vs / w : 0, slow: w ? slow / w : 0, peak});
  }

  // 彙總。平均速度與擁擠指數用「走路人數」加權，整場只有幾個人在走的時刻不會拉偏
  summary() {
    const S = this.samples, wsum = S.reduce((a, s) => a + s.walking, 0) || 1;
    const p = this.st.pass, s = this.st.stop, all = p.n + s.n || 1;
    return {
      t: this.t, spawned: this.spawned, exited: this.st.exited, present: this.agents.length,
      passN: p.n, stopN: s.n,
      passDelay: p.n ? (p.T - p.ideal) / p.n : 0,
      passTime: p.n ? p.T / p.n : 0,
      allTime: (p.T + s.T) / all,
      stopDwell: s.n ? s.dwell / s.n : 0,
      speed: S.reduce((a, x) => a + x.v * x.walking, 0) / wsum,
      slowPct: S.reduce((a, x) => a + x.slow * x.walking, 0) / wsum * 100,
      peak: S.reduce((a, x) => Math.max(a, x.peak), 0),
    };
  }
}

const api = {Sim, normalize, blankScene, demoScene, mulberry32, DT, CELL};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.PedSim = api;
})(typeof self !== 'undefined' ? self : this);
