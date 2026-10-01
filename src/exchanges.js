// 四家→三家交易所公开 REST API 采集 + 归一化
// 数据源：OKX / Bybit / Gate.io（Binance 已按需求移除——它对 Cloudflare 边缘 IP 地理封锁不友好）。
// 采集策略：OKX/Gate 用 bulk 接口（响应适中），Bybit 按观察池逐个小请求；
// 免费版 Worker 单次 CPU 仅 10ms，拉全市场大 JSON 光解析就会超限被静默掐死。
// 7 币 ≈ 37 个子请求，在免费版 50 子请求上限内。
// 观察池（WATCHLIST）可经环境变量在部署时覆盖，见 src/config.js。
// 仅支持 USDT 本位交易对，命名统一为 <币种>USDT，如 BTCUSDT、ETHUSDT。

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
    map[sym] = {
      exchange: 'okx',
      symbol: sym,
      price: num(t.last),
      high_24h: num(t.high24h),
      low_24h: num(t.low24h),
      change_pct: pctChange(num(t.last), num(t.open24h)),
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

// 归一化交易对名：去分隔符、大写。BTC-USDT / BTC_USDT / BTCUSDT → BTCUSDT
function norm(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 并行采集三家，单家失败不影响其他家；返回 { rows, detail }（detail 供排障）
export const EXCHANGE_FNS = [
  ['okx', collectOkx],
  ['bybit', collectBybit],
  ['gate', collectGate],
];

export async function collectAll(watchlist) {
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
