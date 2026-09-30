// 运行期配置：全部来自 Cloudflare 部署时配置的 Variables（wrangler.toml [vars] 或 Dashboard）
import { WATCHLIST as DEFAULT_WATCHLIST } from './exchanges.js';

export const EXCHANGES = ['binance', 'okx', 'bybit', 'gate'];
export const METRICS = [
  { key: 'price', label: '价格' },
  { key: 'volume_24h', label: '24h 成交量' },
  { key: 'open_interest', label: '合约持仓量(OI)' },
  { key: 'funding_rate', label: '资金费率' },
];

// 观察池：优先用环境变量 WATCHLIST（逗号分隔，USDT 本位，大小写不限），
// 否则用代码内置默认。例如 WATCHLIST="BTCUSDT,ethusdt,SOLUSDT" —— ethusdt 会自动转成 ETHUSDT。
// 每新增一个币种，面板「币种」下拉框会自动多出这一项，无需改任何代码。
export function getWatchlist(env) {
  const raw = env?.WATCHLIST;
  if (raw && typeof raw === 'string' && raw.trim()) {
    const list = raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  return DEFAULT_WATCHLIST;
}
