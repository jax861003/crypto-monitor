# 加密货币资金面监控面板（Cloudflare Workers 单文件部署版）

定时从 **Binance / OKX / Bybit / Gate.io** 公开 API 采集价格、24h 成交量、合约持仓量(OI)、资金费率，
存入 **Cloudflare D1**，并提供一个面板按**日期区间**查询走势与区间涨跌，给你的交易做参考。

> 实现取舍：**代理指标（免费）** + 观察池用环境变量 `WATCHLIST` 配置（大小写不限）+ 存储仅用 D1
> + **部署方式 = 直接上传 `worker.js` 到 Cloudflare Dashboard（不依赖 GitHub，不依赖 wrangler CLI）**。

---

## 部署文件

- **`worker.js`** —— 唯一需要部署的文件。已把采集、入库、面板、Cron 逻辑全部内联，无外部依赖、无 npm 包、无 `wrangler.toml`。
  Cloudflare Dashboard 里新建 Worker，**把 `worker.js` 全部内容粘贴进去**即可。
- `schema.sql` —— 仅供参考（建表语句已在代码里 `ensureSchema` 自动执行，不用手动跑）。
- `src/` —— 拆分版的开发源码（可读性参考），**部署用不到**。

---

## 部署步骤（全程 Dashboard，不碰 GitHub / 命令行）

### 1. 建 D1 空库（Dashboard）
左侧菜单 **Storage & Databases → D1 SQL Database → Create**，名称填 `crypto_monitor`，创建完**不需要**手动建表（代码会自动建）。

### 2. 创建并上传 Worker（Dashboard）
1. **Workers & Pages → Create application → Create Worker**（不要选 Import repository）。
2. 删除默认模板代码，把本仓库 `worker.js` 的**全部内容**粘贴进编辑器。
3. 点 **Deploy**。此时页面能打开，但查询为空（还没绑库），属正常。

### 3. 绑定 D1 + 添加环境变量（Dashboard）
进该 Worker → **Settings**：
- **Bindings → Add → D1 database**
  - Variable name（变量名）：**`DB`**  ← 必须叫这个，代码里读的就是 `env.DB`
  - D1 database：选刚才建的 `crypto_monitor`
- **Variables and Secrets → Add variable**（Type 选 `Variable`，不是 Secret）
  - Name：`WATCHLIST`，Value：`BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT`（可选，不填用代码内置默认）

### 4. 添加定时采集（Cron，Dashboard 手动加）
进该 Worker → **Triggers → Add Cron Trigger**，Cron 表达式填 `*/15 * * * *`（每 15 分钟）。
> 上传文件部署不会自动带 Cron，必须在这里手动加；这也是「自动采集」的来源，与 GitHub 无关。

### 5. 重新部署一次 + 验证
- Settings 改完绑定/变量后，回 **Deployments → 重新部署一次** 让配置生效。
- 绑定 D1 后，访问一次 `https://<你的子域>.workers.dev/api/ingest` —— 会自动建表并开始写入。
- 打开根路径 `https://<你的子域>.workers.dev/` 就是面板；健康检查 `/api/health`。

---

## 代码里的占位符（改 `worker.js` 文件即可，或用 Dashboard 变量覆盖）

在 `worker.js` 顶部 **配置区**：

```js
const DEFAULT_WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
];
```

- 这是**代码内置默认占位观察池**。部署后在 Dashboard 加环境变量 `WATCHLIST` 即可覆盖，**无需改代码**。
- 大小写不限：`WATCHLIST = BTCUSDT,ethusdt,SOLUSDT` 里 `ethusdt` 会自动转成 `ETHUSDT`。
- 每新增一个币种，面板「币种」下拉框自动多出这一项。

---

## D1 自动初始化

`worker.js` 内含 `ensureSchema(db)`，在每次写入/查询前跑 `CREATE TABLE IF NOT EXISTS`，**幂等**。
因此绑完 D1 后无需手动执行 `schema.sql`——首次访问 `/api/ingest` 即自动建表并写入。

---

## 环境变量 / 绑定 速查表

| 名称 | 类型 | 在哪填 | 必填 | 说明 |
|---|---|---|---|---|
| `DB` | D1 绑定 | Worker Settings → Bindings → D1 database | **是** | 变量名必须 `DB`，对应代码 `env.DB`；绑定你的 `crypto_monitor` 库 |
| `WATCHLIST` | Variable | Worker Settings → Variables（或改 `worker.js` 顶部占位符） | 否 | 观察池，逗号分隔，大小写不限；留空=内置默认 6 币 |
| Cron `*/15 * * * *` | 触发器 | Worker Triggers → Add Cron Trigger | 否（建议） | 自动采集；不留则只能手动访问 `/api/ingest` |

> 注：上传文件部署**不会产生** Workers Builds 的 build token（那是 Git 集成的产物）。

---

## 免费额度关键约束

- **Workers Free**：10 万请求/天；单次调用 CPU 仅 10ms（含 Cron）。采集是 I/O 密集，轻量观察池通常能塞进。若被掐，升 **$5/月 Paid**（Cron CPU 提到 30s）。
- **D1 Free**：单库 500MB、500 万行读/天、10 万行写/天。
- **Binance 地理封锁**：`api.binance.com` 对美区 IP 返回 451。Cloudflare 边缘多在非美区，常能通但不保证。代码已优雅降级：Binance 挂了只记另三家。

---

## 指标说明（代理指标）

| 指标 | 含义 | 用途 |
|---|---|---|
| price | 最新价 | 价格走势 |
| volume_24h | 24h 成交量 | 量能 |
| open_interest | 合约持仓量 | 多空总敞口变化 |
| funding_rate | 资金费率 | 多空情绪（正=多头付费） |

> 想要真正的交易所链上净流入/流出(Netflow)，需接 CryptoQuant（$39/月起）或 Glassnode（$29/月起）API，或自建链上追踪。已在表结构留 `taker_buy_volume` 扩展列。

---

## 面板用法

- **币种**：= 你 `WATCHLIST` 里的每一项（自动生成）。
- **指标**：价格 / 24h 成交量 / 合约持仓量(OI) / 资金费率。
- **交易所**：四个复选框（Binance/OKX/Bybit/Gate），可多选叠加对比。
- **开始/结束时间**：选日期区间，点「查询」看折线 + 区间涨跌汇总表（首值/末值/涨跌幅）。
