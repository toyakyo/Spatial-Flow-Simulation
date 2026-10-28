// 路口號誌編輯器 — 靜態編輯，狀態全部存在記憶體
// ponytail: 不做存檔。要保存時再加 localStorage 或 server.py 的 settings.json 讀寫，
//           資料格式就是下面的 grid 陣列，直接 JSON.stringify 即可。

const COLS = 7, ROWS = 7;
const CELL = 56;      // 邏輯格寬，所有繪圖尺寸都以它為基準
const SCALE = 1.7;    // 顯示倍率。格子變少了，整張圖放大讓標線與燈具看得清楚

// 八個方向的單位向量（螢幕座標，y 向下）
const DIRS = {
  N:[0,-1], NE:[1,-1], E:[1,0], SE:[1,1], S:[0,1], SW:[-1,1], W:[-1,0], NW:[-1,-1]
};
const DIR_LABEL = {N:'北 ↑', NE:'東北 ↗', E:'東 →', SE:'東南 ↘',
                   S:'南 ↓', SW:'西南 ↙', W:'西 ←', NW:'西北 ↖'};

// 路型只是「連到哪幾個方向」的預設值，不是各自獨立的圖形
const PRESETS = [
  {k:'選取', arms:null},
  {k:'│', arms:['N','S']},
  {k:'─', arms:['E','W']},
  {k:'┼', arms:['N','S','E','W']},
  {k:'├', arms:['N','S','E']},
  {k:'┤', arms:['N','S','W']},
  {k:'┬', arms:['E','W','S']},
  {k:'┴', arms:['E','W','N']},
  {k:'╱', arms:['NE','SW']},
  {k:'╲', arms:['NW','SE']},
  {k:'╳', arms:['NE','SW','NW','SE']},
  {k:'清除整格', arms:[], wide:true},
];

// 各型燈具的燈位排列，順序＝該進口駕駛人由左至右讀到的順序
// 四燈式為 紅、黃、左轉燈號、圓綠燈；五燈式為 紅、黃、左、直、右
const HEADS = {3:['R','Y','G'], 4:['R','Y','L','G'], 5:['R','Y','L','S','T']};
const ROUND = {R:'#e0453c', Y:'#e9b13a', G:'#39c06a'};
// 箭頭燈在燈桿局部座標的指向：左箭頭朝紅燈那一端、右箭頭朝反向、直行朝車輛前進方向。
// 可讀性優先：燈面讀起來就是 ← ↑ →，不保證箭頭與地圖上的實際去向一致。
const arrowVec = (k, start) => k === 'S' ? [-1, 0] : [0, k === 'L' ? start : -start];
const ARROW_LABEL = {L:'左轉燈號', S:'直行燈號', T:'右轉燈號'};

const OPP = {N:'S', S:'N', E:'W', W:'E', NE:'SW', SW:'NE', NW:'SE', SE:'NW'};
const ORDER = ['E','SE','S','SW','W','NW','N','NE'];   // 依角度排序，右鍵判斷用

const newCell = () => ({arms:[], mesh:false, wait:false, cross:[], sig:{}, phases:[], offset:0});
const grid = Array.from({length:ROWS}, () => Array.from({length:COLS}, newCell));

let tool = PRESETS[3];   // 預設拿十字路口
let sel = null;          // {r,c}
let playing = false, startMs = 0, speed = 1;
// 碰撞暫停時把時鐘凍在當下，燈態才會停在事發那一刻而不是退回手動燈色
let frozen = null;
const clockMs = () => frozen === null ? performance.now() : frozen;
const running = () => playing || frozen !== null;

// 每個路口跑自己的週期，offset 是它比全域時鐘晚幾秒起跑。
// speed 只放慢時鐘流速，不改秒數資料：8× 就是每個時相看起來停留 8 倍久。
// 錯位路口或幹道連鎖（綠波）就是靠這個把相鄰路口錯開。
function phaseAt(cell){
  const total = cell.phases.reduce((a, p) => a + p.t, 0);
  if (!total) return null;
  let pos = (((clockMs() - startMs) / 1000 / speed - cell.offset) % total + total) % total;
  for (const p of cell.phases){
    if (pos < p.t) return {p, left: Math.ceil(p.t - pos)};
    pos -= p.t;
  }
  return null;
}

// 依「綠→黃→全紅」逐一輪流放行各條軸線。紅燈長度是其餘時相的總和，不另外設定，
// 所以不可能出現兩條軸線同時綠燈。預設 綠6／黃2／全紅1，產生後每格秒數仍可個別改。
const AXIS = d => [d, OPP[d]].sort()[0];

function lampState(s, kind){
  const head = HEADS[s.lamps];
  if (kind === 'warn') return {color:'Y', arrows:[]};
  if (kind === 'left')                                       // 左轉專用：僅左轉車可通行
    return head.includes('L')
      ? {color: head.includes('G') ? 'R' : 'X', arrows:['L']}
      : {color:'R', arrows:[]};                              // 沒有左轉燈號的進口照樣停
  if (kind === 'go')
    return head.includes('G')
      ? {color:'G', arrows:[]}                               // 圓綠燈：直行與左右轉皆可
      : {color:'X', arrows:head.filter(k => k === 'S' || k === 'T')};
  return {color:'R', arrows:[]};
}

