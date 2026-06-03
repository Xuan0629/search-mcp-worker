# search-mcp-worker

> A self-hosted MCP (Model Context Protocol) search aggregation service running on Cloudflare Workers.
> [English](#features) | [中文](#功能概览)

一个部署在 Cloudflare Workers 上的 MCP 搜索聚合服务，提供 24 个搜索/获取工具，通过标准 MCP 协议（JSON-RPC 2.0）对外暴露，可被任何 MCP 客户端直接接入。

**特点：免费、自托管、智能路由、中文优先。**

---

## ⚡ 30 秒接入（无需部署）

本项目提供了一个公开的 MCP 端点，你可以直接将其接入你的 AI 客户端，无需自己部署任何东西：

```
https://search-mcp-worker.sean010629.workers.dev/mcp
```

### Claude Desktop / Cursor / Windsurf / VS Code

在你的 MCP 客户端配置文件中添加：

```json
{
  "mcpServers": {
    "search": {
      "url": "https://search-mcp-worker.sean010629.workers.dev/mcp"
    }
  }
}
```

### Hermes Agent

```bash
hermes mcp add search --url "https://search-mcp-worker.sean010629.workers.dev/mcp"
```

### 其他 MCP 客户端

任何支持 Streamable HTTP transport 的 MCP 客户端均可接入，将 MCP server URL 设为：

```
https://search-mcp-worker.sean010629.workers.dev/mcp
```

### curl 测试

```bash
# 初始化连接
curl -X POST https://search-mcp-worker.sean010629.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# 智能搜索（自动检测语言和意图）
curl -X POST https://search-mcp-worker.sean010629.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Rust async runtime","limit":3}}}'
```

> **公开实例说明：** 免费搜索引擎（DuckDuckGo/Bing/Baidu/arXiv/GitHub 等 19 个）均可直接使用。Bocha 引擎需要 API Key，公开实例已内置，但额度有限。如果你需要更高的 Bocha 配额或有数据隐私顾虑，建议[自行部署](#快速开始自托管)。

---

## 功能概览

| 分类 | 引擎 | 说明 |
|------|------|------|
| **智能搜索** | `search` | 自动检测语言和意图，选择最优引擎组合 |
| **中文搜索** | Bocha、百度、搜狗、Bing CN | Bocha API 返回 AI 摘要；其他通过 HTML 抓取 |
| **英文搜索** | DuckDuckGo、Bing、Google(占位) | HTML 抓取，完全免费 |
| **学术搜索** | arXiv、PubMed、CrossRef | 覆盖论文/预印本/生物医学/DOI 元数据 |
| **开发者搜索** | GitHub、StackExchange、npm、PyPI、crates.io、Hacker News | 包/仓库/问答/社区 |
| **参考知识** | Wikipedia、Wikidata、DDG Instant Answer | 百科/实体/即时答案 |
| **内容获取** | fetch_url、fetch_github_file、find_rss | 抓取网页内容、GitHub 文件、发现 RSS |

### 智能路由

`search` 工具会自动分析查询内容：

```
"Rust 异步运行时对比"    → 中文 + 开发者意图 → Bocha → GitHub → StackExchange → 百度
"transformer attention"  → 英文 + 学术意图   → arXiv → PubMed → CrossRef → DuckDuckGo
"今天北京天气"           → 中文 + 新闻意图   → Bocha → 百度 → Bing CN
"what is MCP"            → 英文 + 参考意图   → Wikipedia → DDG Instant Answer → DuckDuckGo
```

### 结果质量处理

- **去重**：跨引擎 URL 标准化合并
- **评分**：质量权重 + 排名衰减 + 多源加成 + Token 匹配 + 官方域名加成
- **过滤**：通用噪音检测、意图不匹配检测、低信任域名检测
- **缓存**：5 分钟 LRU 缓存（200 条）

---

## 24 个 MCP 工具

### 智能搜索

| 工具 | 说明 |
|------|------|
| `search` | 自动路由搜索——检测语言和意图，选择最优引擎。支持 `quick`/`full` 模式 |

### 通用搜索

| 工具 | 说明 |
|------|------|
| `search_duckduckgo` | DuckDuckGo 搜索（HTML 抓取，免费，3 条 fallback 路径） |
| `search_bing` | Bing 搜索（HTML 抓取，免费） |
| `search_bing_cn` | Bing 中国搜索（中文结果） |
| `search_google` | Google 搜索（占位，高频触发 CAPTCHA，建议用其他引擎） |

### 中文搜索

| 工具 | 说明 |
|------|------|
| `search_bocha` | Bocha 搜索 API（高质量中文/英文搜索，返回 AI 摘要，需 API Key） |
| `search_bocha_ai` | Bocha AI 搜索（返回搜索结果 + AI 生成的答案，需 API Key） |
| `search_baidu` | 百度搜索（JSON API + HTML fallback） |
| `search_sogou` | 搜狗搜索（HTML 抓取） |

### 学术搜索

| 工具 | 说明 |
|------|------|
| `search_arxiv` | arXiv 预印本（物理/数学/计算机/AI-ML） |
| `search_pubmed` | PubMed（生物医学和生命科学文献） |
| `search_crossref` | CrossRef（学术论文和 DOI 元数据） |

### 开发者搜索

| 工具 | 说明 |
|------|------|
| `search_github` | GitHub 仓库搜索（按 star 排序） |
| `search_stackexchange` | StackExchange 站点搜索（支持 StackOverflow/ServerFault 等） |
| `search_npm` | npm 包搜索 |
| `search_pypi` | PyPI Python 包搜索 |
| `search_crates` | crates.io Rust 包搜索 |
| `search_hackernews` | Hacker News 故事搜索 |

### 参考工具

| 工具 | 说明 |
|------|------|
| `search_wikipedia` | Wikipedia 搜索（支持中/英文） |
| `search_wikidata` | Wikidata 实体搜索 |
| `instant_answer` | DuckDuckGo 即时答案（定义/事实/消歧） |

### 内容获取

| 工具 | 说明 |
|------|------|
| `fetch_url` | 抓取 URL 内容，HTML 转 plain text（最大 30000 字符） |
| `fetch_github_file` | 获取 GitHub 仓库中的文件内容（通过 raw.githubusercontent.com） |
| `find_rss` | 从网页中发现 RSS/Atom 订阅源 |

---

## 快速开始（自托管）

> 如果你只想**使用**本服务，无需阅读以下内容——直接看上面的 [⚡ 30 秒接入](#-30-秒接入无需部署) 即可。以下内容面向想要**自己部署**的用户。

### 前置条件

- [Node.js](https://nodejs.org/) >= 22
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- [Cloudflare 账号](https://dash.cloudflare.com/)（免费计划即可）

### 1. 克隆项目

```bash
git clone https://github.com/Xuan0629/search-mcp-worker.git
cd search-mcp-worker
```

### 2. 安装依赖

```bash
npm install
```

> **注意：** Node 24 + npm 11 存在已知的不解包 bug。如果 `npm install` 后 `node_modules` 为空，请使用 Node 22 LTS，或手动解包：
> ```bash
> cd /tmp && npm pack typescript hono @cloudflare/workers-types
> cd /path/to/search-mcp-worker
> mkdir -p node_modules/typescript node_modules/hono node_modules/@cloudflare/workers-types
> tar xzf /tmp/typescript-*.tgz -C node_modules/typescript --strip-components=1
> tar xzf /tmp/hono-*.tgz -C node_modules/hono --strip-components=1
> tar xzf /tmp/cloudflare-workers-types-*.tgz -C node_modules/@cloudflare/workers-types --strip-components=1
> ```

### 3. 登录 Cloudflare

```bash
wrangler login
```

### 4. 配置 Bocha API Key（可选但推荐）

[Bocha](https://bocha.io) 提供高质量的中文/英文搜索 API，是中文查询的主力引擎。

```bash
wrangler secret put BOCHA_API_KEY
# 输入你的 Bocha API Key
```

> 不配置 Bocha 也可以使用，智能路由会自动跳过 Bocha，使用其他免费引擎。

### 5. 本地开发

```bash
npm run dev
# Worker 运行在 http://localhost:8789
```

### 6. 部署

```bash
npm run deploy
```

部署后会得到一个 `*.workers.dev` 域名，例如：
```
https://search-mcp-worker.<your-subdomain>.workers.dev
```

---

## MCP 协议

### 端点

```
POST https://search-mcp-worker.<your-subdomain>.workers.dev/mcp
Content-Type: application/json
```

### 协议版本

- MCP: `2025-03-26`
- JSON-RPC: `2.0`

### 支持的方法

| 方法 | 说明 |
|------|------|
| `initialize` | 初始化连接，返回协议版本和服务器信息 |
| `notifications/initialized` | 客户端确认初始化 |
| `ping` | 心跳检测 |
| `tools/list` | 列出所有可用工具及其参数 schema |
| `tools/call` | 调用指定工具 |

### 示例：初始化

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

响应：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "search-mcp-worker", "version": "0.1.0" }
  }
}
```

### 示例：智能搜索

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "Rust 异步运行时对比",
      "limit": 5,
      "auto_mode": "quick"
    }
  }
}
```

响应：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{
      "type": "text",
      "text": "## Search Results\n\nQuery: \"Rust 异步运行时对比\" | Intent: developer | Lang: zh | Engines: bocha, github, stackexchange\n\n1. **Tokio** ..."
    }],
    "structuredContent": { "results": [...], "query": "...", "engines": [...], "cached": false }
  }
}
```

### 示例：获取网页内容

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "fetch_url",
    "arguments": {
      "url": "https://example.com",
      "maxChars": 5000
    }
  }
}
```

