// 室內人流模擬器 — 編輯器與繪圖。模擬本體在 sim.js（無 DOM，Node 也能跑）。
// 場景資料就是 sim.js 的 scene 物件，直接 JSON.stringify 存檔；編輯任何東西都會讓進行中的模擬作廢重來。
// ponytail: 標線目前只有矩形（駐足區、通行帶）。要做圓弧或任意多邊形時，改 sim.js 的 inRect/rectDist 與這裡的畫法。

const {Sim, normalize, blankScene, demoScene, DT} = PedSim;

const LS_KEY = 'ipf-scene-v1';
const TOOLS = [
  {k: 'select',    t: '選取／移動', i: '↖', help: '點選物件；拖曳可移動'},
  {k: 'wall',      t: '牆',         i: '▬', help: '拖曳畫一道牆（門口請在牆上留缺口）', line: true},
  {k: 'fence',     t: '圍欄',       i: '┆', help: '拖曳畫伸縮圍欄（紅龍柱）：實體、誰都過不去，只在「啟用標線」時存在', line: true},
  {k: 'pillar',    t: '柱子',      i: '●', help: '點一下放置圓柱'},
  {k: 'box',       t: '障礙物',     i: '▭', help: '拖曳畫矩形：售票機、長椅、花台…', rect: true, dw: 1.5, dh: 1.5},
  {k: 'attractor', t: '吸引物',     i: '♪', help: '拖曳畫矩形：公共鋼琴、展示、快閃攤…', rect: true, dw: 2, dh: 1.6},
  {k: 'entrance',  t: '入口',       i: '⇥', help: '拖曳畫一段入口線，人從這裡出生', line: true},
  {k: 'exit',      t: '出口',       i: '⇤', help: '拖曳畫一段出口線，人走到這裡離場', line: true},
  {k: 'stay',      t: '駐足線區',   i: '▦', help: '拖曳畫標線區：要求駐足者站在這裡，路過者繞開', rect: true, dw: 6, dh: 6},
  {k: 'walk',      t: '通行帶',     i: '⇉', help: '拖曳畫標線帶：引導路過者走在這裡', rect: true, dw: 3, dh: 6},
  {k: 'erase',     t: '刪除',       i: '✕', help: '點物件即刪除'},
];
const TYPE_NAME = {wall: '牆', fence: '圍欄', pillar: '柱子', box: '障礙物', attractor: '吸引物', entrance: '入口', exit: '出口', stay: '駐足線區', walk: '通行帶'};
const COLOR = {fence: '#d98cb3', entrance: '#39c06a', exit: '#e0735c', stay: '#e9b13a', walk: '#4cc3d9', attractor: '#b57bee'};

let scene = loadSaved() || demoScene();
let tool = TOOLS[0], sel = null, drag = null, preview = null, hover = null;
let sim = null, running = false, speed = 5, heat = 'off', S = 24, busy = false;

const $ = id => document.getElementById(id);
const cv = $('board'), ctx = cv.getContext('2d');
const note = $('note'), playBtn = $('play');
const find = id => scene.objects.find(o => o.id === id);

/* ---------- 存取 ---------- */
function loadSaved() {
  try { return normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch (e) { return null; }
}
function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify(scene)); } catch (e) { /* 無痕模式等 */ } }

// 任何編輯：模擬作廢、存檔、重畫。remake=true 時連右欄一起重建
function edited(remake) {
  sim = null;
  stopRun();
  persist();
  draw(); showMetrics();
  if (remake) inspect();
}

function setScene(next, msg) {
  scene = next; sel = null;
  syncPanel(); resize(); edited(true);
  if (msg) note.textContent = msg;
}

/* ---------- 左欄 ---------- */
const toolBox = $('tools');
TOOLS.forEach(t => {
  const b = document.createElement('button');
  b.innerHTML = `<i>${t.i}</i>${t.t}`;
  b.onclick = () => { tool = t; syncTools(); };
  toolBox.appendChild(b);
});
function syncTools() {
  [...toolBox.children].forEach((b, i) => b.setAttribute('aria-pressed', TOOLS[i] === tool));
  cv.style.cursor = tool.k === 'select' ? 'default' : tool.k === 'erase' ? 'not-allowed' : 'crosshair';
  $('hint').textContent = tool.help;
}

