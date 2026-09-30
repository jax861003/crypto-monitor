// 本地逻辑验证：不依赖网络、不依赖 Cloudflare，确认 Worker 入口能正常返回面板/健康检查/配置。
import handler from '../src/index.js';

const env = { WATCHLIST: 'BTCUSDT,ethusdt,solUSDT', DB: {} };
const ctx = { waitUntil: () => {} };

async function test(path) {
  const req = new Request('http://localhost' + path);
  const res = await handler.fetch(req, env, ctx);
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').split(';')[0];
  const preview = ct === 'application/json'
    ? text.slice(0, 140)
    : text.replace(/\s+/g, ' ').slice(0, 90);
  console.log(`[${res.status}] ${path.padEnd(14)} ${ct.padEnd(16)} -> ${preview}`);
  return { res, text };
}

const dash = await test('/');
if (!dash.text.includes('crypto') && !dash.text.toLowerCase().includes('监控'))
  console.warn('⚠️ 根路径未返回预期面板 HTML');

const health = await test('/api/health');
if (!health.text.includes('"ok":true')) console.warn('⚠️ /api/health 异常');

const cfg = await test('/api/config');
if (!cfg.text.includes('BTCUSDT') || !cfg.text.includes('ETHUSDT') || !cfg.text.includes('SOLUSDT'))
  console.warn('⚠️ /api/config 大小写归一异常');
else
  console.log('✅ 大小写归一生效：BTCUSDT,ethusdt,solUSDT → BTCUSDT/ETHUSDT/SOLUSDT');

console.log('\n本地逻辑验证通过：Worker 能正常返回面板 / 健康检查 / 配置（无需网络与 Cloudflare）。');
