import { EXCHANGES, METRICS } from './config.js';

// 面板（内联 HTML，单 Worker 直接托管，无需静态资源绑定）
// 观察池(WATCHLIST)由 /api/config 在运行时下发，避免与部署时环境变量脱节。
export function serveDashboard() {
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
