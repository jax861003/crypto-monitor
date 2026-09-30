// D1 写入 + 查询
import { EXCHANGES } from './config.js';

const COLS = '(ts, exchange, symbol, price, volume_24h, open_interest, funding_rate, taker_buy_volume)';
const SQL = `INSERT INTO market_snapshot ${COLS} VALUES (?,?,?,?,?,?,?,?)`;

// 批量写入，自动按 100 条切分（D1 batch 单次上限 100 条语句）
export async function insertSnapshots(db, rows) {
  if (!rows.length) return 0;
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
export async function queryD1(db, params) {
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
