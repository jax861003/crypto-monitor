// ============================================================
// 加密货币资金面监控 —— 单文件 Worker（Cloudflare Dashboard 上传部署版）
// ============================================================
// 部署方式（不依赖 GitHub，不依赖 wrangler CLI）：
//   1. Cloudflare Dashboard → Workers & Pages → Create application → Create Worker
//   2. 删除默认模板代码，把本文件全部内容粘贴进去
//   3. 点 Deploy
//   4. 部署后在 Dashboard → Settings 绑定 D1（变量名必须 DB）+ 添加 WATCHLIST 变量
//   5. 回 Triggers 标签手动加一个 Cron（例如 */15 * * * *）实现自动采集
// D1 绑上后，首次访问 /api/ingest 会自动建表初始化，无需手动执行 SQL。
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

const EXCHANGES = ['binance', 'okx', 'bybit', 'gate'];
const METRICS = [
  { key: 'price', label: '价格' },
  { key: 'volume_24h', label: '24h 成交量' },
  { key: 'open_interest', label: '合约持仓量(OI)' },
  { key: 'funding_rate', label: '资金费率' },
];

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
// 四家交易所公开 REST API 采集 + 归一化（免费额度友好）
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

// ---------- Binance ----------
async function collectBinance(watch) {
  const spotBase = 'https://api.binance.com';
  const fBase = 'https://fapi.binance.com';
  // Binance 主站对美区 IP 返回 451（地理封锁）。Cloudflare 边缘多在非美区，常能通但不保证；
  // 失败会被 collectAll 捕获并跳过，不影响其他三家。
  const [spot, prem] = await Promise.all([
    fetchJson(`${spotBase}/api/v3/ticker/24hr`).catch(() => []),
    fetchJson(`${fBase}/fapi/v1/premiumIndex`).catch(() => []),
  ]);
  const map = {};
  for (const t of spot) {
    if (watch.has(t.symbol)) {
      map[t.symbol] = {
        exchange: 'binance',
        symbol: t.symbol,
        price: num(t.lastPrice),
        volume_24h: num(t.quoteVolume),
        open_interest: null,
        funding_rate: null,
      };
    }
  }
  const fr = new Map(prem.map((p) => [p.symbol, num(p.fundingRate)]));
  const oi = await Promise.allSettled(
    Object.keys(map).map(async (s) => {
      const r = await fetchJson(`${fBase}/fapi/v1/openInterest?symbol=${s}`);
      return { s, oi: num(r.openInterest) };
    })
  );
  for (const x of oi) {
    if (x.status === 'fulfilled' && map[x.value.s]) map[x.value.s].open_interest = x.value.oi;
  }
  for (const [s, v] of Object.entries(map)) if (fr.has(s)) v.funding_rate = fr.get(s);
  return Object.values(map);
}

// ---------- OKX ----------
async function collectOkx(watch) {
  const r = await fetchJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  const map = {};
  for (const t of r.data || []) {
    const sym = norm(t.instId);
    if (watch.has(sym)) {
      map[sym] = {
        exchange: 'okx',
        symbol: sym,
        price: num(t.last),
        volume_24h: num(t.vol24h),
        open_interest: null,
        funding_rate: null,
      };
    }
  }
  const insts = Object.keys(map).map((s) => s.replace('USDT', '-USDT'));
  const [fr, oi] = await Promise.all([
    Promise.allSettled(
      insts.map(async (i) => {
        const r = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${i}`);
        return { i, v: num(r.data?.[0]?.fundingRate) };
      })
    ),
    Promise.allSettled(
      insts.map(async (i) => {
        const r = await fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${i}`);
        return { i, v: num(r.data?.[0]?.oi) };
      })
    ),
  ]);
  const frMap = new Map(fr.filter((x) => x.status === 'fulfilled').map((x) => [norm(x.value.i), x.value.v]));
  const oiMap = new Map(oi.filter((x) => x.status === 'fulfilled').map((x) => [norm(x.value.i), x.value.v]));
  for (const [sym, v] of Object.entries(map)) {
    if (frMap.has(sym)) v.funding_rate = frMap.get(sym);
    if (oiMap.has(sym)) v.open_interest = oiMap.get(sym);
  }
  return Object.values(map);
}

