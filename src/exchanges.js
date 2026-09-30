// 四家交易所公开 REST API 采集 + 归一化
// 严格免费额度友好：价格/成交量/资金费率尽量走「一次 bulk 调用拿全部」，
// 持仓量(OI) 按观察池逐币补充（观察池小，请求数可控）。
//
// 观察池（WATCHLIST）可经环境变量在部署时覆盖，见 src/config.js。
// 仅支持 USDT 本位交易对，命名统一为 <币种>USDT，如 BTCUSDT、ETHUSDT。

// ⚠️ 这是「代码内置默认」观察池；部署时用环境变量 WATCHLIST 覆盖即可。
export const WATCHLIST = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
];

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

// ---------- Binance ----------
async function collectBinance(watch) {
  const spotBase = 'https://api.binance.com';
  const fBase = 'https://fapi.binance.com';
  // 注意：Binance 主站对美区 IP 返回 451（地理封锁）。Cloudflare 边缘多在非美区，
  // 实际常能通，但不保证。失败会被 collectAll 捕获并跳过，不影响其他三家。
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 并行采集四家，单家失败不影响其他家
// watchlist: string[]（如 ['BTCUSDT','ETHUSDT']）
export async function collectAll(watchlist) {
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
