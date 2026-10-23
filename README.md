# RTCWeb2Lan

**在浏览器里直接访问内网 Web 服务：内网应用零改造、地址栏 URL 全程不变、稳态流量 P2P 直连不过公网。**

许多服务（内部管理后台、运维面板、审计/财务系统……）只允许在内网访问。常见做法是 VPN 或反向代理：

- **VPN**：要装客户端、改路由表，对非技术用户不友好；
- **反向代理**：把全部流量压到公网服务器，且往往要改地址或改应用。

RTCWeb2Lan 用另一条路：

1. 浏览器注册一个 **Service Worker**，在用户看不见的层面把匹配的请求换到内网去；
2. 页面内建立一个 **WebRTC DataChannel**，与内网的一台 **Agent** 打洞直连；
3. 隧道里说的是标准 **HTTP/1.1**，所以内网应用**一行代码都不用改**，**地址栏也完全不变**。

连上之后，业务流量走「浏览器 ↔ 内网 Agent」的 P2P 链路，**不经过公网**。公网侧只做两件事：信令配对（SDP/ICE）和提供首次静态资源。P2P 打不通时自动回落 nginx 反向代理，站点照常可用。

---

## 与其它方案对比

| 方案 | 改应用 | 改 URL | 稳态流量过公网 | 装客户端 |
| --- | --- | --- | --- | --- |
| VPN | 否 | 否 | 否 | **要** |
| 反向代理 | 通常要 | 常要 | **是（全量）** | 否 |
| **RTCWeb2Lan** | **否** | **否** | **否（P2P 直连）** | 否 |

