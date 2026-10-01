// ============================================================
// 加密货币资金面监控 —— 单文件 Worker（Cloudflare Dashboard 上传部署版）
// ============================================================
// 部署方式（不依赖 GitHub，不依赖 wrangler CLI）：
//   1. Cloudflare Dashboard → Workers & Pages → Create application → Create Worker
//   2. 删除默认模板代码，把本文件全部内容粘贴进去
//   3. 点 Deploy
//   4. 部署后在 Dashboard → Settings 绑定 D1（变量名必须 DB）+ 添加 WATCHLIST 变量
//   5. 回 Triggers 标签手动加一个 Cron（例如 */15 * * * *）实现自动采集
// D1 绑上后，首次访问 /api/ingest 会自动建表初始化（含旧库自动补列迁移），无需手动执行 SQL。
// ============================================================

// -------- 配置区（占位默认值；部署后用 Dashboard 变量 WATCHLIST 覆盖）--------
// 默认观察池（USDT 本位，逗号分隔，大小写不限）。
// 例如部署后加变量 WATCHLIST = BTCUSDT,ethusdt,SOLUSDT  （ethusdt 会自动转 ETHUSDT）
// 每新增一个币种，面板「币种」下拉框会自动多出一项。
const DEFAULT_WATCHLIST = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
];

const EXCHANGES = ['okx', 'bybit', 'gate'];
// 指标 = 三家交易所公开 API 全部可取的行情/合约指标（不含需付费的链上净流）
const METRICS = [
  { key: 'price', label: '最新价' },
  { key: 'change_pct', label: '24h 涨跌幅(%)' },
  { key: 'high_24h', label: '24h 最高价' },
  { key: 'low_24h', label: '24h 最低价' },
  { key: 'volume_24h', label: '24h 成交额(USDT)' },
  { key: 'open_interest', label: '合约持仓量(OI)' },
  { key: 'funding_rate', label: '资金费率' },
];
const METRIC_KEYS = METRICS.map((m) => m.key);