---

## 接入 MCP 客户端（自托管实例）

> 公开实例的接入方式见上方 [⚡ 30 秒接入](#-30-秒接入无需部署)。以下为你**自己部署后**的接入方式——将 URL 替换为你的 `*.workers.dev` 域名。

### Claude Desktop / Cursor / Windsurf

在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "search": {
      "url": "https://search-mcp-worker.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

### Hermes Agent

```bash
hermes mcp add search --url "https://search-mcp-worker.<your-subdomain>.workers.dev/mcp"
```

或手动添加到 `~/.hermes/config.yaml`：

```yaml
mcp_servers:
  search:
    url: "https://search-mcp-worker.<your-subdomain>.workers.dev/mcp"
    timeout: 120
```

### OpenClaw / 其他支持 MCP 的客户端

任何支持 Streamable HTTP transport 的 MCP 客户端均可接入，将 URL 指向：

```
https://search-mcp-worker.<your-subdomain>.workers.dev/mcp
```

---

## 工具参数说明

### 通用搜索参数

所有搜索工具共享以下基础参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | ✅ | — | 搜索查询（支持自然语言、中英文） |
| `limit` | number | ❌ | 5 | 最大结果数（1-10） |

### `search`（智能搜索）额外参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `engines` | string[] | 自动选择 | 手动指定引擎列表，覆盖自动路由 |
| `auto_mode` | string | `"quick"` | `"quick"` = 首个引擎返回结果即停；`"full"` = 尝试所有引擎以获得最全面结果 |

### 特定工具参数

| 工具 | 额外参数 | 说明 |
|------|----------|------|
| `search_duckduckgo` | `region` | 区域代码（如 `us-en`, `wt-wt`） |
| `search_stackexchange` | `site` | StackExchange 站点（默认 `stackoverflow`） |
| `search_wikipedia` | `language` | 语言代码（默认 `en`） |
| `fetch_url` | `maxChars` | 最大字符数（1000-30000，默认 12000） |
| `fetch_github_file` | `owner`, `repo`, `path`, `ref`, `maxChars` | GitHub 仓库文件（`ref` 默认 `main`） |
| `find_rss` | `url` | 要发现 RSS 的页面 URL |

---

## 架构

```
src/
├── index.ts              # 入口：Hono app、路由、工具注册
├── types.ts              # TypeScript 类型定义
├── constants.ts          # 常量：引擎注册表、评分权重、UA 池
├── cache.ts              # LRU 缓存
├── router.ts             # 智能路由：语言检测 + 意图分类 + 引擎选择
├── scorer.ts             # 结果处理：去重 + 质量评估 + 评分 + 排序
├── mcp/
│   └── protocol.ts       # MCP 协议层：JSON-RPC 处理 + 工具 schema
└── engines/
    ├── bocha.ts          # Bocha API（web-search + ai-search）
    ├── duckduckgo.ts     # DuckDuckGo（3 条 fallback 路径）
    ├── bing.ts           # Bing + Bing CN
    ├── baidu.ts          # 百度（JSON API + HTML fallback）
    ├── sogou.ts          # 搜狗
    ├── google.ts         # Google（占位，高频 CAPTCHA）
    ├── academic.ts       # arXiv + PubMed + CrossRef
    ├── developer.ts      # GitHub + StackExchange + npm + PyPI + crates.io + HN
    ├── reference.ts      # Wikipedia + Wikidata + DDG Instant Answer
    └── fetch.ts          # fetch_url + fetch_github_file + find_rss
```

### 智能路由流程

```
用户查询
  │
  ├─ 语言检测（CJK 字符 → zh，否则 → en）
  ├─ 意图分类（关键词匹配：academic/developer/news/reference/general）
  │
  └─ 路由表查找 → 引擎优先级列表
       │
       ├─ quick 模式：依次尝试，首个成功即返回
       └─ full 模式：尝试所有引擎，合并去重排序后返回
```

---

## 搜索源费用

| 类型 | 引擎 | 费用 |
|------|------|------|
| **HTML 抓取** | DuckDuckGo, Bing, Bing CN, Baidu, Sogou, Google | 免费（Google 高频被拦） |
| **公开 API** | arXiv, PubMed, CrossRef, GitHub, StackExchange, npm, PyPI, crates.io, Hacker News, Wikipedia, Wikidata, DDG Instant Answer | 免费（有速率限制） |
| **需 API Key** | Bocha | 免费额度有限，超出付费 |

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `BOCHA_API_KEY` | 否 | Bocha 搜索 API Key。不配置时 Bocha 引擎不可用，其他引擎正常工作 |

设置方式：

```bash
# 生产环境（Cloudflare Workers Secrets）
wrangler secret put BOCHA_API_KEY

# 本地开发（.dev.vars 文件）
echo "BOCHA_API_KEY=your-key-here" > .dev.vars
```

---

## 自定义

### 修改路由优先级

编辑 `src/router.ts` 中的 `ROUTING_TABLE`：

```typescript
const ROUTING_TABLE: Record<Intent, Record<Language, string[]>> = {
  general: {
    zh: ['bocha', 'baidu', 'bing_cn', 'sogou', 'duckduckgo', 'bing'],
    en: ['duckduckgo', 'bing', 'bocha', 'google'],
    // ...
  },
  // ...
};
```

### 添加新搜索引擎

1. 在 `src/engines/` 下创建新文件，实现搜索函数：

```typescript
import type { SearchResult } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';

export async function searchMyEngine(
  query: string, limit: number, timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  // 实现搜索逻辑
  return results;
}
```

2. 在 `src/constants.ts` 的 `ENGINE_REGISTRY` 中注册
3. 在 `src/mcp/protocol.ts` 的 `getToolList()` 中添加工具定义
4. 在 `src/index.ts` 的 `executeEngine()` 和 `toolHandlers` 中添加调度

### 绑定自定义域名

在 `wrangler.toml` 中添加：

```toml
[[routes]]
pattern = "search.yourdomain.com/*"
zone_name = "yourdomain.com"
```

---

## 开发命令

```bash
npm run dev          # 本地开发服务器 (http://localhost:8789)
npm run deploy       # 部署到 Cloudflare Workers
npm run typecheck    # TypeScript 类型检查
npm run test         # 运行测试
```

---

## 致谢

灵感来源于 [Kerry1020/search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker)。本项目从零重写，聚焦于：

- TypeScript 类型安全
- 模块化架构（每引擎一个文件）
- 智能路由系统（语言 + 意图自动检测）
- 可维护性和可扩展性

## License

MIT