// 標準時相的秒數，改這一行就能整體加快或放慢。左轉專用相只在有左轉燈號時才排。
const STD = {left:5, go:6, warn:2, allred:1};

function autoPhases(cell){
  const dirs = cell.arms.filter(d => cell.sig[d]);
  const axes = [...new Set(dirs.map(AXIS))];
  const build = pick => {
    const states = {};
    dirs.forEach(d => states[d] = lampState(cell.sig[d], pick(d)));
    return states;
  };
  const phases = [];
  axes.forEach(ax => {
    const mine = d => AXIS(d) === ax;
    // 這條軸線上有左轉燈號才排左轉專用時相，三燈路口不會多出用不到的一相
    if (dirs.some(d => mine(d) && HEADS[cell.sig[d].lamps].includes('L')))
      phases.push({t:STD.left, states:build(d => mine(d) ? 'left' : 'stop')});
    phases.push({t:STD.go, states:build(d => mine(d) ? 'go' : 'stop')});
    phases.push({t:STD.warn, states:build(d => mine(d) ? 'warn' : 'stop')});
    phases.push({t:STD.allred, states:build(() => 'stop')});
  });
  cell.phases = phases;
}
const SHORT = {N:'北', NE:'東北', E:'東', SE:'東南', S:'南', SW:'西南', W:'西', NW:'西北'};

// 把一個時相翻成看得懂的一句話，例如「綠 南、北」或「全紅」
function phaseLabel(p){
  const go = [], left = [], warn = [];
  Object.entries(p.states).forEach(([d, st]) => {
    if (st.color === 'Y') warn.push(SHORT[d]);
    else if (st.color === 'G' || st.arrows.includes('S')) go.push(SHORT[d]);
    else if (st.arrows.length) left.push(SHORT[d]);
  });
  if (!go.length && !left.length && !warn.length) return '全紅';
  return [go.length && '綠 ' + go.join('、'),
          left.length && '左轉 ' + left.join('、'),
          warn.length && '黃 ' + warn.join('、')].filter(Boolean).join('　');
}

// 時相＝目前燈色的快照，所以不需要另一套燈色編輯介面
function snapshot(cell){
  const states = {};
  Object.entries(cell.sig).forEach(([d, s]) => states[d] = {color:s.color, arrows:[...s.arrows]});
  return {t:20, states};
}

const cv = document.getElementById('board');
const ctx = cv.getContext('2d');
cv.width = COLS * CELL * SCALE;
cv.height = ROWS * CELL * SCALE;

/* ---------- 左側路型面板 ---------- */
const palette = document.getElementById('palette');
PRESETS.forEach(p => {
  const b = document.createElement('button');
  b.textContent = p.k;
  if (p.wide) b.className = 'wide';
  b.onclick = () => { tool = p; syncPalette(); };
  palette.appendChild(b);
});
function syncPalette(){
  [...palette.children].forEach((b,i) =>
    b.setAttribute('aria-pressed', PRESETS[i] === tool));
}

/* ---------- 輪播 ---------- */
const playBtn = document.getElementById('play');
playBtn.onclick = () => {
  playing = !playing;
  playBtn.textContent = playing ? '暫停輪播' : '開始輪播';
  playBtn.setAttribute('aria-pressed', playing);
  if (playing){
    conflict = null;
    frozen = null;
    startMs = lastMs = performance.now();
    tick();
  } else draw();
};

const flowSel = document.getElementById('flow');
flowSel.onchange = () => { flow = +flowSel.value; };

const yieldBox = document.getElementById('yield');
yieldBox.onchange = () => { yieldTurn = yieldBox.checked; };

document.getElementById('clear').onclick = () => {
  cars = [];
  conflict = null;
  frozen = null;
  note.textContent = '車輛已清空。';
  draw();
};
const speedSel = document.getElementById('speed');
speedSel.onchange = () => {
  speed = +speedSel.value;
  startMs = lastMs = performance.now();   // 換倍率就從週期起點重跑，免得跳到半途
  draw();
};

/* ---------- 場景存取 ---------- */
const note = document.getElementById('note');