const PRESET_TOTALS = ['100', '300', '500', '1000', '2000'];
function syncPanel() {
  const P = scene.params;
  $('totalSel').value = PRESET_TOTALS.includes(String(P.total)) ? String(P.total) : 'custom';
  $('customRow').hidden = $('totalSel').value !== 'custom';
  $('totalNum').value = P.total;
  $('spawnSec').value = P.spawnSec;
  $('seed').value = P.seed;
  $('markings').checked = P.markings;
  $('compliance').value = P.compliance;
  $('compVal').textContent = P.compliance;
  $('worldW').value = scene.W; $('worldH').value = scene.H;
}

function param(key, val) { scene.params[key] = val; edited(false); }
$('totalSel').onchange = e => {
  const custom = e.target.value === 'custom';
  $('customRow').hidden = !custom;
  if (!custom) { $('totalNum').value = e.target.value; param('total', +e.target.value); }
};
$('totalNum').onchange = e => { const v = Math.round(clampNum(e.target.value, 1, 5000)); e.target.value = v; param('total', v); };
$('spawnSec').onchange = e => { const v = Math.round(clampNum(e.target.value, 5, 1800)); e.target.value = v; param('spawnSec', v); };
$('seed').onchange = e => { const v = Math.round(clampNum(e.target.value, 0, 999999)); e.target.value = v; param('seed', v); };
// 沒有圍欄時，標線開關可以在模擬途中切換：新的路徑與新的駐足選位立刻生效，已站定的人不會被搬走。
// 有圍欄時它會改變場地幾何，必須重來。
$('markings').onchange = e => {
  scene.params.markings = e.target.checked;
  if (scene.objects.some(o => o.type === 'fence')) { edited(false); note.textContent = '場景有圍欄，切換標線後模擬已重置。'; return; }
  if (sim) sim.markings = e.target.checked;
  persist(); draw();
};
$('compliance').oninput = e => { $('compVal').textContent = e.target.value; };
$('compliance').onchange = e => param('compliance', +e.target.value);
$('worldW').onchange = $('worldH').onchange = () => {
  scene.W = Math.round(clampNum($('worldW').value, 10, 100));
  scene.H = Math.round(clampNum($('worldH').value, 8, 80));
  syncPanel(); resize(); edited(true);
};
$('speed').onchange = e => { speed = +e.target.value; };
$('heat').onchange = e => { heat = e.target.value; draw(); };

function clampNum(v, lo, hi) { v = +v; return Math.min(hi, Math.max(lo, isFinite(v) ? v : lo)); }

$('demo').onclick = () => setScene(demoScene(), '已載入範例場景。');
$('wipe').onclick = () => {
  if (!confirm('清空整個場地？所有物件都會消失，無法復原。')) return;
  setScene(blankScene(scene.W, scene.H), '場地已清空。');
};
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(scene, null, 1)], {type: 'application/json'}));
  a.download = 'scene.json'; a.click(); URL.revokeObjectURL(a.href);
  note.textContent = '已存成 scene.json。';
};
$('load').onclick = () => $('file').click();
$('file').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const fr = new FileReader();
  fr.onerror = () => note.textContent = '讀檔失敗。';
  fr.onload = () => {
    try { setScene(normalize(JSON.parse(fr.result)), `已載入 ${f.name}。`); }
    catch (err) { note.textContent = '載入失敗：' + err.message; }
  };
  fr.readAsText(f);
};

/* ---------- server.py（有的話才出現） ---------- */
const srv = {
  list: () => fetch('api/scenes').then(r => r.ok ? r.json() : Promise.reject()),
  get: n => fetch('api/scenes/' + encodeURIComponent(n)).then(r => r.ok ? r.json() : Promise.reject(new Error('讀取失敗'))),
  put: (n, body) => fetch('api/scenes/' + encodeURIComponent(n), {method: 'PUT', body}).then(r => r.ok || Promise.reject(new Error('寫入失敗'))),
};
function refreshServerList(keep) {
  srv.list().then(names => {
    $('serverBox').hidden = false;
    const el = $('srvList');
    el.innerHTML = '';
    el.add(new Option('— 從伺服器載入 —', ''));
    names.forEach(n => el.add(new Option(n, n)));
    el.value = keep || '';
  }).catch(() => { $('serverBox').hidden = true; });
}
$('srvList').onchange = e => {
  const n = e.target.value;
  if (!n) return;
  srv.get(n).then(d => setScene(normalize(d), `已從伺服器載入 ${n}。`)).catch(err => note.textContent = err.message);
};
$('srvSave').onclick = () => {
  const n = (prompt('場景名稱（英數與 - _）', 'my-scene') || '').trim();
  if (!/^[\w-]{1,40}$/.test(n)) { if (n) note.textContent = '名稱只能用英數、- 與 _。'; return; }
  srv.put(n, JSON.stringify(scene, null, 1))
    .then(() => { note.textContent = `已存到伺服器：scenes/${n}.json`; refreshServerList(n); })
    .catch(err => note.textContent = err.message);
};