// ---------- Bybit ----------
async function collectBybit(watch) {
  const r = await fetchJson('https://api.bybit.com/v5/market/tickers?category=linear');
  const list = r.result?.list || [];
  const map = {};
  for (const t of list) {
    const sym = norm(t.symbol);
    if (watch.has(sym)) {
      map[sym] = {
        exchange: 'bybit',
        symbol: sym,
        price: num(t.lastPrice),
        volume_24h: num(t.volume24h),
        open_interest: null,
        funding_rate: t.fundingRate != null ? num(t.fundingRate) : null,
      };
    }
  }
  const oi = await Promise.allSettled(
    Object.keys(map).map(async (s) => {
      const r = await fetchJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}`);
      return { s, oi: num(r.result?.openInterest) };
    })
  );
  for (const x of oi) {
    if (x.status === 'fulfilled' && map[x.value.s]) map[x.value.s].open_interest = x.value.oi;
  }
  return Object.values(map);
}

// ---------- Gate.io ----------
async function collectGate(watch) {
  const [spot, fut] = await Promise.all([
    fetchJson('https://api.gateio.ws/api/v4/spot/tickers').catch(() => []),
    fetchJson('https://api.gateio.ws/api/v4/futures/usdt/contracts').catch(() => []),
  ]);
  const map = {};
  for (const t of spot) {
    const sym = norm(t.currency_pair);
    if (watch.has(sym)) {
      map[sym] = {
        exchange: 'gate',
        symbol: sym,
        price: num(t.last),
        volume_24h: num(t.quote_volume),
        open_interest: null,
        funding_rate: null,
      };
    }
  }
  const fr = new Map(fut.map((c) => [norm(c.contract), num(c.funding_rate)]));
  for (const [sym, v] of Object.entries(map)) if (fr.has(sym)) v.funding_rate = fr.get(sym);
  const oi = await Promise.allSettled(
    Object.keys(map).map(async (s) => {
      try {
        const r = await fetchJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${s.replace('USDT', '_USDT')}`);
        return { s, oi: num(r.total_size) };
      } catch {
        return { s, oi: null };
      }
    })
  );
  for (const x of oi) {
    if (x.status === 'fulfilled' && map[x.value.s]) map[x.value.s].open_interest = x.value.oi;
  }
  return Object.values(map);
}

// 并行采集四家，单家失败不影响其他家
async function collectAll(watchlist) {
  const watch = new Set((watchlist || []).map(norm));
  const ts = Date.now();
  const results = await Promise.allSettled([
    collectBinance(watch),
    collectOkx(watch),
    collectBybit(watch),
    collectGate(watch),
  ]);
  const rows = [];
  results.forEach((r, i) => {
    const name = ['binance', 'okx', 'bybit', 'gate'][i];
    if (r.status === 'fulfilled') {
      for (const row of r.value) rows.push({ ts, ...row });
    } else {
      console.error(`[collect] ${name} failed:`, r.reason?.message || r.reason);
    }
  });
  return rows;
}

// ============================================================
// D1 写入 + 查询（本监控唯一存储后端）
// ============================================================

// 自动建表（首次写入/查询前调用，幂等）。D1 绑定后访问 /api/ingest 即自动初始化。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS market_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  exchange      TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  price         REAL,
  volume_24h    REAL,
  open_interest REAL,
  funding_rate  REAL,
  taker_buy_volume REAL,
  created_at    INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshot(ts);
