// KV 存储适配器（不推荐，仅作为 STORAGE_TYPE=kv 时的兜底）
//
// ⚠️ 重要限制（务必读 README）：
// 1. Cloudflare KV 免费额度仅 1000 次写入/天。本采集每条记录一次写入，
//    15 分钟粒度下会远超限额——必须把采集频率降到 ≥30 分钟且观察池≤约 10 币，或付费。
// 2. KV 无 SQL，区间查询靠 list 全量扫描 + 逐条 get，且为最终一致（刚写入可能查不到）。
// 因此日期区间查询体验远差于 D1。能用 D1 就用 D1。

const PREFIX = 'snap:';

export async function insertKV(env, rows) {
  if (!env.KV) throw new Error('KV 绑定未配置（wrangler.toml 中取消 [[kv_namespaces]] 注释并填 id）');
  // 批量写入（KV put 单次一个 key）
  await Promise.all(
    rows.map((r) =>
      env.KV.put(`${PREFIX}${r.ts}:${r.exchange}:${r.symbol}`, JSON.stringify(r))
    )
  );
  return rows.length;
}

export async function queryKV(env, params) {
  const out = [];
  let cursor;
  // 分页列出所有 key（KV list 单次最多 1000）
  do {
    const opts = { prefix: PREFIX };
    if (cursor) opts.cursor = cursor;
    const res = await env.KV.list(opts);
    for (const { name } of res.keys) {
      const [, ts, ex, sym] = name.split(':');
      const t = Number(ts);
      if (params.from != null && t < params.from) continue;
      if (params.to != null && t > params.to) continue;
      if (params.exchange && ex !== params.exchange) continue;
      if (params.symbol && sym !== params.symbol) continue;
      const v = await env.KV.get(name);
      if (v) out.push(JSON.parse(v));
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  out.sort((a, b) => a.ts - b.ts);
  return { metric: params.metric, count: out.length, rows: out.slice(0, 5000) };
}