/* ---------- 版面 ---------- */
function resize() {
  S = Math.max(10, Math.min(30, Math.floor(1000 / scene.W)));
  cv.width = scene.W * S; cv.height = scene.H * S;
}

/* ---------- 模擬控制 ---------- */
let last = 0, stepAcc = 0;
function stopRun() {
  running = false;
  playBtn.textContent = sim && !sim.finished ? '繼續' : '開始';
  playBtn.setAttribute('aria-pressed', false);
}
function startRun() {
  if (busy) return;
  if (!sim || sim.finished) {
    sim = new Sim(scene);
    if (sim.noFlow) { sim = null; note.textContent = '至少需要一個入口和一個出口。'; return; }
    $('result').hidden = true;
  }
  running = true; last = performance.now(); stepAcc = 0;
  playBtn.textContent = '暫停';
  playBtn.setAttribute('aria-pressed', true);
  requestAnimationFrame(loop);
}
playBtn.onclick = () => running ? (stopRun(), draw()) : startRun();
$('reset').onclick = () => { stopRun(); sim = null; playBtn.textContent = '開始'; $('result').hidden = true; draw(); showMetrics(); note.textContent = '已重置。'; };

function loop(now) {
  if (!running) return;
  stepAcc += Math.min(0.05, (now - last) / 1000) * speed / DT;
  last = now;
  const t0 = performance.now();
  while (stepAcc >= 1 && performance.now() - t0 < 14 && !sim.finished) { sim.step(); stepAcc--; }
  if (stepAcc > 30) stepAcc = 30;                          // 算不過來就放慢，不要越積越多
  draw(); showMetrics();
  if (sim.finished) {
    stopRun(); playBtn.textContent = '開始';
    note.textContent = `模擬結束：${sim.t.toFixed(0)} 秒，${sim.st.exited}/${sim.total} 人離場。`;
    return;
  }
  requestAnimationFrame(loop);
}

/* ---------- 批次比較：同一個種子，標線關／開各跑到結束 ---------- */
function runToEnd(s, label) {
  return new Promise(done => {
    const go = () => {
      const t0 = performance.now();
      while (!s.finished && performance.now() - t0 < 30) s.step();
      note.textContent = `${label}：模擬 ${s.t.toFixed(0)} 秒，場內 ${s.agents.length} 人`;
      s.finished ? done() : setTimeout(go, 0);
    };
    go();
  });
}
$('compare').onclick = async () => {
  if (busy) return;
  stopRun(); sim = null; busy = true;
  $('compare').disabled = true; playBtn.disabled = true;
  try {
    const probe = new Sim(scene);
    if (probe.noFlow) { note.textContent = '至少需要一個入口和一個出口。'; return; }
    const out = [];
    for (const [m, label] of [[false, '無標線'], [true, '有標線']]) {
      const s = new Sim(scene, {markings: m});
      await runToEnd(s, label);
      out.push(s.summary());
    }
    showResult(out);
    note.textContent = '批次比較完成，結果在右欄。';
  } finally {
    busy = false; $('compare').disabled = false; playBtn.disabled = false;
    playBtn.textContent = '開始'; draw(); showMetrics();
  }
};