代价见[已知限制](#已知限制)：内网页面不能再自建 PWA，WebSocket 无法被代理。

---

## 架构

```
 浏览器                              公网服务器                      内网
┌────────────────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│ 站点页面        （原始静态）   │    │ nginx / 静态托管   │    │  Agent（内网侧）      │
│ /__lan/         连接页 + 信令  │───►│ /__lan/* → 信令    │    │  出站连接信令          │
│ Service Worker  拦截并转发     │    │ 其余     → 回落     │    │        │            │
│      ↕ 隐藏 holder iframe     │    └──────────────────┘    │        ▼            │
│ RTCPeerConnection ══ P2P DataChannel ═══════════════════► │  内网服务（零改造）      │
└────────────────────────────┘      （信令只做 SDP/ICE 配对）    └────────────────────┘
```

### 一次访问的完整流程

1. **首次访问** `/__lan/connect.html`：注册 Service Worker（scope `/`）→ 连接信令房间 → WebRTC offer/answer → ICE 打洞 → 把页面侧数据面（MessagePort）交给 SW → 探测验证 → 跳转 `/`。
2. **之后** 访问 `/`：SW 在返回的 HTML 里注入一个隐藏的 `holder.html` iframe，常驻持有 P2P 连接；页面之间跳转不断链，断线自动重连。
3. **运行时**：SW 拦到命中配置的请求，序列化成 HTTP/1.1，经 DataChannel 送到内网 Agent；Agent 按路由表转发到真实服务，响应原路回灌。
4. **优雅降级**：P2P 不可用或交换失败时，SW 立即停止拦截，请求回落 nginx 反向代理；holder 持续重连，恢复后自动切回 P2P。

### 设计要点

| 要点 | 说明 |
| --- | --- |
| **URL 不变** | 目标地址只存在于路由表里，绝不进入地址栏或页面可见 URL。 |
| **一请求一通道** | 每条 HTTP 请求开一条独立 DataChannel，天然隔离，无需自己实现流 ID 与重组。 |
| **空消息作 EOF** | DataChannel 有序可靠，用空消息标记消息结束，不必加长度前缀。 |
| **Cookie 双轨** | 隧道侧由 Agent 的 cookie jar 维持会话；回落侧由浏览器原生携带。需浏览器 cookie 的认证接口应配置为走源站（见下）。 |
| **失败即降级** | 任何一环出问题都退回普通反向代理，宁可慢也不中断。 |

> 为什么不用现成的 overlay 方案？浏览器内的 WASM overlay 实现通常禁用 P2P（只能经 WebSocket 中继），无法满足「稳态流量不过公网」，因此本项目自建 WebRTC 数据面。

---

## 配置

所有站点相关的信息都在一个运行时加载的 JSON 里（`public/config.json` → 发布后的 `dist/config.json`），**改完刷新页面即生效，无需重新构建**。

> ⚠️ 该文件随静态资源公开，**不要放任何密钥**。

```jsonc
{
  "routes": [
    // 公网域名 → 内网目标。kind="host" 整站路由；kind="prefix" 路径前缀路由
    { "kind": "host", "host": "app.example.com",
      "target": { "ipv4": "192.168.1.10", "port": 8080 } }
  ],
  "site": {
    // 哪些路径走 P2P 隧道；其余（静态资源）直接由 nginx 服务
    "apiPrefixes": ["/api/"],
    // 永远走源站的路径前缀。认证接口必须在这里：会话 cookie 通常是 HttpOnly，
    // Service Worker 读不到它，走隧道会被误判为未登录
    "neverTunnel": ["/api/auth"],
    // 建链后验证隧道是否真的通的探针路径；任意 HTTP 状态都算通
    "probePath": "/api/ping"
  },
  "signaling": {
    "room": "default",
    "stun": "stun:stun.example.com:3478"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `routes[]` | 公网 Host / 路径前缀 → 内网目标。`kind="host"` 整站路由；`kind="prefix"` 路径前缀路由（前缀只是浏览器侧的寻址糖，转发时会被剥掉）。 |
| `site.apiPrefixes` | 哪些路径走隧道，默认 `["/api/"]`。其余静态资源留给 nginx（更快、可缓存）。 |
| `site.neverTunnel` | 永远走源站的路径前缀，认证接口请放这里（见下方「认证与会话」）。按路径段边界匹配：`"/api/auth"` 覆盖 `/api/auth/login`，但不会误伤 `/api/authenticate`。 |
| `site.probePath` | 建链后用来验证隧道的探针，**任意 HTTP 状态都算通**。建议用一个便宜、快速且**落在 `apiPrefixes` 之内**的路径。 |
| `signaling.room` | 信令房间号，浏览器与 Agent 必须一致。 |
| `signaling.stun` | STUN 服务器（逗号分隔）。设为 `""` 则只用主机候选，适合纯内网。 |

**加载优先级**：① `?config=<urlencoded JSON>` 查询参数（临时调试）> ② `config.json` > ③ 内置默认（不含任何内网地址）。

### 认证与会话

会话 cookie 通常带 `HttpOnly`，浏览器不允许任何 JS（**包括 Service Worker**）读取它。因此走隧道的认证请求会被目标服务视为未登录。

推荐做法：**把认证接口配置到 `neverTunnel`**，让它走 nginx —— 浏览器会原生携带 cookie，同时避免「隧道侧 cookie jar」与「浏览器 cookie」两套会话状态互相打架。

```jsonc
"neverTunnel": ["/api/auth"]   // login / logout / session 一并覆盖
```

---

## 部署

两个部署单元，各自一个镜像：

| 单元 | 位置 | 职责 |
| --- | --- | --- |
| **`fdn`**（front desk node） | 公网 | 静态资产 + 信令 + **内置兜底反代**，一个进程一个端口 |
| **`tunnelagent`** | 内网 | 出站连信令、按路由表转发；不监听任何端口 |

### fdn（公网边缘）

```bash
# 镜像
docker build -f fdn/Dockerfile -t rtcweb2lan/fdn .

# 运行：资产 + 信令 + 兜底反代共用 :8080
docker run -d --name fdn -p 8080:8080 \
  -v "$PWD/routes.yaml:/app/routes.yaml:ro" rtcweb2lan/fdn
```

不传 `-routes` 时只提供资产与信令（兜底关闭）。兜底代理取代了原先的宿主机 nginx vhost，因此公网侧只需要这一个容器 + TLS 终止。

### tunnelagent（内网）

```bash
docker build -f tunnelagent/Dockerfile -t rtcweb2lan/tunnelagent .

docker run -d --name tunnelagent \
  -v "$PWD/routes.yaml:/app/routes.yaml:ro" \
  rtcweb2lan/tunnelagent \
  -signal wss://edge.example.com/__lan/ws -room default -routes /app/routes.yaml
```

### 路由表

两边都用同一份语义：公网 Host（或路径前缀）→ 内网目标。

```yaml
routes:
  - name: app
    kind: host
    host: app.example.com
    target: http://192.168.1.10:8080
```

- `tunnelagent` 用它决定「隧道里的请求发给谁」；
- `fdn` 用它决定「兜底时请求反代给谁」。

> 兜底是**可用性底线**：P2P 失败时站点仍然完整可用，只是流量会经过公网。

---


## 本地开发

```bash
pnpm install
pnpm test          # 前端单测
pnpm run test:go   # Go 单测
pnpm run dev:stack # 一键本地栈：假内网服务 + 信令 + Agent + Web UI
```

`dev:stack` 会在本机拉起一整套环境并打印访问地址，打开后等待连接完成即可看到请求经 P2P 打到「内网」服务。

### 对接真实环境

```bash
pnpm run build:go   # 产出 .dev-bin/fdn 与 .dev-bin/tunnelagent

./.dev-bin/fdn -addr 127.0.0.1:8787
./.dev-bin/tunnelagent -signal ws://127.0.0.1:8787/__lan/ws -room demo -routes tunnelagent/routes.yaml
pnpm --dir fdn/web dev   # 打开 /?signal=...&room=demo
```

---

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `fdn/web/src/config.ts` | 配置契约、默认值、规范化、路由判定（`shouldTunnel` / `pathMatchesPrefix`） |
| `fdn/web/src/config-loader.ts` | 加载 `config.json` 并推送给 Service Worker |
| `fdn/web/src/sw.ts` | fetch 拦截、导航门控、隧道交换、失败自愈、Set-Cookie 转发 |
| `fdn/web/src/nav-gate.ts` | `/` 的导航决策（连接页 / 注入 holder / 直通）与 holder 注入 |
| `fdn/web/src/connect.*` / `holder.*` | 连接页（建链重试、跳转）/ 常驻 iframe（持有数据面、健康检查、落 Cookie） |
| `fdn/web/src/connect-flow.ts` | 建链流程（信令 → ICE → 接入 → 验证）与 SW 控制消息 |
| `fdn/web/src/peer.ts` / `channel.ts` | RTCPeerConnection 封装 / 单通道收发约定（分片、空消息 EOF、背压） |
| `fdn/web/src/data-plane.ts` / `port-transport.ts` | 页面侧数据面 / SW ↔ 页面 MessagePort 传输 |
| `fdn/web/src/http1.ts` / `router.ts` | HTTP/1.1 增量编解码 / Host + 前缀路由 |
| `fdn/web/src/cookie-relay.ts` | Set-Cookie → `document.cookie` 转换（剥 HttpOnly） |
| `agent/internal/fdn/` | 公网边缘：静态资产 + 信令挂载 + 兜底反向代理 |
| `agent/internal/tunnel/` | WebRTC 隧道与请求转发（tunnelagent） |
| `agent/internal/relay/` | 路由表与反向代理，两边共用 |
| `agent/internal/signaling/` | 信令服务端与客户端 |
| `agent/cmd/fdn/` / `agent/cmd/tunnelagent/` | 两个入口 |

---

## 已知限制

| 限制 | 原因 / 说明 |
| --- | --- |
| **WebSocket 无法代理** | Service Worker 的 fetch 拦截只覆盖 HTTP，`/socket.io` 等实时推送走不了隧道。 |
| **首次访问的鸡生蛋** | 冷浏览器第一次访问 `/` 时还没有 Service Worker，只能看到兜底反代的站点；需要先访问一次连接页。 |
| **内网页面不能再建 PWA** | 一个 origin 只能有一个控制 scope `/` 的 Service Worker，已被本项目占用，内网应用自身的 PWA worker 需禁用。 |
| **对称型 NAT 打洞失败** | 此时自动回落 fdn 的兜底反代；如需强制直连可自行部署 TURN。 |
| **HttpOnly cookie 读不到** | 见「认证与会话」，把认证接口配置到 `neverTunnel`。 |

---

## License

见仓库中的许可文件。