document.getElementById('save').onclick = () => {
  const blob = new Blob([JSON.stringify({v:1, cols:COLS, rows:ROWS, grid})],
                        {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scene.json';
  a.click();
  URL.revokeObjectURL(a.href);
  note.textContent = '已存成 scene.json。';
};

const fileInput = document.getElementById('file');
document.getElementById('load').onclick = () => fileInput.click();
fileInput.onchange = () => {
  const f = fileInput.files[0];
  fileInput.value = '';                  // 清掉才能重選同一個檔
  if (!f) return;
  const fr = new FileReader();
  fr.onerror = () => note.textContent = '讀檔失敗。';
  fr.onload = () => {
    try {
      loadScene(JSON.parse(fr.result));
      note.textContent = `已載入 ${f.name}。`;
    } catch (err) {
      note.textContent = '載入失敗：' + err.message;
    }
  };
  fr.readAsText(f);
};

// 沒有復原功能，所以動手前先問一次
document.getElementById('wipe').onclick = () => {
  if (!confirm('清空整張圖？路型、號誌、時相全部消失，無法復原。')) return;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid[r][c] = newCell();
  stopPlaying();
  cars = [];
  conflict = null;
  sel = null;
  note.textContent = '整張圖已清空。';
  draw(); inspect();
};

function loadScene(data){
  if (!data || !Array.isArray(data.grid)) throw new Error('不是場景檔');
  if (data.grid.length !== ROWS || data.grid.some(r => !Array.isArray(r) || r.length !== COLS))
    throw new Error(`尺寸不符，需要 ${ROWS}×${COLS}`);
  const next = data.grid.map(row => row.map(adopt));       // 全部驗完才動現場
  next.forEach((row, r) => row.forEach((cell, c) => grid[r][c] = cell));
  stopPlaying();
  cars = [];
  conflict = null;
  sel = null;
  draw(); inspect();
}

// 檔案是外部輸入，逐欄檢查後才放進場景；不認得的值一律丟掉而不是照單全收
function adopt(raw){
  const cell = newCell();
  if (!raw || typeof raw !== 'object') return cell;
  if (Array.isArray(raw.arms)) cell.arms = raw.arms.filter(d => DIRS[d]);
  cell.mesh = !!raw.mesh;
  cell.wait = !!raw.wait;
  if (Array.isArray(raw.cross)) cell.cross = raw.cross.filter(d => cell.arms.includes(d));
  cell.offset = Math.max(0, Math.round(+raw.offset) || 0);

  if (raw.sig && typeof raw.sig === 'object')
    Object.entries(raw.sig).forEach(([d, s]) => {
      if (!cell.arms.includes(d) || !s || !HEADS[s.lamps]) return;
      cell.sig[d] = {lamps: s.lamps, ...adoptState(s, s.lamps)};
    });

  if (Array.isArray(raw.phases))
    cell.phases = raw.phases
      .filter(p => p && p.states && typeof p.states === 'object')
      .map(p => {
        const states = {};
        Object.entries(p.states).forEach(([d, s]) => {
          if (cell.sig[d] && s) states[d] = adoptState(s, cell.sig[d].lamps);
        });
        return {t: Math.max(1, Math.round(+p.t) || 1), states};
      })
      .filter(p => Object.keys(p.states).length);
  return cell;
}

function adoptState(s, lamps){
  const head = HEADS[lamps] || HEADS[3];
  return {
    color: (s.color === 'X' || head.includes(s.color)) ? s.color : 'R',
    arrows: Array.isArray(s.arrows) ? s.arrows.filter(k => head.includes(k)) : [],
  };
}

/* ---------- 車流 ---------- */
// 等速移動，只有走與停：紅燈停、前方有車停。車輛之間不閃避，
// 撞在一起就暫停輪播並標出衝突點——會被藏起來的衝突正是要驗證的東西。
const CAR = {v:0.8, len:10, wide:5, gap:14, hit:10, spawn:1.5, lane:0.15};
let cars = [], conflict = null, lastMs = 0, yieldTurn = true, flow = 10;

const norm = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x/L, y/L]; };
const rightOf = ([x, y]) => [-y, x];              // y 向下座標系的右手邊
const edgeMid = (r, c, d) => {
  const [dx, dy] = DIRS[d];
  return [c*CELL + CELL/2 + dx*CELL/2, r*CELL + CELL/2 + dy*CELL/2];
};

// 車道靠右：進出點各自往行進方向的右手邊偏移，對向車才不會走在同一條線上
function path(car){
  const din = norm(DIRS[OPP[car.a]]), dout = norm(DIRS[car.o]);
  const k = CELL * CAR.lane;
  const oi = rightOf(din), oo = rightOf(dout);
  const [ex, ey] = edgeMid(car.r, car.c, car.a);
  const [xx, xy] = edgeMid(car.r, car.c, car.o);
  return [
    [ex + oi[0]*k, ey + oi[1]*k],
    [car.c*CELL + CELL/2 + (oi[0]+oo[0])*k/2, car.r*CELL + CELL/2 + (oi[1]+oo[1])*k/2],
    [xx + oo[0]*k, xy + oo[1]*k],
  ];
}

function place(car){
  const [P0, C, P2] = path(car);
  const t = Math.min(car.t, 1), u = 1 - t;
  car.p = [u*u*P0[0] + 2*u*t*C[0] + t*t*P2[0], u*u*P0[1] + 2*u*t*C[1] + t*t*P2[1]];
  car.h = norm([2*u*(C[0]-P0[0]) + 2*t*(P2[0]-C[0]),
                2*u*(C[1]-P0[1]) + 2*t*(P2[1]-C[1])]);
}