// 观察池：优先用环境变量 WATCHLIST（大小写不限），否则用上方默认占位值。
function getWatchlist(env) {
  const raw = env && env.WATCHLIST;
  if (raw && typeof raw === 'string' && raw.trim()) {
    const list = raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  return DEFAULT_WATCHLIST;
}

// ============================================================
// 交易所公开 REST API 采集 + 归一化（免费额度友好）
// 仅支持 USDT 本位：<币种>USDT
// ============================================================

// 归一化交易对名：去分隔符、大写。BTC-USDT / BTC_USDT / BTCUSDT → BTCUSDT
function norm(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'crypto-monitor/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 24h 涨跌幅（%）：优先用交易所自带字段，缺 open24h 时由 last/open 计算
function pctChange(last, open) {
  if (last == null || open == null || open === 0) return null;
  return ((last - open) / open) * 100;
}

// ---------- 采集策略说明 ----------
// 数据源：OKX / Bybit / Gate.io（Binance 已按需求移除——它对 Cloudflare 边缘 IP 地理封锁不友好）。
// 免费版 Worker 单次调用 CPU 仅 10ms：拉全市场大 JSON（如 Bybit 全 ticker ≈ 1MB+），
// 光 JSON.parse 就会超限，后台任务被静默掐死，D1 一条都写不进。
// 因此 OKX/Gate 用单对或 bulk 中等响应接口，Bybit 按观察池逐个小请求，控制总子请求数在免费版 50 上限内。
// 7 币 ≈ 37 个子请求（OKX 9 + Bybit 14 + Gate 14）；观察池超过 ~10 个币会撞上限。

// ---------- OKX ----------
async function collectOkx(watch) {
  const syms = [...watch].filter((s) => s.endsWith('USDT'));
  if (!syms.length) return [];
  // 一次拉全 SPOT ticker（响应约 160KB，CPU 可承受）；逐个请求易被限流后静默归零
  const r = await fetchJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  const map = {};
  for (const t of (r && r.data) || []) {
    const sym = String(t.instId).replace(/-USDT$/, '') + 'USDT';
    if (!watch.has(sym)) continue;
    const last = num(t.last);
    const open24 = num(t.open24h);
    map[sym] = {
      exchange: 'okx',
      symbol: sym,
      price: last,
      high_24h: num(t.high24h),
      low_24h: num(t.low24h),
      change_pct: pctChange(last, open24),
      volume_24h: num(t.volCcy24h) != null ? num(t.volCcy24h) : num(t.vol24h), // 优先 USDT 计价量
      open_interest: null,
      funding_rate: null,
    };
  }
  // 资金费率逐个（失败只降级为 null）；持仓量一次拉全 SWAP
  await Promise.allSettled(
    Object.keys(map).map(async (s) => {
      try {
        const rr = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${s.replace(/USDT$/, '-USDT')}`);
        map[s].funding_rate = num(rr.data && rr.data[0] && rr.data[0].fundingRate);
      } catch {}
    })
  );
  try {
    const oi = await fetchJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP');
    const oiMap = new Map(
      ((oi && oi.data) || []).map((o) => [String(o.instId).replace(/-USDT-SWAP$/, '') + 'USDT', num(o.oi)])
    );
    for (const [s, v] of Object.entries(map)) if (oiMap.has(s)) v.open_interest = oiMap.get(s);
  } catch {}
  return Object.values(map);
}

// ---------- Bybit ----------
async function collectBybit(watch) {
  const syms = [...watch].filter((s) => s.endsWith('USDT'));
  if (!syms.length) return [];
  const map = {};
  await Promise.allSettled(
    syms.map(async (s) => {
      try {
        const r = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`);
        const t = r.result && r.result.list && r.result.list[0];
        if (!t) return;
        map[s] = {
          exchange: 'bybit',
          symbol: s,
          price: num(t.lastPrice),
          high_24h: num(t.highPrice24h),
          low_24h: num(t.lowPrice24h),
          change_pct: num(t.price24hPcnt) != null ? num(t.price24hPcnt) * 100 : null, // Bybit 给的是小数
          volume_24h: num(t.turnover24h), // USDT 计价成交额，与 OKX/Gate 口径对齐
          open_interest: null,
          funding_rate: t.fundingRate != null ? num(t.fundingRate) : null,
        };
      } catch {}
    })
  );
  await Promise.allSettled(
    Object.keys(map).map(async (s) => {
      try {
        const r = await fetchJson(
          `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=5min&limit=1`
        );
        const oi = r.result && r.result.list && r.result.list[0] && r.result.list[0].openInterest;
        if (oi != null) map[s].open_interest = num(oi);
      } catch {}
    })
  );
  return Object.values(map);
}

// ---------- Gate.io ----------
async function collectGate(watch) {
  const syms = [...watch].filter((s) => s.endsWith('USDT'));
  if (!syms.length) return [];
  const map = {};
  await Promise.allSettled(
    syms.map(async (s) => {
      const pair = s.replace(/USDT$/, '_USDT');
      try {
        const t = await fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`);
        const x = Array.isArray(t) ? t[0] : t;
        if (!x) return;
        map[s] = {
          exchange: 'gate',
          symbol: s,
          price: num(x.last),
          high_24h: num(x.high_24h),
          low_24h: num(x.low_24h),
          change_pct: num(x.change_percentage), // Gate 直接给百分比
          volume_24h: num(x.quote_volume), // USDT 计价
          open_interest: null,
          funding_rate: null,
        };
      } catch {}
      try {
        const c = await fetchJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${pair}`);
        map[s].funding_rate = num(c.funding_rate);
        map[s].open_interest = num(c.open_interest != null ? c.open_interest : c.total_size);
      } catch {}
    })
  );
  return Object.values(map);
}

// 并行采集，单家失败不影响其他家；返回 { rows, detail }（detail 供 /api/ingest 直接返回给浏览器排障）
const EXCHANGE_FNS = [
  ['okx', collectOkx],
  ['bybit', collectBybit],
  ['gate', collectGate],
];

async function collectAll(watchlist) {
  const watch = new Set((watchlist || []).map(norm));
  const ts = Date.now();
  const results = await Promise.allSettled(EXCHANGE_FNS.map(([, f]) => f(watch)));
  const rows = [];
  const detail = [];
  results.forEach((r, i) => {
    const name = EXCHANGE_FNS[i][0];
    if (r.status === 'fulfilled') {
      for (const row of r.value) rows.push({ ts, ...row });
      detail.push({ exchange: name, ok: true, count: r.value.length });
    } else {
      detail.push({
        exchange: name,
        ok: false,
        count: 0,
        error: String((r.reason && r.reason.message) || r.reason).slice(0, 200),
      });
    }
  });
  return { rows, detail };
}

