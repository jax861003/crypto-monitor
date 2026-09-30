# 加密货币资金面监控面板（Cloudflare Workers + D1）

在 Cloudflare 上部署一个**零成本**的加密货币监控：定时从 **Binance / OKX / Bybit / Gate.io** 公开 API 采集
价格、24h 成交量、合约持仓量(OI)、资金费率，存入 **Cloudflare D1**，并提供一个面板按**日期区间**查询走势与区间涨跌，给你的交易做参考。

> 实现取舍：**代理指标（免费）** + **观察池用环境变量 `WATCHLIST` 配置** + **存储仅用 D1**。
> "资金进出总量"用交易所自带的成交量 / OI / 资金费率作**代理指标**（非链上真·净流入/流出，详见文末）。

## 架构

```
Cron(每15分钟) ──► Worker 并行 fetch 4 家 API ──► 归一化 ──► 写入 D1(crypto_monitor)
                                                      │
浏览器 ──► / 面板 HTML ──► /api/query ──► 读 D1 ──► Chart.js 折线 + 区间涨跌表
```

## 存储后端：只用 D1

本项目**只用 D1**（KV 方案已移除，免费 KV 仅 1000 次写/天，远低于采集需求）。D1 免费额度：
单库 500MB、500 万行读/天、**10 万行写/天**——15 分钟 × N 币 × 4 所下完全够用。

## 观察池怎么加币种

只需在部署的环境变量 `WATCHLIST` 里加。**每加一个币种，面板「币种」下拉框自动多出一项，不用动任何代码。**

- 命名：`USDT` 本位，逗号分隔，**大小写不限**。
- 例：`BTCUSDT,ethusdt,SOLUSDT` → 自动归一为 `BTCUSDT / ETHUSDT / SOLUSDT`。
- 留空：用代码内置默认（BTC/ETH/SOL/BNB/XRP/DOGE）。

---

## 一、Cloudflare 手动部署详细步骤

> 全程手动 `wrangler deploy`，不接 CI/CD。需要本机有 Node 18+。

### 步骤 1：安装 wrangler 并登录

```bash
cd crypto-monitor
npm install                # 装 wrangler 等依赖
npx wrangler login         # 浏览器授权登录 Cloudflare（选你的账号）
```

### 步骤 2：创建 D1 数据库

```bash
npx wrangler d1 create crypto_monitor
```

终端会返回一段 JSON，**记住里面的 `"id"`**（一长串 uuid），下一步要用。
例：`{ "name": "crypto_monitor", "id": "1a2b3c4d-....", "created": true }`

### 步骤 3：把 D1 的 id 填进 `wrangler.toml`

打开 `wrangler.toml`，把这一行替换掉：

```toml
database_id = "REPLACE_WITH_YOUR_D1_ID"
```

改成你拿到的 id：

```toml
database_id = "1a2b3c4d-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 步骤 4：建表（执行 schema.sql）

```bash
npx wrangler d1 execute crypto_monitor --file=./schema.sql
```

### 步骤 5：配置环境变量（关键）

环境变量有两种填法，**二选一**：

**方式 A —— 写在 `wrangler.toml` 的 `[vars]` 里（推荐，跟着仓库走）：**

```toml
[vars]
# 观察池：逗号分隔，大小写不限。新增即看板新增一项。留空用内置默认。
WATCHLIST = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT"
```

**方式 B —— 在 Cloudflare Dashboard 图形化添加：**
Worker 详情 → **Settings → Variables and Secrets → Add variable**（Type 选 `Variable`，不是 Secret），
按下面表格填 Name / Value，保存后**重新 `wrangler deploy` 一次**生效。

#### 环境变量名 / 值对照表

| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---|---|---|---|---|
| `WATCHLIST` | Variable（非机密） | 否 | `BTCUSDT,ETHUSDT,SOLUSDT` | 观察池，USDT 本位，逗号分隔，**大小写不限**。留空=用内置默认 6 币。每加一个，面板自动多一项。 |
| （无更多必填变量） | — | — | — | 存储绑定 `DB` 在 `wrangler.toml` 里已配，无需变量。 |

> 当前版本**只有 `WATCHLIST` 一个可选环境变量**，没有别的需要填。
> 机密类配置（如未来接 CryptoQuant API Key）请用 **Secret**（`npx wrangler secret put XXX`），别写进 `wrangler.toml`。

### 步骤 6：部署上 Cloudflare

```bash
npx wrangler deploy
```

部署成功会返回你的访问地址：`https://crypto-monitor.<你的子域>.workers.dev`