// 進口 a 進來、往 o 出去，是直行還是左右轉
function turn(a, o){
  const i = ORDER.indexOf(OPP[a]), j = ORDER.indexOf(o);
  const d = ((j - i) % 8 + 8) % 8;
  return d === 0 ? 'S' : d <= 3 ? 'T' : 'L';
}

const pickOut = (cell, a) => {
  const out = cell.arms.filter(d => d !== a);
  return out.length ? out[Math.floor(Math.random() * out.length)] : null;
};

// 圓綠燈准許直行與左右轉；其餘只能依亮起的箭頭走。黃燈與熄燈一律停。
const allowed = (s, m) => !s || s.color === 'G' || s.arrows.includes(m);

function nextCell(car){
  const [dx, dy] = DIRS[car.o];
  const row = grid[car.r + dy];
  return row && row[car.c + dx];
}

// 轉彎車必須禮讓直行車先行。只有轉彎車會讓、直行車不讓，
// 所以不會出現兩台互等的死結。關掉開關就能看不禮讓的後果。
function mustYield(car, nr, nc, n, m){
  if (!yieldTurn || m === 'S') return false;
  return cars.some(o => {
    if (o === car) return false;
    if (o.r === nr && o.c === nc) return turn(o.a, o.o) === 'S';   // 已在路口內直行
    if (!o.nextO || o.t < 0.9) return false;                       // 其餘只看停止線上的車
    const [ox, oy] = DIRS[o.o];
    if (o.r + oy !== nr || o.c + ox !== nc) return false;
    const oa = OPP[o.o];
    return turn(oa, o.nextO) === 'S' && allowed(shown(n, oa), 'S');
  });
}

function canGo(car){
  const [dx, dy] = DIRS[car.o];
  const nr = car.r + dy, nc = car.c + dx;
  const row = grid[nr];
  const n = row && row[nc];
  const a2 = OPP[car.o];
  if (!n || !n.arms.includes(a2)) return true;          // 開出地圖，讓它走
  car.nextO = car.nextO || pickOut(n, a2);
  if (!car.nextO) return true;
  const m = turn(a2, car.nextO);
  if (!allowed(shown(n, a2), m)) return false;
  return !mustYield(car, nr, nc, n, m);
}

function hop(car){
  const n = nextCell(car);
  const a2 = OPP[car.o];
  if (!n || !n.arms.includes(a2)) return car.dead = true;
  const o2 = car.nextO || pickOut(n, a2);
  if (!o2) return car.dead = true;
  const [dx, dy] = DIRS[car.o];
  Object.assign(car, {r:car.r + dy, c:car.c + dx, a:a2, o:o2, t:car.t - 1, nextO:null});
}

// flow 是畫面上同時存在的車輛上限；產生速率夠快，所以車數會貼著上限跑
function spawn(dt){
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++){
    if (cars.length >= flow) return;
    const cell = grid[r][c];
    for (const a of cell.arms){
      if (cars.length >= flow) return;
      const [dx, dy] = DIRS[a];
      const row = grid[r + dy];
      if (row && row[c + dx] && row[c + dx].arms.length) continue;   // 不是路的盡頭
      if (Math.random() > dt / CAR.spawn) continue;
      const o = pickOut(cell, a);
      if (!o) continue;
      const car = {r, c, a, o, t:0};
      place(car);
      if (cars.some(x => Math.hypot(x.p[0]-car.p[0], x.p[1]-car.p[1]) < CAR.gap)) continue;
      cars.push(car);
    }
  }
}

function blocked(car){
  return cars.some(o => {
    if (o === car) return false;
    const vx = o.p[0] - car.p[0], vy = o.p[1] - car.p[1];
    const d = Math.hypot(vx, vy);
    return d > 0.01 && d < CAR.gap && (vx*car.h[0] + vy*car.h[1]) / d > 0.7;
  });
}

function step(dt){
  spawn(dt);
  cars.forEach(place);
  const hold = cars.map(blocked);
  cars.forEach((car, i) => {
    if (hold[i]) return;
    car.t += CAR.v * dt;
    if (car.t >= 1){ if (canGo(car)) hop(car); else car.t = 1; }
  });
  cars = cars.filter(car => !car.dead);
  cars.forEach(place);
  findConflict();
}

function findConflict(){
  for (let i = 0; i < cars.length; i++)
    for (let j = i + 1; j < cars.length; j++){
      const A = cars[i], B = cars[j];
      const dx = A.p[0] - B.p[0], dy = A.p[1] - B.p[1];
      if (Math.hypot(dx, dy) > CAR.hit) continue;
      if (A.h[0]*B.h[0] + A.h[1]*B.h[1] > 0.3) continue;   // 同向跟車不算衝突
      conflict = [(A.p[0]+B.p[0])/2, (A.p[1]+B.p[1])/2];
      stopPlaying('車流衝突：兩股車同時進入同一點。燈態保留在碰撞當下。', true);
      return;
    }
}

