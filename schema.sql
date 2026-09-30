-- crypto_monitor D1 schema
-- 执行：wrangler d1 execute crypto_monitor --file=./schema.sql

CREATE TABLE IF NOT EXISTS market_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,             -- 采集时间戳（epoch ms）
  exchange      TEXT    NOT NULL,             -- binance / okx / bybit / gate
  symbol        TEXT    NOT NULL,             -- 归一化，如 BTCUSDT
  price         REAL,                         -- 最新价
  volume_24h    REAL,                         -- 24h 成交量（各交易所口径不一，同交易所内可比）
  open_interest REAL,                         -- 合约持仓量（USDT 永续）
  funding_rate  REAL,                         -- 资金费率
  taker_buy_volume REAL,                      -- 主动买入量（代理指标，暂留空，可后续扩展）
  created_at    INTEGER DEFAULT (strftime('%s','now'))
);

-- 按时间范围查询
CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshot(ts);
-- 按 交易所+币种+时间 查询（面板主路径）
CREATE INDEX IF NOT EXISTS idx_snap_ex_sym_ts ON market_snapshot(exchange, symbol, ts);