const ROWS = [
  ['完成時間 (秒)', 'ts', 0, -1],
  ['路過者平均延遲 (秒)', 'passDelay', 1, -1],
  ['路過者平均通過 (秒)', 'passTime', 1, -1],
  ['平均步行速度 (m/s)', 'speed', 2, 1],
  ['擁擠指數 (%)', 'slowPct', 1, -1],
  ['最高格密度 (人/m²)', 'peak', 0, -1],
  ['駐足人數', 'stopN', 0, 0],
  ['平均駐足 (秒)', 'stopDwell', 0, 0],
];
function showResult([off, on]) {
  off.ts = off.t; on.ts = on.t;
  const el = $('result');
  el.hidden = false;
  const P = scene.params, n = off.exited;
  let h = `<h2>標線 有／無 比較</h2><p class="empty small">${n} 人 · 種子 ${P.seed} · 遵守率 ${P.compliance}%</p>
    <table><tr><th></th><th>無</th><th>有</th><th>差</th></tr>`;
  for (const [label, key, dp, good] of ROWS) {
    const a = off[key], b = on[key], d = b - a;
    const rel = a ? d / a : 0;
    const cls = !good || Math.abs(rel) < 0.02 ? '' : (d * good > 0 ? 'good' : 'bad');
    h += `<tr><td>${label}</td><td>${a.toFixed(dp)}</td><td>${b.toFixed(dp)}</td>` +
         `<td class="${cls}">${a ? (rel >= 0 ? '+' : '') + (rel * 100).toFixed(0) + '%' : '—'}</td></tr>`;
  }
  el.innerHTML = h + '</table><p class="empty small">綠＝標線較好、紅＝較差、無色＝差異小於 2% 或不評好壞。同一種子下兩次的人完全相同，差異來自標線。</p>';
}

/* ---------- 指標面板 ---------- */
let lastMetric = 0;
function showMetrics(force) {
  const now = performance.now();
  if (!force && running && now - lastMetric < 200) return;
  lastMetric = now;
  const L = $('metricList');
  if (!sim) {
    L.innerHTML = '<p class="empty">按「開始」執行模擬。</p>';
    drawChart();
    return;
  }
  const s = sim.summary(), z = sim.samples[sim.samples.length - 1] || {stopped: 0, appr: 0, v: 0, slow: 0, peak: 0};
  const m = (k, v) => `<div class="m"><span>${k}</span><span>${v}</span></div>`;
  L.innerHTML =
    m('模擬時間', s.t.toFixed(0) + ' 秒') +
    m('場內人數', s.present + (sim.queued ? `（入口排隊 ${sim.queued}）` : '')) +
    m('已進場／總數', `${s.spawned}/${sim.total}`) +
    m('已離場', s.exited) +
    m('駐足中（含前往）', z.stopped + z.appr) +
    m('目前步行速度', z.v.toFixed(2) + ' m/s') +
    m('目前擁擠指數', (z.slow * 100).toFixed(0) + '%') +
    m('目前最高格密度', z.peak + ' 人/m²') +
    m('路過者平均延遲', s.passN ? s.passDelay.toFixed(1) + ' 秒' : '—');
  drawChart();
}
const chart = $('chart'), cx = chart.getContext('2d');
function drawChart() {
  const w = chart.width, h = chart.height;
  cx.clearRect(0, 0, w, h);
  cx.strokeStyle = '#31363d'; cx.lineWidth = 1;
  cx.strokeRect(0.5, 0.5, w - 1, h - 1);
  const D = sim && sim.samples;
  if (!D || D.length < 2) return;
  const tmax = Math.max(60, D[D.length - 1].t);
  cx.strokeStyle = '#e9b13a'; cx.lineWidth = 1.5; cx.beginPath();
  D.forEach((s, i) => {
    const x = s.t / tmax * (w - 4) + 2, y = h - 3 - s.slow * (h - 6);
    i ? cx.lineTo(x, y) : cx.moveTo(x, y);
  });
  cx.stroke();
}

/* ---------- 滑鼠 ---------- */
function world(e, snap = true) {
  const r = cv.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width * scene.W, y = (e.clientY - r.top) / r.height * scene.H;
  if (snap && $('snap').checked) { x = Math.round(x * 2) / 2; y = Math.round(y * 2) / 2; }
  return {x: Math.min(scene.W, Math.max(0, x)), y: Math.min(scene.H, Math.max(0, y))};
}

function segDistTo(o, x, y) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.min(1, Math.max(0, ((x - o.x1) * dx + (y - o.y1) * dy) / l2)) : 0;
  return Math.hypot(x - o.x1 - t * dx, y - o.y1 - t * dy);
}
// 實體物件優先於標線區，後畫的（較上層）優先
function hit(x, y) {
  const order = ['wall', 'fence', 'entrance', 'exit', 'pillar', 'box', 'attractor', 'walk', 'stay'];
  for (const type of order) {
    const list = scene.objects.filter(o => o.type === type);
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if ('x1' in o ? segDistTo(o, x, y) < 0.45
          : o.type === 'pillar' ? Math.hypot(x - o.x, y - o.y) < o.r + 0.25
          : x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return o;
    }
  }
  return null;
}