function drawCars(){
  for (const car of cars){
    ctx.save();
    ctx.translate(car.p[0], car.p[1]);
    ctx.rotate(Math.atan2(car.h[1], car.h[0]));
    ctx.fillStyle = '#dfe3e8';
    ctx.fillRect(-CAR.len/2, -CAR.wide/2, CAR.len, CAR.wide);
    ctx.fillStyle = '#8b939e';
    ctx.fillRect(CAR.len/2 - 3, -CAR.wide/2, 3, CAR.wide);   // 車頭
    ctx.restore();
  }
  if (!conflict) return;
  ctx.strokeStyle = '#e0453c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(conflict[0], conflict[1], 11, 0, Math.PI*2);
  ctx.stroke();
}

/* ---------- 一鍵設置 ---------- */
// 三條路以上交會的格子就是路口。每個進口補上三燈，但對面若緊鄰另一個路口就不設——
// 那段路太短，停在裡面會把兩個路口一起鎖死，實務上是由同一組控制器當成路口內部處理。
// 已經設好的燈具不會被覆蓋，所以調整過四燈五燈之後再按一次也不會被打回原形。
function autoAll(){
  const cycles = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++){
    const cell = grid[r][c];
    if (cell.arms.length < 3) continue;
    for (const d of cell.arms){
      const [dx, dy] = DIRS[d];
      const row = grid[r + dy];
      const nb = row && row[c + dx];
      if (nb && nb.arms.length >= 3) continue;
      if (!cell.sig[d]) cell.sig[d] = {lamps:3, color:'R', arrows:[]};
    }
    autoPhases(cell);
    if (cell.phases.length) cycles.push(cell.phases.reduce((a, p) => a + p.t, 0));
  }
  const kinds = [...new Set(cycles)];
  note.textContent = cycles.length
    ? `已設置 ${cycles.length} 個路口，週期 ${kinds.join('、')} 秒。` +
      (kinds.length > 1 ? '週期不一致，路口之間會逐漸失去同步，需要手動調成一樣長。' : '')
    : '找不到路口：要三條路以上交會的格子才算。';
  draw(); inspect();
}
document.getElementById('auto').onclick = autoAll;

function tick(){
  if (!playing) return;
  const now = performance.now();
  step(Math.min(0.1, (now - lastMs) / 1000 / speed));   // 大延遲時夾住，免得車瞬移過路口
  lastMs = now;
  draw();
  requestAnimationFrame(tick);
}

function stopPlaying(msg, freeze){
  playing = false;
  frozen = freeze ? performance.now() : null;
  playBtn.textContent = '開始輪播';
  playBtn.setAttribute('aria-pressed', false);
  if (msg) note.textContent = msg;
}

/* ---------- 點格子 ---------- */
function at(e){
  const rect = cv.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * cv.width / SCALE;
  const y = (e.clientY - rect.top) / rect.height * cv.height / SCALE;
  const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
  return {r, c, ox: x - c*CELL - CELL/2, oy: y - r*CELL - CELL/2};
}

// 方向被拿掉時，掛在上面的號誌與斑馬線一起清掉，不留看不見的設定
function prune(cell){
  Object.keys(cell.sig).forEach(d => { if (!cell.arms.includes(d)) delete cell.sig[d]; });
  cell.cross = cell.cross.filter(d => cell.arms.includes(d));
  cell.phases.forEach(p => Object.keys(p.states).forEach(d => {
    if (!cell.arms.includes(d)) delete p.states[d];
  }));
  cell.phases = cell.phases.filter(p => Object.keys(p.states).length);
}

function addArm(cell, d){ if (!cell.arms.includes(d)) cell.arms.push(d); }

// 相鄰兩格只要有一邊的路口朝著對方，就視為同一條路，雙向補上缺的那一邊。
// ponytail: 沒有做立體交叉。真的需要天橋／地下道時，這裡要多一個「不接合」的圖層旗標。
function connect(r, c){
  const cell = grid[r][c];
  if (!cell.arms.length) return;
  Object.keys(DIRS).forEach(d => {
    const [dx, dy] = DIRS[d];
    const n = grid[r + dy] && grid[r + dy][c + dx];
    if (!n || !n.arms.length) return;
    if (n.arms.includes(OPP[d])) addArm(cell, d);
    else if (cell.arms.includes(d)) addArm(n, OPP[d]);
  });
}

cv.addEventListener('click', e => {
  const p = at(e);
  if (!p) return;
  if (tool.arms && tool.arms.length) {
    const cell = grid[p.r][p.c];
    cell.arms = [...tool.arms];
    connect(p.r, p.c);
    prune(cell);
  } else if (tool.arms) {
    grid[p.r][p.c] = newCell();      // 清除整格
  }
  sel = p;
  draw(); inspect();
});

