# RTCWeb2Lan

**在浏览器里直接访问内网 Web，内网服务零改造、地址栏 URL 全程不变、稳态流量 P2P 直连不过公网。**

很多内网系统（审计、财务、运维后台……）只允许在内网访问。传统做法是 VPN 或反向代理：VPN 要装客户端、改路由；反代会把全部流量压到公网 VPS，且要么改地址、要么改应用。RTCWeb2Lan 换了个思路——

- 浏览器装一个 **Service Worker**，在用户看不到的层面把请求目的地换成内网；
- 页面里跑一个 **WebRTC DataChannel**，与内网的一台 **Agent** 打洞直连；
- 两边用 **HTTP/1.1** 说话，所以内网 Web **一行代码都不用改**，地址栏也**全程不变**。

连上之后，业务数据走浏览器 ↔ 内网 Agent 的 P2P 链路，**不经过公网**；公网只负责「牵线」（信令 SDP/ICE 配对）和首次静态资源。P2P 打不通时自动回落 nginx 反代，站点照常可用。

---

## 它解决什么问题

| 方案 | 要改应用？ | URL 变？ | 稳态流量过公网？ | 要装客户端？ |
| --- | --- | --- | --- | --- |
| VPN | 否 | 否 | 否 | **要** |
| 反向代理 | 通常要 | 常要 | **是（全量）** | 否 |
| **RTCWeb2Lan** | **否** | **否** | **否（P2P 直连）** | 否 |