// ============================================================
// D1 写入 + 查询（本监控唯一存储后端）
// ============================================================

// 自动建表（首次写入/查询前调用，幂等）。D1 绑定后访问 /api/ingest 即自动初始化。
// 注意：不用 db.exec(多语句)——D1 的 exec 会把多行 SQL 切碎导致 "incomplete input"。
// 改用 prepare().run() 逐条执行，并用隔离级标志缓存，避免每次查询都跑建表。
const STMT_TABLE = `CREATE TABLE IF NOT EXISTS market_snapshot (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  exchange         TEXT    NOT NULL,
  symbol           TEXT    NOT NULL,
  price            REAL,
  high_24h         REAL,
  low_24h          REAL,
  change_pct       REAL,
  volume_24h       REAL,
  open_interest    REAL,
  funding_rate     REAL,
  taker_buy_volume REAL,
  created_at       INTEGER DEFAULT (strftime('%s','now'))
)`;
const STMT_IDX_1 = `CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshot(ts)`;
const STMT_IDX_2 = `CREATE INDEX IF NOT EXISTS idx_snap_ex_sym_ts ON market_snapshot(exchange, symbol, ts)`;

// 旧库自动补列（幂等：列已存在时报错被吞掉）
const MIGRATIONS = [
  'ALTER TABLE market_snapshot ADD COLUMN high_24h REAL',
  'ALTER TABLE market_snapshot ADD COLUMN low_24h REAL',
  'ALTER TABLE market_snapshot ADD COLUMN change_pct REAL',
];

let schemaReadySet = new WeakSet();
async function ensureSchema(db) {
  if (schemaReadySet.has(db)) return;
  await db.prepare(STMT_TABLE).run();
  await db.prepare(STMT_IDX_1).run();
  await db.prepare(STMT_IDX_2).run();
  for (const m of MIGRATIONS) {
    try {
      await db.prepare(m).run();
    } catch {} // duplicate column / 旧库已迁移 → 忽略
  }
  schemaReadySet.add(db);
}

const COLS =
  '(ts, exchange, symbol, price, high_24h, low_24h, change_pct, volume_24h, open_interest, funding_rate, taker_buy_volume)';