// 右鍵：只開關被點到的那一個路口方向，不做自動接合 —— 這是封閉路口的手段
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  const p = at(e);
  if (!p) return;
  if (Math.hypot(p.ox, p.oy) < 10) return;           // 太靠近中心，看不出想動哪一邊
  const d = ORDER[((Math.round(Math.atan2(p.oy, p.ox) / (Math.PI/4)) % 8) + 8) % 8];
  const cell = grid[p.r][p.c];
  if (cell.arms.includes(d)) cell.arms = cell.arms.filter(a => a !== d);
  else cell.arms.push(d);
  prune(cell);
  sel = p;
  draw(); inspect();
});

/* ---------- 右側檢視面板 ---------- */
const inspector = document.getElementById('inspector');

function inspect(){
  inspector.innerHTML = '<h2>路口設定</h2>';
  if (!sel) {
    inspector.insertAdjacentHTML('beforeend',
      '<p class="empty">點一個格子來設定它的地面標誌與號誌。</p>');
    return;
  }
  const cell = grid[sel.r][sel.c];
  inspector.insertAdjacentHTML('beforeend',
    `<p class="empty">格位 R${sel.r + 1} · C${sel.c + 1}</p>`);

  addCheck(inspector, '網狀線', cell.mesh, v => cell.mesh = v);
  addCheck(inspector, '機車待轉區', cell.wait, v => cell.wait = v);

  if (!cell.arms.length) {
    inspector.insertAdjacentHTML('beforeend',
      '<p class="empty approach">這格還沒有道路。</p>');
    return;
  }
  cell.arms.forEach(d => addApproach(cell, d));
  if (Object.keys(cell.sig).length) addPhases(cell);
}

function addPhases(cell){
  const wrap = document.createElement('div');
  wrap.className = 'approach';
  wrap.innerHTML = '<b>時相輪播</b>';
  inspector.appendChild(wrap);

  if (cell.arms.length < 3)
    wrap.insertAdjacentHTML('beforeend',
      '<p class="empty">這格是路段不是路口。號誌與時相通常要設在幾條路交會的那一格。</p>');

  cell.phases.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${i+1}. ${phaseLabel(p)}</label>`;
    const num = document.createElement('input');
    num.type = 'number'; num.min = '1'; num.value = p.t;
    num.onchange = () => { p.t = Math.max(1, Math.round(+num.value) || 1); num.value = p.t; };
    const del = document.createElement('button');
    del.className = 'btn'; del.textContent = '刪除';
    del.onclick = () => { cell.phases.splice(i, 1); inspect(); draw(); };
    row.append(num, del);
    wrap.appendChild(row);
  });

  if (cell.phases.length){
    const total = cell.phases.reduce((a, p) => a + p.t, 0);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>起始時差　秒</label>`;
    const num = document.createElement('input');
    num.type = 'number'; num.min = '0'; num.value = cell.offset;
    num.onchange = () => {
      cell.offset = ((Math.round(+num.value) || 0) % total + total) % total;
      num.value = cell.offset;
      draw();
    };
    row.appendChild(num);
    wrap.appendChild(row);
    wrap.insertAdjacentHTML('beforeend', `<p class="empty">週期 ${total} 秒</p>`);
  }

  const auto = document.createElement('button');
  auto.className = 'btn full';
  auto.textContent = '產生標準時相';
  auto.onclick = () => { autoPhases(cell); inspect(); draw(); };
  wrap.appendChild(auto);

  const add = document.createElement('button');
  add.className = 'btn full';
  add.textContent = '把目前燈色存成時相';
  add.onclick = () => { cell.phases.push(snapshot(cell)); inspect(); draw(); };
  wrap.appendChild(add);

  wrap.insertAdjacentHTML('beforeend', cell.phases.length
    ? '<p class="empty">紅燈長度＝其餘時相總和，不用另外設定。</p>'
    : '<p class="empty">按上面的按鈕自動排好：左轉5／綠6／黃2／全紅1。有左轉燈號的軸線才會排左轉專用相。</p>');
}

let uid = 0;
function addCheck(parent, label, val, set){
  const row = document.createElement('div');
  row.className = 'row';
  const id = 'chk' + (++uid);
  row.innerHTML = `<label for="${id}">${label}</label>`;
  const box = document.createElement('input');
  box.type = 'checkbox'; box.id = id; box.checked = val;
  box.onchange = () => { set(box.checked); draw(); };
  row.appendChild(box);
  parent.appendChild(row);
}