代价是：内网页面**不能再自建 PWA**（Service Worker 槽位被本方案占用），以及 `/socket.io` 这类 WebSocket **无法被代理**（见[已知限制](#已知限制)）。

---

## 快速开始

### 只想先在本机看看效果

```bash
pnpm install
pnpm run dev:stack
```

这条命令会拉起一套假环境：一个假内网服务（:8099）、信令 relay（:8787）、内网 Agent、以及 Web UI（:5273）。打开终端提示的 **http://127.0.0.1:5273/** ，等待页面显示「链路已焊通 / 已连接」，再点页面上的探测按钮，就能看到请求经由 P2P 隧道打到了「内网」服务。

> 首次访问会先跳到一个**连接页**（连接动画），建好链路后自动进入站点。这是正常的引导流程。

### 把它接到你自己的内网

1. **内网机**：跑 Agent，告诉它公网 Host 对应哪个内网地址（见 [Agent 侧路由](#agent-侧路由routesyaml)）。
2. **公网机**：部署信令 + 静态页（一个容器即可，见[部署](#部署)），并让 nginx 按 Host 把 `/__lan/*` 指到它、其余（回落）反代到内网。
3. **浏览器**：第一次打开 `https://<你的域名>/__lan/connect.html` 完成建链；之后直接访问 `/` 即可，SW 会常驻并自动重连。

---

## 工作原理

```
 浏览器                                        公网 VPS(1号机)                内网
┌──────────────────────────────────┐      ┌──────────────────┐        ┌──────────────────┐
│ 站点页 /            （原始静态）      │      │ nginx            │        │ 229: web2lan-agent│
│ /__lan/            连接页 + 信令      │ ───► │ /__lan/*  → 信令   │        │  （systemd 服务）  │
│ Service Worker 拦 /api/*           │      │ 其余      → 回落   │        │       │           │
│        ↕ 隐藏 holder iframe        │      └──────────────────┘        │       ▼           │
│ RTCPeerConnection ══ P2P DataChannel ═══════════════════════════►  230: 内网服务      │
└──────────────────────────────────┘        （信令只做 SDP/ICE 配对）    └──────────────────┘
```

1. **首次访问** `/__lan/connect.html`：注册 Service Worker（scope `/`）→ 连信令房间 → WebRTC offer/answer → ICE 打洞 → 把页面侧数据面（MessagePort）接入 SW → 探测验证 → 跳转 `/`。
2. **之后** 访问 `/` 时，SW 给页面注入一个隐藏的 `holder.html` iframe，常驻持有 P2P 连接；页面间导航不断链，断线自动重连。
3. **运行时**：SW 拦到匹配配置的请求（默认 `/api/*`），编码成 HTTP/1.1，经 DataChannel（**一请求一通道**）送到内网 Agent；Agent 按路由表反代到真实服务，响应原路回灌。
4. **Cookie 双轨**：Agent 侧用 cookiejar 管会话（隧道路径）；SW 把 `Set-Cookie` 转发给 holder 用 `document.cookie` 落盘（回落路径）——因为浏览器禁止在 SW 合成的 Response 上设置 Set-Cookie。
5. **优雅降级**：P2P 不可用或交换失败时，SW 立即停止拦截，请求回落 nginx 反代；holder 持续重连，恢复后自动切回 P2P。

> 为什么是自研 WebRTC DataChannel 而不是 EasyTier WASM？官方 `easytier-js` 的浏览器版把 `disable_p2p=true` 写死，浏览器内不具备 P2P 能力，故本项目自建数据面（详见 `docs/架构决策.md`）。

---

## 配置（改配置，不改代码）

前端**不写死任何内网地址或站点路径**。站点信息集中在 `public/config.json`，**发布到 `dist/config.json`，改完刷新页面即生效，无需重新构建**。

> ⚠️ 该文件随静态资源公开，**不要放密钥**。

```jsonc
{
  "routes": [
    { "kind": "host", "host": "sense.jshuaxin.net",
      "target": { "ipv4": "10.1.1.230", "port": 9011 } }
  ],
  "site": {
    "apiPrefixes": ["/api/"],              // 走隧道的路径前缀；其余静态资源留在 nginx
    "neverTunnel": ["/api/auth/session"],  // 永远走源站（需要浏览器 httpOnly cookie 的接口）
    "probePath": "/health"                 // 建链后验证隧道的探针；任意 HTTP 状态即视为通
  },
  "signaling": { "room": "lan", "stun": "stun:stun.chat.bilibili.com:3478" }
}
```

| 字段 | 说明 |
| --- | --- |
| `routes[]` | 公网 Host/前缀 → 内网目标。`kind="host"` 整站路由；`kind="prefix"` 路径前缀路由（前缀是浏览器侧寻址糖，转发时剥掉）。 |
| `site.apiPrefixes` | 哪些路径走隧道（默认 `["/api/"]`），其余静态资源由 nginx 直接服务（更快、可缓存）。 |
| `site.neverTunnel` | 永远走源站的路径，例如需要浏览器 httpOnly cookie 的登录态接口。 |
| `site.probePath` | 建链后的连通性探针，**任意 HTTP 状态都算通**。默认 `/`；建议用轻量健康接口，别用慢的业务接口（否则健康隧道会被误判为死）。 |
| `signaling.room` | 信令房间号，浏览器与 Agent 必须在同一房间。 |
| `signaling.stun` | STUN 地址（逗号分隔）。`""` 关闭 STUN，仅用主机候选，适合纯内网。 |

- 加载优先级：① `?config=<urlencoded JSON>` 查询参数（临时测试）> ② `config.json` > ③ 内置默认（**默认不含任何内网地址**）。
- 相关代码：`src/config.ts`（契约/默认值/校验）、`src/config-loader.ts`（加载并推给 SW）、`src/sw.ts`（按配置决定拦哪些路径、路由到哪）。

---

## 部署

### 拓扑（当前实测）

| 位置 | 组件 | 说明 |
| --- | --- | --- |
| 1号机 10.1.1.1（公网 VPS） | nginx + `web2lan` 容器 | 容器 = `web2lan-signal -static /app/dist`（信令 `/__lan/ws` + 静态页）；nginx 按路径分流，并把 `/api`、`/health` 反代到内网作回落 |
| 229 10.1.1.229 | `web2lan-agent`（systemd） | 出站连信令（不监听端口），`-routes routes.yaml -stun …`，经 EasyTier 转发到目标 |
| 230 10.1.1.230:9011 | 内网目标（如 GSDJSense） | 真实内网服务，零改造 |

### 前端 + 信令（1号机容器）

文件服务按请求读盘，更新 dist **无需重启**：

```bash
pnpm build && tar -cf /tmp/dist.tar -C dist .
scp /tmp/dist.tar root@10.1.1.1:/tmp/
ssh root@10.1.1.1 'mkdir -p /tmp/d && tar -xf /tmp/dist.tar -C /tmp/d && docker cp /tmp/d/. web2lan:/app/dist/'
```

### Agent（229）

```bash
cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o /tmp/agent ./cmd/web2lan-agent
scp /tmp/agent beijihu@10.1.1.229:/home/beijihu/web2lan/web2lan-agent.new
ssh beijihu@10.1.1.229 'cd ~/web2lan && mv web2lan-agent.new web2lan-agent && chmod +x web2lan-agent && sudo systemctl restart web2lan-agent'
```

### Agent 侧路由（routes.yaml）

Agent 用 `routes.yaml` 决定公网 Host 落到哪个内网服务（与前端 `config.json` 的 `routes` 对应）：

```yaml
routes:
  - name: sense
    kind: host
    host: sense.jshuaxin.net
    target: http://10.1.1.230:9011
```

### 验证要点

- **路径判别**：nginx 反代的响应带 `server: nginx/…`；**隧道响应无 `server` 头**——用它区分「走了 P2P」还是「走了回落」，别只看状态码。
- 响应 URL 不得出现内网 IP（`10.1.1.x`）。
- Agent 日志（229 `~/web2lan/agent.log`）能看到 `GET/POST … -> http://10.1.1.230:9011` 即隧道转发生效。
- 状态行：`P2P 直连`（local=host/srflx）优于 `经 TURN 中转`；打洞失败自动 `回落反代`。

---

## 本地开发

```bash
pnpm install
pnpm test          # TS 单测（74 个）
pnpm run test:go   # Go 单测
pnpm run dev:stack # 一键本地栈（信令 + Agent + 假内网服务，http://127.0.0.1:5273/）
```

对接真实内网（本机需在 EasyTier 网内）：

```bash
./.dev-bin/signal -addr 127.0.0.1:8787
./.dev-bin/agent  -signal ws://127.0.0.1:8787/ws -room real -routes routes.yaml
npx vite --port 5273   # 打开 /?signal=…&room=real
```

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/config.ts` / `src/config-loader.ts` | 配置契约、默认值、校验 / 加载 `config.json` 并推给 SW |
| `src/sw.ts` | fetch 拦截、导航门（splash/holder 注入）、隧道交换、失败自愈、Set-Cookie 转发 |
| `src/nav-gate.ts` | `/` 的导航决策（connect-page / inject-holder / passthrough）与 holder 注入 |
| `src/connect.html` + `src/connect.ts` | 连接页：注册 SW、建链重试、跳转 |
| `src/holder.html` + `src/holder.ts` | 常驻 iframe：持有/重连数据面、健康检查、落地 Cookie |
| `src/connect-flow.ts` | 建链流程（信令→ICE→接入→验证）与 SW 控制消息 |
| `src/peer.ts` | RTCPeerConnection 封装（发起/应答、通道工厂） |
| `src/channel.ts` | 单通道收发约定（16KiB-1 分片、空消息 EOF、背压） |
| `src/data-plane.ts` | 页面侧数据面：交换队列 + 楔死通道重试 |
| `src/port-transport.ts` | SW↔页面 MessagePort 传输（含死端口超时） |
| `src/http1.ts` / `src/router.ts` | HTTP/1.1 增量编解码 / host+前缀路由（URL 保持不变） |
| `src/cookie-relay.ts` | Set-Cookie → document.cookie 转换（剥 HttpOnly） |
| `agent/` | Go：信令服务器（`web2lan-signal`）与内网 Agent（`web2lan-agent`，pion/webrtc v4） |

---

## 已知限制

- **WebSocket 不可代理**：内网页面依赖 `/socket.io` 等实时推送时，SW 帮不上忙（回落路径也仅覆盖 HTTP）。
- **引导鸡生蛋**：冷浏览器首次访问 `/` 没有 SW，只会看到 nginx 版站点；需先访问一次 `/__lan/connect.html`。
- **内网页面不能再自建 PWA**：一个 origin 只能有一个控制 scope `/` 的 Service Worker，槽位被本方案占用（如 Angular ngsw 会与本 SW 竞争，需在应用侧禁用 PWA）。
- **对称型 NAT 下打洞会失败**（自动回落 nginx）；229 出口实测为受限锥形，双向打洞可行。