CREATE INDEX IF NOT EXISTS idx_snap_ex_sym_ts ON market_snapshot(exchange, symbol, ts);
`;

async function ensureSchema(db) {
  await db.exec(SCHEMA_SQL);
}

const COLS = '(ts, exchange, symbol, price, volume_24h, open_interest, funding_rate, taker_buy_volume)';
const SQL = `INSERT INTO market_snapshot ${COLS} VALUES (?,?,?,?,?,?,?,?)`;

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
  const sql = `SELECT ts, exchange, symbol, price, volume_24h, open_interest, funding_rate FROM market_snapshot ${w} ORDER BY ts ASC LIMIT 5000`;

  const { results } = await db.prepare(sql).bind(...args).all();
  return { metric: params.metric, count: results.length, rows: results };
}

// ============================================================
// 面板（内联 HTML，单 Worker 直接托管，无需静态资源绑定）
// ============================================================
function serveDashboard() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>加密货币资金面监控面板</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262b36; --txt:#e6e9ef; --muted:#8b93a7; --accent:#4f9dff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:18px 22px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .sub { color:var(--muted); font-size:12px; }
  .wrap { padding:18px 22px; max-width:1180px; margin:0 auto; }
  .controls { display:flex; flex-wrap:wrap; gap:14px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; align-items:flex-end; }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label { font-size:12px; color:var(--muted); }
  select, input { background:#0c0e12; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
  .checks { display:flex; gap:12px; flex-wrap:wrap; }
  .checks label { display:flex; gap:6px; align-items:center; color:var(--txt); font-size:13px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:9px 18px; font-size:13px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:14px; }
  .stat { background:#0c0e12; border:1px solid var(--line); border-radius:10px; padding:12px; }
  .stat .k { color:var(--muted); font-size:12px; }
  .stat .v { font-size:18px; margin-top:4px; }
  .up { color:#26a69a; } .down { color:#ef5350; }
  table { width:100%; border-collapse:collapse; margin-top:14px; font-size:13px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  .hint { color:var(--muted); font-size:12px; margin-top:8px; }
  #status { color:var(--muted); font-size:12px; margin-top:10px; min-height:16px; }
</style>
</head>
<body>
<header>
  <h1>加密货币资金面监控面板</h1>
  <span class="sub">Binance · OKX · Bybit · Gate.io ｜ 数据存于 Cloudflare D1</span>
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
    <button id="run">查询</button>
  </div>
  <div id="status"></div>

  <div class="card">
    <canvas id="chart" height="120"></canvas>
    <div class="hint">折线展示所选币种在指定时间区间内、各交易所的指标走势；鼠标悬停看数值。</div>
  </div>

  <div class="card">
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
  const COLORS = { binance:'#f3ba2f', okx:'#4f9dff', bybit:'#ff7a45', gate:'#2bbf6a' };

  const symSel = document.getElementById('symbol');
  const metSel = document.getElementById('metric');
  METRICS.forEach(m => { const o=document.createElement('option'); o.value=m.key; o.textContent=m.label; metSel.appendChild(o); });
  const exBox = document.getElementById('exchecks');
  EXCHANGES.forEach(e => { const l=document.createElement('label'); l.innerHTML='<input type="checkbox" value="'+e+'" checked>'+e; exBox.appendChild(l); });

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
  const fmt = d => d.toISOString().slice(0,16);
  document.getElementById('to').value = fmt(now);
  document.getElementById('from').value = fmt(weekAgo);

  let chart;
  document.getElementById('run').addEventListener('click', run);

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
      data = await res.json();
    } catch(e) { status.textContent='请求失败：'+e.message; btn.disabled=false; return; }

    const rows = data.rows || [];
    status.textContent = '命中 '+rows.length+' 条（上限 5000，超出请缩窄区间）。'+(rows.length>=5000?' ⚠️ 已截断':'');
    drawChart(rows, exs, metric);
    drawStats(rows, exs, metric);
    btn.disabled = false;
  }

  function valOf(r, metric){ return r[metric]; }

  function drawChart(rows, exs, metric) {
    const byEx = {};
    exs.forEach(e => byEx[e] = []);
    rows.forEach(r => { if (byEx[r.exchange]) byEx[r.exchange].push({ x: r.ts, y: valOf(r, metric) }); });
    const datasets = exs.map(e => ({
      label: e,
      data: byEx[e],
      borderColor: COLORS[e] || '#999',
      backgroundColor: (COLORS[e] || '#999') + '33',
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
          x: { type:'linear', ticks:{ color:'#8b93a7', callback:v=>new Date(v).toLocaleString() }, grid:{ color:'#262b36' } },
          y: { ticks:{ color:'#8b93a7' }, grid:{ color:'#262b36' } }
        },
        plugins: { legend:{ labels:{ color:'#e6e9ef' } } }
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
      const pct = first ? ((last-first)/first*100) : 0;
      const cls = pct>=0 ? 'up' : 'down';
      const arrow = pct>=0 ? '▲' : '▼';
      const stat = document.createElement('div'); stat.className='stat';
      stat.innerHTML = '<div class="k">'+e+' ｜ '+metric+'</div><div class="v '+cls+'">'+arrow+' '+pct.toFixed(2)+'%</div>';
      statsEl.appendChild(stat);
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>'+e+'</td><td>'+fmtNum(first)+'</td><td>'+fmtNum(last)+'</td><td class="'+cls+'">'+arrow+' '+pct.toFixed(2)+'%</td><td>'+pts.length+'</td>';
      tbody.appendChild(tr);
    });
  }
  function fmtNum(n){ if(n==null) return '—'; if(Math.abs(n)>=1e6) return (n/1e6).toFixed(2)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(2)+'K'; return n.toFixed(n<1?6:2); }

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
  const rows = await collectAll(getWatchlist(env));
  const n = await insertSnapshots(env.DB, rows);
  console.log(`[ingest] collected=${rows.length} inserted=${n}`);
  return n;
}

function numOrNull(v) {
  return v && /^\d+$/.test(v) ? Number(v) : null;
}

async function handleQuery(request, env) {
  const url = new URL(request.url);
  const params = {
    from: numOrNull(url.searchParams.get('from')),
    to: numOrNull(url.searchParams.get('to')),
    exchange: (url.searchParams.get('exchange') || '').trim(),
    symbol: (url.searchParams.get('symbol') || '').trim().toUpperCase(),
    metric: url.searchParams.get('metric') || 'price',
  };
  const data = await querySnapshots(env.DB, params);
  return Response.json(data);
}

export default {
  async fetch(request, env, ctx) {
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
    if (path === '/api/ingest') {
      // 手动触发一次采集（初始化 D1 建表也走这里）。免费额度下也可用此代替 Cron。
      ctx.waitUntil(runIngest(env));
      return Response.json({ ok: true, msg: 'ingest scheduled' });
    }
    return serveDashboard();
  },

  // 定时采集（需在此 Worker 的 Dashboard → Triggers 手动添加 Cron 触发，例如 */15 * * * *）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env));
  },
};
