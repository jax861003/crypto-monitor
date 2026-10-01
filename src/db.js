// D1 写入 + 查询（本监控唯一存储后端）
import { EXCHANGES } from './config.js';

// 自动建表（首次写入/查询前调用，幂等）。这样 Dashboard 绑完 D1 后，
// 访问 /api/ingest 就会自动建表，无需手动在 D1 Console 执行 schema.sql。
// 注意：不用 db.exec(多语句)——D1 的 exec 会把多行 SQL 切碎导致 "incomplete input"。
// 改用 prepare().run() 逐条执行，并用 WeakSet 缓存已初始化的 D1 实例。
const STMT_TABLE = `CREATE TABLE IF NOT EXISTS market_snapshot (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  exchange         TEXT    NOT NULL,
  symbol           TEXT    NOT NULL,
  price            REAL,
  volume_24h       REAL,
  open_interest    REAL,
  funding_rate     REAL,
  taker_buy_volume REAL,
  created_at       INTEGER DEFAULT (strftime('%s','now'))
)`;
const STMT_IDX_1 = `CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshot(ts)`;
const STMT_IDX_2 = `CREATE INDEX IF NOT EXISTS idx_snap_ex_sym_ts ON market_snapshot(exchange, symbol, ts)`;

const schemaReadySet = new WeakSet();
export async function ensureSchema(db) {
  if (schemaReadySet.has(db)) return;
  await db.prepare(STMT_TABLE).run();
  await db.prepare(STMT_IDX_1).run();
  await db.prepare(STMT_IDX_2).run();
  schemaReadySet.add(db);
}

const COLS = '(ts, exchange, symbol, price, volume_24h, open_interest, funding_rate, taker_buy_volume)';
const SQL = `INSERT INTO market_snapshot ${COLS} VALUES (?,?,?,?,?,?,?,?)`;

// 批量写入，自动按 100 条切分（D1 batch 单次上限 100 条语句）
export async function insertSnapshots(db, rows) {
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
export async function querySnapshots(db, params) {
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