### 步骤 7：手动触发首次采集（可选，立刻出数）

Cron 每 15 分钟跑一次，想马上看到数据，浏览器访问一次：

```
https://crypto-monitor.<你的子域>.workers.dev/api/ingest
```

返回 `{"ok":true,...}` 即已把这次采集提交到后台。几秒后再打开根路径 `https://...workers.dev/` 就能在面板里查到了。

---

## 面板用法

打开 `https://<你的子域>.workers.dev/`（根路径就是面板）：

- **币种**：下拉框 = 你 `WATCHLIST` 里的每一项（自动生成）。
- **指标**：价格 / 24h 成交量 / 合约持仓量(OI) / 资金费率。
- **交易所**：四个复选框（Binance/OKX/Bybit/Gate），可多选叠加对比。
- **开始/结束时间**：选日期区间，点「查询」看折线 + 区间涨跌汇总表（首值/末值/涨跌幅）。

---

## 二、作为 GitHub 项目

本目录即独立 Git 仓库。推到你自己的 GitHub（`jax861003/crypto-monitor`）：

```bash
git add -A
git commit -m "feat: crypto-monitor D1-only"
git remote add origin git@github.com:jax861003/crypto-monitor.git
git push -u origin main
```

> 部署仍是**手动** `wrangler deploy`，不接 GitHub Actions（符合需求）。
> `.gitignore` 已忽略 `node_modules`、`.wrangler`、`.dev.vars`（密钥）等。

---

## 三、本地调试

```bash
# 校验四家端点可用、字段能解析（纯 Node，无需 Cloudflare）
node scripts/smoke.mjs

# 本地起 Worker（含 D1 本地库，需先 wrangler login）
npx wrangler dev
```

---

## 四、免费额度关键约束

- **Workers Free**：10 万请求/天；单次调用 CPU 仅 10ms（含 Cron）。采集是 I/O 密集，轻量观察池通常能塞进。若被掐，升 **$5/月 Paid**（Cron CPU 提到 30s）。
- **D1 Free**：单库 500MB、500 万行读/天、10 万行写/天。
- **Binance 地理封锁**：`api.binance.com` 对美区 IP 返回 451。Cloudflare 边缘多在非美区，常能通但不保证。代码已优雅降级：Binance 挂了只记另三家。稳定失败可在 `src/exchanges.js` 注释掉 `collectBinance()` 或换镜像源。

---

## 五、指标说明（代理指标）

| 指标 | 含义 | 用途 |
|---|---|---|
| price | 最新价 | 价格走势 |
| volume_24h | 24h 成交量 | 量能（各所口径不一，同所内可比） |
| open_interest | 合约持仓量 | 多空总敞口变化 |
| funding_rate | 资金费率 | 多空情绪（正=多头付费） |

> 想要**真正的交易所链上净流入/流出(Netflow)**，需接 CryptoQuant（$39/月起）或 Glassnode（$29/月起）API，
> 或自建链上追踪。已在 `src/db.js` 留 `taker_buy_volume` 扩展列，后续可对接更细的买卖压力指标。

---

## 六、文件结构

```
crypto-monitor/
├─ wrangler.toml        # D1 绑定 + 环境变量[vars] + 15 分钟 Cron
├─ schema.sql           # D1 表结构
├─ .gitignore
├─ LICENSE
├─ src/
│  ├─ index.js          # Worker 入口（fetch + 定时 + /api/config）
│  ├─ config.js         # 环境变量解析：观察池 WATCHLIST
│  ├─ exchanges.js      # 四家采集 + 归一化
│  ├─ db.js             # D1 写入 + 区间查询
│  └─ dashboard.js      # 查询 API + 内联面板
└─ scripts/smoke.mjs    # 本地端点校验
```