function addApproach(cell, d){
  const wrap = document.createElement('div');
  wrap.className = 'approach';
  wrap.innerHTML = `<b>${DIR_LABEL[d]} 進口</b>`;
  inspector.appendChild(wrap);

  addCheck(wrap, '行人穿越道', cell.cross.includes(d), v => {
    cell.cross = v ? [...cell.cross, d] : cell.cross.filter(x => x !== d);
  });

  const s = cell.sig[d];
  sel_(wrap, '燈具', s ? String(s.lamps) : '0',
    [['0','無號誌'],['3','三燈'],['4','四燈（含左轉燈號）'],['5','五燈（箭頭式）']], v => {
      if (v === '0') delete cell.sig[d];
      else {
        const keep = HEADS[+v];
        cell.sig[d] = {
          lamps: +v,
          color: s && keep.includes(s.color) ? s.color : 'R',
          arrows: s ? s.arrows.filter(k => keep.includes(k)) : [],
        };
        // 既有時相沒提到這個新方向的話，先補成紅燈，之後再重新產生或手動調整
        cell.phases.forEach(p => p.states[d] = p.states[d] || {color:'R', arrows:[]});
      }
      draw(); inspect();
    });

  if (!s) return;
  sel_(wrap, '圓燈', s.color,
    [['R','紅燈'],['Y','黃燈'],['G','綠燈'],['X','熄滅']]
      .filter(([k]) => k === 'X' || HEADS[s.lamps].includes(k)),
    v => { s.color = v; frozen = null; draw(); });   // 手動改燈色就解除凍結，否則看不到效果

  HEADS[s.lamps].filter(k => ARROW_LABEL[k]).forEach(k => {
    addCheck(wrap, ARROW_LABEL[k], s.arrows.includes(k), v => {
      s.arrows = v ? [...s.arrows, k] : s.arrows.filter(x => x !== k);
      frozen = null;
    });
  });
}

