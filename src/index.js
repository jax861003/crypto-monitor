import { collectAll } from './exchanges.js';
import { getWatchlist, EXCHANGES, METRICS } from './config.js';
import { insertSnapshots, querySnapshots } from './db.js';
import { serveDashboard } from './dashboard.js';

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
      // 手动触发一次采集（供调试 / 外部调度）。免费额度下也可用此代替 Cron。
      ctx.waitUntil(runIngest(env));
      return Response.json({ ok: true, msg: 'ingest scheduled' });
    }
    return serveDashboard();
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env));
  },
};

async function runIngest(env) {
  const rows = await collectAll(getWatchlist(env));
  const n = await insertSnapshots(env.DB, rows);
  console.log(`[ingest] collected=${rows.length} inserted=${n}`);
  return n;
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

function numOrNull(v) {
  return v && /^\d+$/.test(v) ? Number(v) : null;
}