function defaults(type, g) {
  const o = {id: scene.nextId++, type, ...g};
  const n = scene.objects.filter(x => x.type === type).length + 1;
  if (type === 'attractor') Object.assign(o, {label: '公共鋼琴', pStop: 30, dwell: 40, attn: 7, face: 90, arc: 360, gMin: 0.5, gMax: 1.8});
  if (type === 'entrance') Object.assign(o, {weight: 1, dest: 'any', name: '入口' + n});
  if (type === 'exit') Object.assign(o, {weight: 1, name: '出口' + n});
  if (type === 'box') o.label = '';
  return o;
}

cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 || busy) return;
  cv.setPointerCapture(e.pointerId);
  const p = world(e);
  if (tool.k === 'select') {
    const o = hit(p.x, p.y);
    sel = o ? o.id : null;
    if (o) drag = {mode: 'move', o, from: p, orig: {...o}, moved: false};
    inspect(); draw();
  } else if (tool.k === 'erase') {
    const o = hit(p.x, p.y);
    if (o) removeObj(o);
  } else if (tool.k === 'pillar') {
    add(defaults('pillar', {x: p.x, y: p.y, r: 0.4}));
  } else {
    drag = {mode: 'make', from: p};
    preview = {a: p, b: p};
  }
});

cv.addEventListener('pointermove', e => {
  const p = world(e);
  hover = p;
  if (!drag) { if (tool.k !== 'select') draw(); return; }
  if (drag.mode === 'make') { preview.b = p; draw(); return; }
  const dx = p.x - drag.from.x, dy = p.y - drag.from.y, o = drag.o, g = drag.orig;
  if (!drag.moved && (dx || dy)) { drag.moved = true; stopRun(); sim = null; }
  if ('x1' in o) { o.x1 = g.x1 + dx; o.x2 = g.x2 + dx; o.y1 = g.y1 + dy; o.y2 = g.y2 + dy; }
  else { o.x = g.x + dx; o.y = g.y + dy; }
  draw();
});

cv.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'move') { if (d.moved) { edited(true); } return; }
  const a = preview.a, b = world(e); preview = null;
  if (tool.line) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) { draw(); return; }
    add(defaults(tool.k, {x1: a.x, y1: a.y, x2: b.x, y2: b.y}));
  } else if (tool.rect) {
    let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 0.5 || h < 0.5) { w = tool.dw; h = tool.dh; x = a.x - w / 2; y = a.y - h / 2; }
    add(defaults(tool.k, {x, y, w, h}));
  }
});

function add(o) {
  scene.objects.push(o);
  sel = o.id;
  edited(true);
}
function removeObj(o) {
  scene.objects = scene.objects.filter(x => x !== o);
  // 刪掉出口後，指向它的入口改回「任一出口」
  scene.objects.forEach(x => { if (x.type === 'entrance' && x.dest === o.id) x.dest = 'any'; });
  if (sel === o.id) sel = null;
  edited(true);
}

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('pointerleave', () => { hover = null; if (!drag) draw(); });

document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { removeObj(find(sel)); e.preventDefault(); }
  else if (e.key === 'Escape') { sel = null; tool = TOOLS[0]; syncTools(); inspect(); draw(); }
  else if (e.key === ' ') { playBtn.click(); e.preventDefault(); }
});