const SQL = `INSERT INTO market_snapshot ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

// 批量写入，自动按 100 条切分（D1 batch 单次上限 100 条语句）
async function insertSnapshots(db, rows) {
  if (!rows.length) return 0;
  await ensureSchema(db);
  const chunks = [];
  for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));

  let inserted = 0;
  for (const chunk of chunks) {
    const stmts = chunk.map((r) =>
      db
        .prepare(SQL)
        .bind(
          r.ts,
          r.exchange,
          r.symbol,
          r.price ?? null,
          r.high_24h ?? null,
          r.low_24h ?? null,
          r.change_pct ?? null,
          r.volume_24h ?? null,
          r.open_interest ?? null,
          r.funding_rate ?? null,
          r.taker_buy_volume ?? null
        )
    );
    await db.batch(stmts);
    inserted += chunk.length;
  }
  return inserted;
}

// 按日期区间 / 交易所 / 币种查询（面板主路径）
async function querySnapshots(db, params) {
  await ensureSchema(db);
  if (!METRIC_KEYS.includes(params.metric)) params.metric = 'price';
  const where = [];
  const args = [];
  if (params.from != null) {
    where.push('ts >= ?');
    args.push(params.from);
  }
  if (params.to != null) {
    where.push('ts <= ?');
    args.push(params.to);
  }
  if (params.exchange && EXCHANGES.includes(params.exchange)) {
    where.push('exchange = ?');
    args.push(params.exchange);
  }
  if (params.symbol) {
    where.push('symbol = ?');
    args.push(params.symbol);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `SELECT ts, exchange, symbol, price, high_24h, low_24h, change_pct, volume_24h, open_interest, funding_rate FROM market_snapshot ${w} ORDER BY ts ASC LIMIT 5000`;

  const { results } = await db.prepare(sql).bind(...args).all();
  return { metric: params.metric, count: results.length, rows: results };
}

// 诊断：库里到底有什么（总数 / 各交易所 / 各币种 / 时间范围）
async function debugStats(db) {
  await ensureSchema(db);
  const range = await db
    .prepare('SELECT COUNT(*) AS total, MIN(ts) AS oldest, MAX(ts) AS latest FROM market_snapshot')
    .all();
  const byEx = await db.prepare('SELECT exchange, COUNT(*) AS n FROM market_snapshot GROUP BY exchange').all();
  const bySym = await db.prepare('SELECT symbol, COUNT(*) AS n FROM market_snapshot GROUP BY symbol').all();
  const r = (range.results && range.results[0]) || {};
  return {
    total: r.total || 0,
    oldest_ts: r.oldest || null,
    latest_ts: r.latest || null,
    by_exchange: byEx.results || [],
    by_symbol: bySym.results || [],
  };
}

// ============================================================
// 面板（内联 HTML，单 Worker 直接托管，无需静态资源绑定）
// 版式按 1920×1080 主屏优化：1680px 宽幅 + 大字号 + 大图区；支持黑夜/白天主题切换（记忆偏好）
// ============================================================
function serveDashboard() {
  const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>加密货币资金面监控面板</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root, html[data-theme="dark"] {
    --bg:#0f1115; --card:#171a21; --line:#262b36; --input:#0c0e12;
    --txt:#e6e9ef; --muted:#8b93a7; --accent:#4f9dff; --accent-txt:#fff;
    --up:#26a69a; --down:#ef5350; --shadow:0 2px 12px rgba(0,0,0,.35);
  }
  html[data-theme="light"] {
    --bg:#f4f6fa; --card:#ffffff; --line:#e2e7f0; --input:#eef1f7;
    --txt:#1c2330; --muted:#5a6478; --accent:#2563eb; --accent-txt:#fff;
    --up:#0f9d84; --down:#e5484d; --shadow:0 2px 12px rgba(30,40,60,.08);
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         transition: background .25s ease, color .25s ease; }
  header { padding:20px 32px; border-bottom:1px solid var(--line); display:flex;
           align-items:center; gap:16px; flex-wrap:wrap; background:var(--card); }
  header h1 { font-size:22px; margin:0; letter-spacing:.5px; }
  header .sub { color:var(--muted); font-size:13px; flex:1; }
  .wrap { padding:24px 32px; max-width:1680px; margin:0 auto; }
  .controls { display:flex; flex-wrap:wrap; gap:20px; background:var(--card);
              border:1px solid var(--line); border-radius:14px; padding:20px 24px;
              align-items:flex-end; box-shadow:var(--shadow); }
  .field { display:flex; flex-direction:column; gap:7px; }
  .field label { font-size:13px; color:var(--muted); font-weight:500; }
  select, input { background:var(--input); color:var(--txt); border:1px solid var(--line);
                  border-radius:9px; padding:10px 12px; font-size:14px; min-width:190px; }
  select:focus, input:focus { outline:none; border-color:var(--accent); }
  .checks { display:flex; gap:16px; flex-wrap:wrap; padding:10px 0 8px; }
  .checks label { display:flex; gap:7px; align-items:center; color:var(--txt); font-size:14px; cursor:pointer; }
  .checks input { min-width:0; width:16px; height:16px; accent-color:var(--accent); cursor:pointer; }
  button { background:var(--accent); color:var(--accent-txt); border:0; border-radius:9px;
           padding:11px 26px; font-size:15px; cursor:pointer; font-weight:600; }
  button:disabled { opacity:.5; cursor:default; }
  button.ghost { background:transparent; color:var(--txt); border:1px solid var(--line);
                 font-weight:400; padding:8px 16px; font-size:13px; }
  button.ghost:hover { border-color:var(--accent); color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
          padding:20px 24px; margin-top:20px; box-shadow:var(--shadow); }
  .card h2 { margin:0 0 6px; font-size:16px; color:var(--muted); font-weight:500; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; margin-top:16px; }
  .stat { background:var(--input); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .stat .k { color:var(--muted); font-size:13px; }
  .stat .v { font-size:24px; margin-top:6px; font-weight:600; }
  .up { color:var(--up); } .down { color:var(--down); }
  table { width:100%; border-collapse:collapse; margin-top:18px; font-size:14px; }
  th, td { text-align:left; padding:11px 14px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; font-size:13px; }
  tr:hover td { background:var(--input); }
  .hint { color:var(--muted); font-size:13px; margin-top:10px; }
  #status { color:var(--muted); font-size:13px; margin-top:12px; min-height:18px; }
  @media (max-width: 900px) { .wrap { padding:16px; } select, input { min-width:150px; } }
</style>
</head>
<body>
<header>
  <h1>加密货币资金面监控面板</h1>
  <span class="sub">OKX · Bybit · Gate.io ｜ 数据存于 Cloudflare D1</span>
  <button id="themeBtn" class="ghost" title="切换黑夜/白天模式">☀️ 白天模式</button>
</header>
<div class="wrap">
  <div class="controls">
    <div class="field">
      <label>开始时间</label>
      <input type="datetime-local" id="from" />
    </div>
    <div class="field">
      <label>结束时间</label>
      <input type="datetime-local" id="to" />
    </div>
    <div class="field">
      <label>币种</label>
      <select id="symbol"></select>
    </div>
    <div class="field">
      <label>指标</label>
      <select id="metric"></select>
    </div>
    <div class="field">
      <label>交易所</label>
      <div class="checks" id="exchecks"></div>
    </div>
    <button id="run">查 询</button>
  </div>
  <div id="status"></div>

  <div class="card">
    <h2>指标走势</h2>
    <canvas id="chart" height="150"></canvas>
    <div class="hint">折线展示所选币种在指定时间区间内、各交易所的指标走势；鼠标悬停看数值。</div>
  </div>

  <div class="card">
    <h2>区间汇总</h2>
    <div class="grid" id="stats"></div>
    <table id="tbl">
      <thead><tr><th>交易所</th><th>首值</th><th>末值</th><th>区间涨跌</th><th>数据点</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
  const EXCHANGES = ${JSON.stringify(EXCHANGES)};
  const METRICS = ${JSON.stringify(METRICS)};
  const EX_LABELS = { okx:'OKX', bybit:'Bybit', gate:'Gate.io' };
  const EX_COLORS = { okx:'#4f9dff', bybit:'#ff7a45', gate:'#2bbf6a' };
  const THEMES = {
    dark:  { tick:'#8b93a7', grid:'#262b36', legend:'#e6e9ef' },
    light: { tick:'#5a6478', grid:'#e2e7f0', legend:'#1c2330' },
  };

  // ---- 主题切换（记忆到 localStorage）----
  const themeBtn = document.getElementById('themeBtn');
  function curTheme(){ return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
  function applyTheme(t, save) {
    document.documentElement.dataset.theme = t;
    themeBtn.textContent = t === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式';
    if (save) { try { localStorage.setItem('cm-theme', t); } catch(e){} }
    redraw();
  }
  themeBtn.addEventListener('click', () => applyTheme(curTheme() === 'dark' ? 'light' : 'dark', true));
  try { applyTheme(localStorage.getItem('cm-theme') || 'dark', false); } catch(e){ redraw(); }

  const symSel = document.getElementById('symbol');
  const metSel = document.getElementById('metric');
  METRICS.forEach(m => { const o=document.createElement('option'); o.value=m.key; o.textContent=m.label; metSel.appendChild(o); });
  const exBox = document.getElementById('exchecks');
  EXCHANGES.forEach(e => { const l=document.createElement('label'); l.innerHTML='<input type="checkbox" value="'+e+'" checked>'+EX_LABELS[e]; exBox.appendChild(l); });

  // 观察池来自 /api/config（= 部署时环境变量 WATCHLIST，缺省用内置默认）
  let WATCHLIST = ['BTCUSDT'];
  fetch('/api/config').then(r=>r.json()).then(cfg=>{
    WATCHLIST = cfg.watchlist || WATCHLIST;
    WATCHLIST.forEach(s => { const o=document.createElement('option'); o.value=s; o.textContent=s; symSel.appendChild(o); });
    document.getElementById('status').textContent = '数据存于 Cloudflare D1 ｜ 观察池 ' + WATCHLIST.length + ' 个';
  }).catch(()=>{
    ['BTCUSDT','ETHUSDT','SOLUSDT'].forEach(s=>{ const o=document.createElement('option'); o.value=s; o.textContent=s; symSel.appendChild(o); });
  });

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7*864e5);
  // ⚠️ 必须用本地时间格式化填 datetime-local：toISOString() 是 UTC，
  // 而 new Date(input.value) 按本地时区解析，GMT+8 下会把查询窗口结束时间提前 8 小时，
  // 导致刚采集的数据全部落在窗口之外、面板永远「命中 0 条」。
  const fmt = d => {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  document.getElementById('to').value = fmt(now);
  document.getElementById('from').value = fmt(weekAgo);

  let chart;
  let lastQuery = null; // { rows, exs, metric } —— 主题切换后重绘用
  document.getElementById('run').addEventListener('click', run);

  function metricLabel(key){ const m = METRICS.find(x=>x.key===key); return m ? m.label : key; }

  async function run() {
    const btn = document.getElementById('run'); btn.disabled = true;
    const status = document.getElementById('status');
    status.textContent = '查询中…';
    const from = new Date(document.getElementById('from').value).getTime();
    const to = new Date(document.getElementById('to').value).getTime();
    const symbol = document.getElementById('symbol').value;
    const metric = document.getElementById('metric').value;
    const exs = [...document.querySelectorAll('#exchecks input:checked')].map(i=>i.value);
    if (!exs.length) { status.textContent='请至少选一个交易所'; btn.disabled=false; return; }

    const params = new URLSearchParams({ from, to, symbol, metric });
    let data;
    try {
      const res = await fetch('/api/query?'+params.toString());
      if (!res.ok) {
        const txt = await res.text();
        status.textContent = '请求失败：HTTP ' + res.status + ' ' + (txt || '').slice(0, 160);
        btn.disabled = false; return;
      }
      data = await res.json();
    } catch(e) { status.textContent='请求失败：'+e.message; btn.disabled=false; return; }

    if (data && data.ok === false) {
      status.textContent = '查询失败：' + (data.error || '未知错误');
      btn.disabled = false; return;
    }

    const rows = data.rows || [];
    status.textContent = '命中 '+rows.length+' 条（上限 5000，超出请缩窄区间）。'+(rows.length>=5000?' ⚠️ 已截断':'');
    lastQuery = { rows, exs, metric };
    drawChart(rows, exs, metric);
    drawStats(rows, exs, metric);
    btn.disabled = false;
  }

  // 主题切换时用上次查询结果重绘（换配色不丢图）
  function redraw() {
    if (!lastQuery) return;
    drawChart(lastQuery.rows, lastQuery.exs, lastQuery.metric);
  }

  function valOf(r, metric){ return r[metric]; }

  function drawChart(rows, exs, metric) {
    const th = THEMES[curTheme()];
    const byEx = {};
    exs.forEach(e => byEx[e] = []);
    rows.forEach(r => { if (byEx[r.exchange]) byEx[r.exchange].push({ x: r.ts, y: valOf(r, metric) }); });
    const datasets = exs.map(e => ({
      label: EX_LABELS[e] || e,
      data: byEx[e],
      borderColor: EX_COLORS[e] || '#999',
      backgroundColor: (EX_COLORS[e] || '#999') + '33',
      pointRadius: 0,
      borderWidth: 2,
      spanGaps: true,
    }));
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('chart'), {
      type: 'line',
      data: { datasets },
      options: {
        parsing: false,
        animation: false,
        interaction: { mode:'nearest', intersect:false },
        scales: {
          x: { type:'linear', ticks:{ color:th.tick, maxTicksLimit:12, callback:v=>new Date(v).toLocaleString() }, grid:{ color:th.grid } },
          y: { ticks:{ color:th.tick }, grid:{ color:th.grid } }
        },
        plugins: { legend:{ labels:{ color:th.legend, boxWidth:18 } } }
      }
    });
  }

  function drawStats(rows, exs, metric) {
    const statsEl = document.getElementById('stats'); statsEl.innerHTML='';
    const tbody = document.querySelector('#tbl tbody'); tbody.innerHTML='';
    exs.forEach(e => {
      const pts = rows.filter(r => r.exchange===e && valOf(r,metric)!=null).map(r=>({ts:r.ts, v:valOf(r,metric)}));
      if (!pts.length) return;
      pts.sort((a,b)=>a.ts-b.ts);
      const first = pts[0].v, last = pts[pts.length-1].v;
      const pct = first ? ((last-first)/Math.abs(first)*100) : 0;
      const cls = pct>=0 ? 'up' : 'down';
      const arrow = pct>=0 ? '▲' : '▼';
      const stat = document.createElement('div'); stat.className='stat';
      stat.innerHTML = '<div class="k">'+(EX_LABELS[e]||e)+' ｜ '+metricLabel(metric)+'</div><div class="v '+cls+'">'+arrow+' '+pct.toFixed(2)+'%</div>';
      statsEl.appendChild(stat);
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>'+(EX_LABELS[e]||e)+'</td><td>'+fmtNum(first)+'</td><td>'+fmtNum(last)+'</td><td class="'+cls+'">'+arrow+' '+pct.toFixed(2)+'%</td><td>'+pts.length+'</td>';
      tbody.appendChild(tr);
    });
  }
  function fmtNum(n){ if(n==null) return '—'; if(Math.abs(n)>=1e9) return (n/1e9).toFixed(2)+'B'; if(Math.abs(n)>=1e6) return (n/1e6).toFixed(2)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(2)+'K'; return n.toFixed(Math.abs(n)<1?6:2); }

  run();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ============================================================
// 入口
// ============================================================
async function runIngest(env) {
  const { rows, detail } = await collectAll(getWatchlist(env));
  let inserted = 0;
  let error = null;
  try {
    inserted = await insertSnapshots(env.DB, rows);
  } catch (e) {
    error = 'D1 写入失败：' + ((e && e.message) || String(e));
  }
  console.log(`[ingest] collected=${rows.length} inserted=${inserted}${error ? ' error=' + error : ''}`);
  return { collected: rows.length, inserted, detail, error };
}

function numOrNull(v) {
  return v && /^-?\d+$/.test(v) ? Number(v) : null;
}

async function handleQuery(request, env) {
  if (!env.DB) {
    return Response.json(
      {
        ok: false,
        error:
          'D1 尚未绑定或未生效：请在 Worker → Settings → Bindings 添加「变量名 DB」的 D1 数据库绑定，并重新部署一次后再查询。',
      },
      { status: 200 }
    );
  }
  try {
    const url = new URL(request.url);
    const params = {
      from: numOrNull(url.searchParams.get('from')),
      to: numOrNull(url.searchParams.get('to')),
      exchange: (url.searchParams.get('exchange') || '').trim(),
      symbol: (url.searchParams.get('symbol') || '').trim().toUpperCase(),
      metric: url.searchParams.get('metric') || 'price',
    };
    if (!METRIC_KEYS.includes(params.metric)) params.metric = 'price';
    const data = await querySnapshots(env.DB, params);
    return Response.json({ ok: true, ...data });
  } catch (e) {
    return Response.json(
      { ok: false, error: '查询异常：' + (e && e.message ? e.message : String(e)) },
      { status: 200 }
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/query') return handleQuery(request, env);
      if (path === '/api/config') {
        return Response.json({
          watchlist: getWatchlist(env),
          exchanges: EXCHANGES,
          metrics: METRICS,
        });
      }
      if (path === '/api/health') return Response.json({ ok: true, ts: Date.now() });
      if (path === '/api/debug') {
        if (!env.DB) {
          return Response.json(
            { ok: false, error: 'D1 尚未绑定：请在 Worker → Settings → Bindings 添加变量名为 DB 的 D1 绑定并重新部署。' },
            { status: 200 }
          );
        }
        return Response.json({ ok: true, ...(await debugStats(env.DB)) });
      }
      if (path === '/api/ingest') {
        if (!env.DB) {
          return Response.json(
            {
              ok: false,
              error:
                'D1 尚未绑定或未生效：请在 Worker → Settings → Bindings 添加「变量名 DB」的 D1 数据库绑定，并重新部署一次后再触发采集。',
            },
            { status: 200 }
          );
        }
        // 同步执行，把每家交易所的采集条数/错误直接返回给浏览器，便于排障
        const result = await runIngest(env);
        return Response.json({ ok: true, ...result });
      }
      return serveDashboard();
    } catch (e) {
      // 任何未捕获异常都返回 JSON，避免前端拿到 HTML(<!DOCTYPE) 报错
      return new Response(
        JSON.stringify({
          ok: false,
          error: '服务器异常：' + (e && e.message ? e.message : String(e)),
        }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }
      );
    }
  },

  // 定时采集（需在此 Worker 的 Dashboard → Triggers 手动添加 Cron 触发，例如 */15 * * * *）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env));
  },
};
