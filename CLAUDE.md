# Spatial-Flow-Simulation

每個子目錄是獨立的靜態網頁專案：`index.html` + `main.js` + `style.css`，需要 server 才加 `server.py`（標準函式庫）。介面文字用繁體中文，深色主題，風格沿用 Traffic-Light。

## Indoor-Pedestrian-Flow

- 模擬核心在 `sim.js`（無 DOM、Node 可跑）；`main.js` 只做編輯器與繪圖。改行為改 `sim.js`。
- 場景是 `sim.js` 的 scene 物件，外部輸入一律經 `normalize()`。
- **雲端／無瀏覽器環境**用 `node headless.js`（見該目錄 README）；它是驗證模擬行為的主要方式，先跑一次確認標線 有／無 的結果合理再改動。
- 看畫面：`python server.py` 後開 `http://localhost:8000`。雲端要對外請 `HOST=0.0.0.0`。
- 比較實驗要用同一種子；單一種子差異不可靠，用 `--seeds 5` 以上。
- 沒有自動化測試。改動 `sim.js` 後至少跑 `node headless.js --n 500`，確認 `exited == spawned`（沒有人卡死）。
