import { EXCHANGES, METRICS } from './config.js';

// 面板（内联 HTML，单 Worker 直接托管，无需静态资源绑定）
// 观察池(WATCHLIST)由 /api/config 在运行时下发，避免与部署时环境变量脱节。
// 版式按 1920×1080 主屏优化：1680px 宽幅 + 大字号 + 大图区；支持黑夜/白天主题切换（记忆偏好）
export function serveDashboard() {
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