function sel_(parent, label, val, opts, on){
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}</label>`;
  const el = document.createElement('select');
  opts.forEach(([v,t]) => el.add(new Option(t, v)));
  el.value = val;
  el.onchange = () => on(el.value);
  row.appendChild(el);
  parent.appendChild(row);
}

/* ---------- 繪製 ---------- */
function draw(){
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);   // 之後全部用邏輯座標
  const W = COLS * CELL, H = ROWS * CELL;

  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#22262b';
  ctx.lineWidth = 1;
  for (let c = 0; c <= COLS; c++) line(c*CELL, 0, c*CELL, H);
  for (let r = 0; r <= ROWS; r++) line(0, r*CELL, W, r*CELL);

  each(drawRoad);
  each(drawDash);
  each(drawCross);
  each(drawMarks);
  drawCars();
  each(drawSignals);

  if (sel) {
    ctx.strokeStyle = '#39c06a';
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.c*CELL + 1, sel.r*CELL + 1, CELL - 2, CELL - 2);
  }
}

function each(fn){
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (grid[r][c].arms.length) fn(grid[r][c], c*CELL + CELL/2, r*CELL + CELL/2);
}

function line(a,b,x,y){ ctx.beginPath(); ctx.moveTo(a,b); ctx.lineTo(x,y); ctx.stroke(); }

function drawRoad(cell, cx, cy){
  ctx.strokeStyle = '#3b4046';
  ctx.lineWidth = CELL * 0.62;
  ctx.lineCap = 'butt';
  cell.arms.forEach(d => {
    const [dx, dy] = DIRS[d];
    line(cx, cy, cx + dx*CELL/2, cy + dy*CELL/2);
  });
  ctx.fillStyle = '#3b4046';                       // 補中心，避免轉角缺口
  ctx.fillRect(cx - CELL*0.31, cy - CELL*0.31, CELL*0.62, CELL*0.62);
}

// 只有「直線段」才畫中央虛線；路口內不畫，符合實際標線
function drawDash(cell, cx, cy){
  const a = cell.arms;
  if (a.length !== 2) return;
  const [d1, d2] = a;
  if (DIRS[d1][0] !== -DIRS[d2][0] || DIRS[d1][1] !== -DIRS[d2][1]) return;
  ctx.strokeStyle = '#c9cdd3';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  const [dx, dy] = DIRS[d1];
  line(cx - dx*CELL/2, cy - dy*CELL/2, cx + dx*CELL/2, cy + dy*CELL/2);
  ctx.setLineDash([]);
}

// 斑馬線畫在進口靠近路口的位置，條紋順著行進方向；旋轉後八個方向共用同一段程式
function drawCross(cell, cx, cy){
  const half = CELL*0.29, depth = 10, n = 5, step = half*2/n;
  cell.cross.forEach(d => {
    const [dx, dy] = DIRS[d];
    ctx.save();
    ctx.translate(cx + dx*CELL*0.36, cy + dy*CELL*0.36);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = '#d7dbe0';
    for (let i = 0; i < n; i++)
      ctx.fillRect(-depth/2, -half + i*step + step*0.22, depth, step*0.56);
    ctx.restore();
  });
}

function drawMarks(cell, cx, cy){
  const x = cx - CELL/2, y = cy - CELL/2;
  if (cell.mesh){
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 4, y + 4, CELL - 8, CELL - 8); ctx.clip();
    ctx.strokeStyle = '#e9b13a'; ctx.lineWidth = 1.5;
    for (let i = -CELL; i < CELL*2; i += 11){
      line(x + i, y, x + i - CELL, y + CELL);
      line(x + i, y, x + i + CELL, y + CELL);
    }
    ctx.restore();
    ctx.strokeStyle = '#e9b13a'; ctx.lineWidth = 2;
    ctx.strokeRect(x + 4, y + 4, CELL - 8, CELL - 8);
  }
  if (cell.wait){
    // ponytail: 待轉區固定畫在格子中央。要貼齊特定路口角落時，改成跟號誌一樣依方向存。
    ctx.fillStyle = 'rgba(57,192,106,.45)';
    ctx.fillRect(x + 12, y + 12, CELL - 24, CELL - 24);
    ctx.strokeStyle = '#e6e9ee'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 12, y + 12, CELL - 24, CELL - 24);
    ctx.fillStyle = '#e6e9ee';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('待轉', cx, cy);
  }
}

// 號誌此刻實際顯示的燈態：輪播中以時相為準，暫停時才是手動設定的燈色。
// 畫面與車輛都必須走這裡，否則會出現「畫面綠燈但車子看到紅燈」。
function shown(cell, d){
  const s = cell.sig[d];
  if (!s) return null;
  if (!running()) return s;
  const ph = phaseAt(cell);
  return ph ? (ph.p.states[d] || {color:'R', arrows:[]}) : s;
}

function drawSignals(cell, cx, cy){
  const ph = running() ? phaseAt(cell) : null;
  Object.entries(cell.sig).forEach(([d, s]) => {
    const live = shown(cell, d);
    const [dx, dy] = DIRS[d];
    ctx.save();
    ctx.translate(cx + dx*CELL*0.42, cy + dy*CELL*0.42);   // 停止線外側
    ctx.rotate(Math.atan2(dy, dx));                        // 轉到面向該進口的座標系
    drawHead({lamps:s.lamps, color:live.color, arrows:live.arrows}, lampStart(d));
    ctx.restore();
  });
  if (ph) drawCount(cx, cy, ph.left);
  // 有燈具卻沒有時相：燈只會停在手動燈色，講清楚而不是讓畫面看起來像壞掉
  else if (running() && Object.keys(cell.sig).length) drawCount(cx, cy, '無時相');
}

function drawCount(cx, cy, secs){
  const w = typeof secs === 'number' ? 28 : 40;
  ctx.fillStyle = 'rgba(13,15,17,.82)';
  ctx.fillRect(cx - w/2, cy - 9, w, 18);
  ctx.strokeStyle = typeof secs === 'number' ? '#4b525a' : '#e9b13a';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w/2, cy - 9, w, 18);
  ctx.fillStyle = typeof secs === 'number' ? '#e6e9ee' : '#e9b13a';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(secs, cx, cy);
}

// 俯視圖下燈具是一條垂直於進口方向的橫桿：南北向進口看起來是橫列，東西向是直列
// 燈序的起點（紅燈落在燈桿哪一端）。可讀性優先，不追求幾何對稱：
// 紅燈一律放在燈桿偏西的那一端；燈桿垂直（東西向進口）時東西不分，就固定放上方。
// 兩根橫桿長得一樣、兩根直桿也長得一樣，不因進口方向而左右顛倒。
function lampStart(d){
  const [dx, dy] = DIRS[d];
  return dy === 0 ? -Math.sign(dx) : Math.sign(dy);
}

function drawHead(s, start){
  const list = HEADS[s.lamps];
  const depth = 13, len = list.length * 11 + 5;
  ctx.fillStyle = '#0d0f11';
  ctx.strokeStyle = '#4b525a'; ctx.lineWidth = 1;
  ctx.fillRect(-depth/2, -len/2, depth, len);
  ctx.strokeRect(-depth/2, -len/2, depth, len);

  list.forEach((k, i) => {
    const y = start * (len/2 - 8 - i*11);
    if (ROUND[k]) return lamp(y, s.color === k ? ROUND[k] : '#2a2e33');
    const on = s.arrows.includes(k);
    lamp(y, on ? '#39c06a' : '#2a2e33');
    arrow(y, arrowVec(k, start), on);
  });
}

function arrow(y, [vx, vy], on){
  const hx = vx*3.5, hy = y + vy*3.5;                 // 箭頭尖端
  const bx = hx - vx*3, by = hy - vy*3;               // 倒鉤起點
  const px = -vy*2.5, py = vx*2.5;
  ctx.strokeStyle = on ? '#0d0f11' : '#4b525a';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-hx, y - vy*3.5); ctx.lineTo(hx, hy);
  ctx.moveTo(hx, hy); ctx.lineTo(bx + px, by + py);
  ctx.moveTo(hx, hy); ctx.lineTo(bx - px, by - py);
  ctx.stroke();
}

function lamp(y, color){
  ctx.beginPath();
  ctx.arc(0, y, 4, 0, Math.PI*2);
  ctx.fillStyle = color;
  ctx.fill();
}

note.textContent =
  '輪播中燈色由時相決定，暫停後回到手動設定的燈色。黃燈與全紅都是獨立的時相。（build 19）';

syncPalette();
draw();
inspect();
