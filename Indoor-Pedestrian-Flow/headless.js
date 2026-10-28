// 無畫面批次模擬（Node，不需瀏覽器），給雲端 session／CI 用。
//   node headless.js [scene.json] [--n 1000] [--seed 1] [--compliance 80] [--seeds 5] [--json out.json]
// 預設跑 scenes/tainan-station.json，同種子各跑「無標線／有標線」一次並印出比較表。
// --seeds K：連跑 K 個種子（seed, seed+1, …）取平均，單一種子的差異可能只是運氣。
const fs = require('fs');
const path = require('path');
const {Sim, normalize, demoScene} = require('./sim.js');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const scene = file ? normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
  : fs.existsSync(path.join(__dirname, 'scenes/tainan-station.json'))
    ? normalize(JSON.parse(fs.readFileSync(path.join(__dirname, 'scenes/tainan-station.json'), 'utf8')))
    : demoScene();
if (opt('n')) scene.params.total = +opt('n');
if (opt('compliance')) scene.params.compliance = +opt('compliance');
const seed0 = opt('seed') !== undefined ? +opt('seed') : scene.params.seed;
const K = Math.max(1, +opt('seeds') || 1);

const KEYS = [['t', '完成時間 (秒)'], ['passDelay', '路過者平均延遲 (秒)'], ['passTime', '路過者平均通過 (秒)'],
  ['speed', '平均步行速度 (m/s)'], ['slowPct', '擁擠指數 (%)'], ['peak', '最高格密度 (人/m²)'],
  ['stopN', '駐足人數'], ['stopDwell', '平均駐足 (秒)']];

const runs = {off: [], on: []};
let stuck = 0;
for (let k = 0; k < K; k++)
  for (const [name, m] of [['off', false], ['on', true]]) {
    const s = new Sim(scene, {markings: m, seed: seed0 + k});
    if (s.noFlow) { console.error('場景需要至少一個入口和一個出口'); process.exit(1); }
    const tMax = 3600;  // 保險：模擬時間上限，超過視為有人卡死
    while (!s.finished && s.t < tMax) s.step();
    const sm = s.summary();
    runs[name].push(sm);
    if (!s.finished || sm.exited !== sm.spawned) {
      stuck++;
      console.error(`警告：種子 ${seed0 + k} 標線${m ? '有' : '無'}：spawned=${sm.spawned} exited=${sm.exited} 場內=${sm.present}`);
    }
  }

const mean = (list, key) => list.reduce((a, r) => a + r[key], 0) / list.length;
console.log(`${scene.params.total} 人 · 遵守率 ${scene.params.compliance}% · 種子 ${seed0}${K > 1 ? '…' + (seed0 + K - 1) : ''}`);
console.log(stuck ? `卡死檢查：${stuck} 次未清場` : `卡死檢查：全部 ${2 * K} 次 exited == spawned`);
console.log('指標'.padEnd(22) + '無標線'.padStart(10) + '有標線'.padStart(10) + '差'.padStart(8));
const result = {};
for (const [key, label] of KEYS) {
  const a = mean(runs.off, key), b = mean(runs.on, key);
  result[key] = {off: a, on: b};
  console.log(label.padEnd(20) + a.toFixed(2).padStart(10) + b.toFixed(2).padStart(10) +
    (a ? ((b - a) / a * 100).toFixed(0) + '%' : '—').padStart(8));
}
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify({params: scene.params, seeds: K, seed0, stuck, result}, null, 1));
