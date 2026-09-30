# 加密货币资金面监控面板（Cloudflare Workers + D1/KV）

在 Cloudflare 上部署一个**零成本**的加密货币监控：定时从 Binance / OKX / Bybit / Gate.io 公开 API 采集
价格、24h 成交量、合约持仓量(OI)、资金费率，存入 **D1 或 KV**（环境变量切换），并提供一个面板按**日期区间**查询走势与区间涨跌。

> 实现取舍：**代理指标（免费）** + **自定义观察池（环境变量配置）** + **严格免费额度**。
> "资金进出总量"用交易所自带的成交量/OI/资金费率作**代理指标**（非链上真·净流入/流出）。

## 架构

```
Cron(每15分钟) ──► Worker 并行 fetch 4 家 API ──► 归一化 ──► 按 STORAGE_TYPE 写 D1 / KV
                                                      │
浏览器 ──► / 面板 HTML ──► /api/query ──► 读 D1 / KV ──► Chart.js 折线 + 区间涨跌表
```

## 存储后端：D1 还是 KV？

| | D1（推荐） | KV |
|---|---|---|
| 免费写入额度 | **10 万行/天** | **仅 1000 次/天** |
| 区间查询 | SQL `WHERE ts BETWEEN` 原生支持 | 无 SQL，需 list 全扫+逐条 get，且最终一致 |
| 适配本场景 | ✅ 15 分钟×6币×4所≈2300 写/天，绰绰有余 | ❌ 直接超限，必须降到 ≥30 分钟且观察池≤10 |

**结论：用 D1。** KV 仅作为 `STORAGE_TYPE=kv` 时的兜底适配器存在，不建议用于本场景。

## 手动部署（Cloudflare，不走 CI）

```bash
# 0. 装 wrangler（需 Node 18+）
npm install

# 1. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 2. 建存储后端（选 D1）
npx wrangler d1 create crypto_monitor
#    把返回的 id 填进 wrangler.toml 的 database_id

# 3. 建表（仅 D1 需要）
npx wrangler d1 execute crypto_monitor --file=./schema.sql

# 4. （可选）配环境变量：编辑 wrangler.toml [vars]
#    STORAGE_TYPE = "d1"            # 或 "kv"
#    WATCHLIST = "BTCUSDT,ETHUSDT"  # 自定义观察池，留空用内置默认

# 5. 手动部署
npx wrangler deploy
```

部署后访问 `https://<你的子域>.workers.dev/` 用面板；Cron 每 15 分钟自动采集。
想立刻出数，访问一次 `https://<你的域名>/api/ingest` 手动触发采集。

> 环境变量也能在 **Cloudflare Dashboard → 你的 Worker → Settings → Variables** 里图形化添加，效果一样。
> 机密类配置（如未来接 CryptoQuant API Key）请用 **Secrets**（`npx wrangler secret put XXX`），不要写进 wrangler.toml。

## 作为 GitHub 项目使用

本目录即一个独立 Git 仓库结构。推到 GitHub：

```bash
git init
git add -A
git commit -m "feat: crypto-monitor Cloudflare Workers + D1/KV"
git remote add origin git@github.com:<你>/crypto-monitor.git
git push -u origin main
```

> 部署仍是**手动** `wrangler deploy`，不接 GitHub Actions / Pages CI（符合你的要求）。
> `.gitignore` 已忽略 `node_modules`、`.wrangler`、`.dev.vars`（密钥）等。

## 本地调试

```bash
# 校验四家端点可用、字段能解析（纯 Node，无需 Cloudflare）
node scripts/smoke.mjs

# 本地起 Worker（含 D1 本地库，需先 wrangler login）
npx wrangler dev
```

## 免费额度关键约束

- **Workers Free**：10 万请求/天；单次调用 CPU 仅 10ms（含 Cron）。采集是 I/O 密集，轻量观察池通常能塞进。若被掐，升 $5/月 Paid（Cron CPU 提到 30s）。
- **D1 Free**：单库 500MB、500 万行读/天、10 万行写/天。
- **Binance 地理封锁**：`api.binance.com` 对美区 IP 返回 451。Cloudflare 边缘多在非美区，常能通但不保证。代码已优雅降级：Binance 挂了只记另三家。稳定失败可在 `src/exchanges.js` 注释掉 `collectBinance()` 或换镜像源。

## 指标说明（代理指标）

| 指标 | 含义 | 用途 |
|---|---|---|
| price | 最新价 | 价格走势 |
| volume_24h | 24h 成交量 | 量能（各所口径不一，同所内可比） |
| open_interest | 合约持仓量 | 多空总敞口变化 |
| funding_rate | 资金费率 | 多空情绪（正=多头付费） |

> 想要**真正的交易所链上净流入/流出(Netflow)**，需接 CryptoQuant（$39/月起）或 Glassnode（$29/月起）API，
> 或自建链上追踪。已在 `src/exchanges.js` 留 `taker_buy_volume` 扩展位，后续可对接。

## 文件结构

```
crypto-monitor/
├─ wrangler.toml        # 绑定(D1/KV) + 环境变量[vars] + 15 分钟 Cron
├─ schema.sql           # D1 表结构（仅 D1 用）
├─ .gitignore
├─ LICENSE
├─ src/
│  ├─ index.js          # Worker 入口（fetch + 定时 + /api/config）
│  ├─ config.js         # 环境变量解析：STORAGE_TYPE / WATCHLIST
│  ├─ exchanges.js      # 四家采集 + 归一化
│  ├─ storage.js        # 按 STORAGE_TYPE 调度 D1 / KV
│  ├─ db.js             # D1 写入 + 区间查询
│  ├─ kv.js             # KV 适配器（兜底，不推荐）
│  └─ dashboard.js      # 查询 API + 内联面板
└─ scripts/smoke.mjs    # 本地端点校验
```
