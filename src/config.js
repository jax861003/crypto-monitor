// 运行期配置：全部来自 Cloudflare 部署时配置的 Variables（wrangler.toml [vars] 或 Dashboard）
import { WATCHLIST as DEFAULT_WATCHLIST } from './exchanges.js';

export const EXCHANGES = ['binance', 'okx', 'bybit', 'gate'];
export const METRICS = [
  { key: 'price', label: '价格' },
  { key: 'volume_24h', label: '24h 成交量' },
  { key: 'open_interest', label: '合约持仓量(OI)' },
  { key: 'funding_rate', label: '资金费率' },
];

// 观察池：优先用环境变量 WATCHLIST（逗号分隔，USDT 本位），否则用代码内置默认
export function getWatchlist(env) {
  const raw = env?.WATCHLIST;
  if (raw && typeof raw === 'string' && raw.trim()) {
    const list = raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.length) return list;
  }
  return DEFAULT_WATCHLIST;
}

// 存储后端：d1（默认，推荐）或 kv
export function getStorageType(env) {
  return (env?.STORAGE_TYPE || 'd1').toLowerCase() === 'kv' ? 'kv' : 'd1';
}