/* ---------- 右欄：選取物件的參數 ---------- */
const inspector = $('inspector');
function inspect() {
  inspector.innerHTML = '<h2>物件設定</h2>';
  const o = sel && find(sel);
  if (!o) {
    inspector.insertAdjacentHTML('beforeend',
      '<p class="empty">用「選取」點一個物件來調整它的參數。</p>' +
      '<p class="empty small">入口決定人從哪來、往哪去；吸引物決定誰會停下來；駐足線區與通行帶是這個實驗要比較的地面標線。</p>');
    return;
  }
  inspector.insertAdjacentHTML('beforeend', `<p class="empty">${TYPE_NAME[o.type]} #${o.id}</p>`);
  const F = {
    num: (label, key, min, max, step) => field(label, 'number', o, key, {min, max, step}),
    txt: (label, key) => field(label, 'text', o, key, {maxLength: 12}),
  };
  if (o.type === 'wall' || o.type === 'fence') inspector.insertAdjacentHTML('beforeend',
    `<p class="empty">長度 ${Math.hypot(o.x2 - o.x1, o.y2 - o.y1).toFixed(1)} m</p>` +
    (o.type === 'fence' ? '<p class="empty small">實體，誰都過不去（與「遵守率」無關）。標線總開關關掉時整排不存在。</p>' : ''));
  if (o.type === 'pillar') F.num('半徑 (m)', 'r', 0.1, 3, 0.1);
  if ('w' in o) { F.num('寬 (m)', 'w', 0.3, 100, 0.5); F.num('深 (m)', 'h', 0.3, 80, 0.5); }
  if (o.type === 'box' || o.type === 'attractor') F.txt('標籤', 'label');
  if (o.type === 'attractor') {
    F.num('停下機率 %', 'pStop', 0, 100, 5);
    F.num('平均停留 (秒)', 'dwell', 3, 600, 5);
    F.num('注意半徑 (m)', 'attn', 1, 30, 1);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<label>正面朝向</label>';
    const el = document.createElement('select');
    [['270', '北 ↑'], ['0', '東 →'], ['90', '南 ↓'], ['180', '西 ←']].forEach(([v, t]) => el.add(new Option(t, v)));
    el.value = String(Math.round(o.face / 90) * 90 % 360);
    el.onchange = () => { o.face = +el.value; edited(false); };
    row.appendChild(el);
    inspector.appendChild(row);
    F.num('聚集扇形 (度)', 'arc', 30, 360, 15);
    F.num('站位最近 (m)', 'gMin', 0, 10, 0.5);
    F.num('站位最遠 (m)', 'gMax', 0.5, 15, 0.5);
    inspector.insertAdjacentHTML('beforeend',
      '<p class="empty small">路過的人第一次走進注意半徑時抽一次籤，抽中就走去站著聽／看。沒有駐足區時，人在正面的扇形範圍內由近而遠排開；360 度＝繞一整圈。</p>');
  }
  if (o.type === 'entrance' || o.type === 'exit') {
    F.txt('名稱', 'name');
    F.num('權重', 'weight', 0, 100, 0.5);
  }
  if (o.type === 'entrance') {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<label>去向</label>';
    const el = document.createElement('select');
    el.add(new Option('任一出口（依權重）', 'any'));
    scene.objects.filter(x => x.type === 'exit').forEach(x => el.add(new Option(x.name || '出口 #' + x.id, x.id)));
    el.value = String(o.dest);
    el.onchange = () => { o.dest = el.value === 'any' ? 'any' : +el.value; edited(false); };
    row.appendChild(el);
    inspector.appendChild(row);
  }
  if (o.type === 'stay' || o.type === 'walk') inspector.insertAdjacentHTML('beforeend', o.type === 'stay'
    ? '<p class="empty small">守規矩的駐足者會站進區內較空的位置；守規矩的路過者把穿越此區的成本 ×4，會繞開。</p>'
    : '<p class="empty small">守規矩的路過者偏好走在帶內（成本 ×0.6）；守規矩的駐足者不會站在帶內。</p>');
  const del = document.createElement('button');
  del.className = 'btn full'; del.textContent = '刪除此物件';
  del.onclick = () => removeObj(o);
  inspector.appendChild(del);
}

function field(label, type, o, key, attrs) {
  const row = document.createElement('div');
  row.className = 'row';
  const id = 'f_' + key;
  row.innerHTML = `<label for="${id}">${label}</label>`;
  const el = document.createElement('input');
  el.type = type; el.id = id; el.value = o[key];
  Object.assign(el, attrs);
  el.onchange = () => {
    o[key] = type === 'number' ? clampNum(el.value, +attrs.min, +attrs.max) : el.value;
    el.value = o[key];
    edited(o.type === 'entrance' || o.type === 'exit');   // 改名要連「去向」下拉一起更新
  };
  row.appendChild(el);
  inspector.appendChild(row);
}

/* ---------- 繪製 ---------- */
function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

function draw() {
  ctx.setTransform(S, 0, 0, S, 0, 0);
  const {W, H} = scene;
  ctx.fillStyle = '#1c1f23';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#23272c'; ctx.lineWidth = 1 / S;
  for (let x = 0; x <= W; x += 1) line(x, 0, x, H);
  for (let y = 0; y <= H; y += 1) line(0, y, W, y);
  ctx.strokeStyle = '#2d3238';
  for (let x = 0; x <= W; x += 5) line(x, 0, x, H);
  for (let y = 0; y <= H; y += 5) line(0, y, W, y);

  const on = scene.params.markings;
  for (const o of scene.objects) if (o.type === 'walk' || o.type === 'stay') zone(o, on);
  drawHeat();
  for (const o of scene.objects) solid(o);
  for (const o of scene.objects) door(o);
  drawAgents();
  const o = sel && find(sel);
  if (o) selectionMark(o);
  if (preview) drawPreview();

  ctx.strokeStyle = '#4b525a'; ctx.lineWidth = 2 / S;
  ctx.strokeRect(0, 0, W, H);
  if (hover && !running) {
    ctx.fillStyle = '#8b939e'; ctx.font = `${0.7}px sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`${hover.x.toFixed(1)}, ${hover.y.toFixed(1)} m`, W - 0.3, 0.3);
  }
}

function text(s, x, y, size, color, align = 'center') {
  ctx.fillStyle = color; ctx.font = `${size}px "Microsoft JhengHei",sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

function zone(o, on) {
  const c = COLOR[o.type];
  ctx.save();
  ctx.globalAlpha = on ? 1 : 0.35;          // 標線停用時只留淡淡的輪廓，看得到位置但知道沒作用
  ctx.fillStyle = o.type === 'stay' ? 'rgba(233,177,58,.14)' : 'rgba(76,195,217,.12)';
  ctx.fillRect(o.x, o.y, o.w, o.h);
  ctx.strokeStyle = c; ctx.lineWidth = 2 / S;
  ctx.setLineDash([0.5, 0.35]);
  ctx.strokeRect(o.x, o.y, o.w, o.h);
  ctx.setLineDash([]);
  if (o.type === 'walk') {                  // 通行帶畫箭頭條紋，沿長邊方向
    ctx.beginPath();
    if (o.h >= o.w) for (let y = o.y + 1; y < o.y + o.h - 0.5; y += 1.6) { ctx.moveTo(o.x + o.w / 2 - 0.3, y + 0.3); ctx.lineTo(o.x + o.w / 2, y); ctx.lineTo(o.x + o.w / 2 + 0.3, y + 0.3); }
    else for (let x = o.x + 1; x < o.x + o.w - 0.5; x += 1.6) { ctx.moveTo(x + 0.3, o.y + o.h / 2 - 0.3); ctx.lineTo(x, o.y + o.h / 2); ctx.lineTo(x + 0.3, o.y + o.h / 2 + 0.3); }
    ctx.stroke();
  }
  text(o.type === 'stay' ? '駐足區' : '通行帶', o.x + 0.2, o.y + 0.5, 0.7, c, 'left');
  ctx.restore();
}

function solid(o) {
  if (o.type === 'wall') {
    ctx.strokeStyle = '#7b848f'; ctx.lineWidth = 0.2; ctx.lineCap = 'round';
    line(o.x1, o.y1, o.x2, o.y2);
    ctx.lineCap = 'butt';
  } else if (o.type === 'fence') {
    ctx.save();
    ctx.globalAlpha = scene.params.markings ? 1 : 0.3;     // 停用時只留淡淡輪廓
    ctx.strokeStyle = COLOR.fence; ctx.lineWidth = 0.08;
    ctx.setLineDash([0.25, 0.15]);
    line(o.x1, o.y1, o.x2, o.y2);
    ctx.setLineDash([]);
    ctx.fillStyle = COLOR.fence;
    const n = Math.max(1, Math.round(Math.hypot(o.x2 - o.x1, o.y2 - o.y1) / 1.5));   // 約每 1.5 m 一根柱
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.arc(o.x1 + (o.x2 - o.x1) * i / n, o.y1 + (o.y2 - o.y1) * i / n, 0.14, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  } else if (o.type === 'pillar') {
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
    ctx.fillStyle = '#4b525a'; ctx.fill();
    ctx.strokeStyle = '#7b848f'; ctx.lineWidth = 2 / S; ctx.stroke();
  } else if (o.type === 'box' || o.type === 'attractor') {
    const at = o.type === 'attractor';
    ctx.fillStyle = at ? 'rgba(181,123,238,.28)' : '#3b4046';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = at ? COLOR.attractor : '#5a636e'; ctx.lineWidth = 2 / S;
    ctx.strokeRect(o.x, o.y, o.w, o.h);
    const label = (at ? '♪ ' : '') + (o.label || '');
    if (label.trim()) text(label, o.x + o.w / 2, o.y + o.h / 2, Math.min(0.8, o.w / Math.max(2, label.length) * 1.1), at ? COLOR.attractor : '#c9cdd3');
  }
}

function door(o) {
  if (o.type !== 'entrance' && o.type !== 'exit') return;
  const c = COLOR[o.type];
  ctx.strokeStyle = c; ctx.lineWidth = 0.3; ctx.lineCap = 'butt';
  line(o.x1, o.y1, o.x2, o.y2);
  const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
  let nx = -(o.y2 - o.y1), ny = o.x2 - o.x1;
  const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
  if (nx * (scene.W / 2 - mx) + ny * (scene.H / 2 - my) < 0) { nx = -nx; ny = -ny; }
  const dir = o.type === 'entrance' ? 1 : -1;             // 入口箭頭朝場內、出口箭頭朝場外
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(mx + nx * dir * 1.0, my + ny * dir * 1.0);
  ctx.lineTo(mx - nx * dir * 0.2 + ny * 0.6, my - ny * dir * 0.2 - nx * 0.6);
  ctx.lineTo(mx - nx * dir * 0.2 - ny * 0.6, my - ny * dir * 0.2 + nx * 0.6);
  ctx.fill();
  if (o.name) text(o.name, mx + nx * 1.9, my + ny * 1.9, 0.7, c);
}

function drawHeat() {
  if (heat === 'off' || !sim) return;
  const acc = heat === 'acc';
  if (acc && !sim.heatN) return;
  const d = acc ? sim.heatAcc : sim.densityNow();
  for (let y = 0; y < sim.dny; y++) for (let x = 0; x < sim.dnx; x++) {
    const v = d[y * sim.dnx + x] / (acc ? sim.heatN : 1);
    if (v < 0.05) continue;
    const t = Math.min(1, v / 4);
    ctx.fillStyle = `hsla(${200 - 200 * t},85%,55%,${0.12 + 0.5 * t})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawAgents() {
  if (!sim) return;
  const bins = {slow: [], mid: [], fast: [], appr: [], stop: []};
  for (const a of sim.agents)
    bins[a.st === 2 ? 'stop' : a.st === 1 ? 'appr' : a.speed < 0.5 ? 'slow' : a.speed < 1 ? 'mid' : 'fast'].push(a);
  const colors = {slow: '#e0453c', mid: '#e9b13a', fast: '#dfe3e8', appr: '#d6b8f5', stop: '#b57bee'};
  for (const k in bins) {
    ctx.fillStyle = colors[k];
    ctx.beginPath();
    for (const a of bins[k]) { ctx.moveTo(a.x + a.r, a.y); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); }
    ctx.fill();
  }
}

function selectionMark(o) {
  ctx.strokeStyle = '#39c06a'; ctx.lineWidth = 2 / S;
  if ('x1' in o) {
    ctx.beginPath(); ctx.arc(o.x1, o.y1, 0.3, 0, Math.PI * 2); ctx.arc(o.x2, o.y2, 0.3, 0, Math.PI * 2); ctx.stroke();
  } else if (o.type === 'pillar') {
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r + 0.2, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.strokeRect(o.x - 0.15, o.y - 0.15, o.w + 0.3, o.h + 0.3);
  }
  if (o.type === 'attractor') {
    ctx.strokeStyle = 'rgba(181,123,238,.6)'; ctx.setLineDash([0.4, 0.4]);
    ctx.beginPath(); ctx.arc(o.x + o.w / 2, o.y + o.h / 2, o.attn, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // 聚集範圍：正面朝向的扇形（近端 gMin、遠端 gMax 約略以中心起算）
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, ext = Math.max(o.w, o.h) / 2;
    const a0 = (o.face - o.arc / 2) * Math.PI / 180, a1 = (o.face + o.arc / 2) * Math.PI / 180;
    ctx.strokeStyle = 'rgba(181,123,238,.9)'; ctx.fillStyle = 'rgba(181,123,238,.08)';
    ctx.beginPath();
    ctx.arc(cx, cy, ext + o.gMax, a0, a1);
    if (o.arc < 360) ctx.lineTo(cx, cy);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

function drawPreview() {
  const {a, b} = preview;
  ctx.strokeStyle = COLOR[tool.k] || '#7b848f'; ctx.lineWidth = 2 / S;
  ctx.setLineDash([0.3, 0.3]);
  if (tool.line) line(a.x, a.y, b.x, b.y);
  else ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.setLineDash([]);
}

/* ---------- 啟動 ---------- */
note.textContent = '範例：南進北出的主動線上有一台公共鋼琴。按「標線 有／無 批次比較」看標線的影響，或自己拖曳改場景。';
syncTools(); syncPanel(); resize(); draw(); inspect(); showMetrics(true);
refreshServerList();
