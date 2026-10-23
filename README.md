# RTCWeb2Lan

**在浏览器里直接访问内网 Web 服务：内网应用零改造、地址栏 URL 全程不变、稳态流量 P2P 直连不过公网。**

许多服务（内部管理后台、运维面板、审计/财务系统……）只允许在内网访问。常见做法是 VPN 或反向代理：

- **VPN**：要装客户端、改路由表，对非技术用户不友好；
- **反向代理**：把全部流量压到公网服务器，且往往要改地址或改应用。

RTCWeb2Lan 用另一条路：

1. 浏览器注册一个 **Service Worker**，在用户看不见的层面把匹配的请求换到内网去；
2. 页面内建立一个 **WebRTC DataChannel**，与内网的一台 **Agent** 打洞直连；
3. 隧道里说的是标准 **HTTP/1.1**，所以内网应用**一行代码都不用改**，**地址栏也完全不变**。

连上之后，业务流量走「浏览器 ↔ 内网 Agent」的 P2P 链路，**不经过公网**。公网侧只做两件事：信令配对（SDP/ICE）和提供首次静态资源。P2P 打不通时自动回落兜底反向代理（由 fdn 内置），站点照常可用。

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
│ 站点页面        （原始静态）   │    │  fdn（公网边缘）    │    │  Agent（内网侧）      │
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
4. **优雅降级**：P2P 不可用或连续交换失败时，SW 停止拦截，请求回落 fdn 内置的反向代理；holder 持续重连，恢复后自动切回 P2P。

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

配置分两层，各管各的：

| 文件 | 谁读 | 管什么 |
| --- | --- | --- |
| `fdn/web/public/config.json` | 浏览器（Service Worker） | 哪些路径走隧道、探针、信令房间 |
| `routes.yaml` | `fdn` 与 `tunnelagent` | 公网域名 → 内网目标 |

两者**互不替代**：`config.json` 决定浏览器把请求发给隧道还是留在源站；`routes.yaml` 决定隧道里（以及兜底时）请求最终落到哪台内网机器。

### 浏览器侧：config.json

随静态资源发布（`dist/config.json`），**改完刷新页面即生效，不必重新构建**。

> ⚠️ 该文件公开可读，**不要放任何密钥**。

```jsonc
{
  "routes": [
    // 公网域名 → 内网目标（浏览器侧用它挑选隧道的目标 authority）
    { "kind": "host", "host": "app.example.com",
      "target": { "ipv4": "192.168.1.10", "port": 8080 } }
  ],
  "site": {
    // 哪些路径走 P2P 隧道；其余静态资源留给兜底反代
    "apiPrefixes": ["/api/"],
    // 永远走源站的路径前缀。认证接口必须在这里（见「认证与会话」）
    "neverTunnel": ["/api/auth"],
    // 建链后验证隧道是否真的通的探针；任意 HTTP 状态都算通
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
| `routes[]` | 公网 Host / 路径前缀 → 内网目标。`kind="host"` 整站路由；`kind="prefix"` 路径前缀路由（前缀是浏览器侧寻址糖，转发时剥掉）。 |
| `site.apiPrefixes` | 走隧道的路径，默认 `["/api/"]`。其余静态资源留给兜底（更快、可缓存）。 |
| `site.neverTunnel` | 永远走源站的路径前缀。按**路径段边界**匹配：`"/api/auth"` 覆盖 `/api/auth/login`，但不会误伤 `/api/authenticate`。 |
| `site.probePath` | 建链后的隧道探针，**任意 HTTP 状态都算通**。必须落在 `apiPrefixes` 之内，否则 Service Worker 不会拦截，探针会误判隧道已死。 |
| `signaling.room` | 信令房间号，浏览器与 `tunnelagent` **必须一致**。 |
| `signaling.stun` | STUN 服务器（逗号分隔）。设为 `""` 只用主机候选，适合纯内网。 |

**加载优先级**：① `?config=<urlencoded JSON>` 查询参数（临时调试）> ② `config.json` > ③ 内置默认（不含任何内网地址）。

### 服务端：routes.yaml

`fdn` 与 `tunnelagent` 读同一份语义，通常**挂载同一个文件**：

```yaml
routes:
  - name: app
    kind: host              # host = 整站路由；prefix = 路径前缀路由
    host: app.example.com   # 公网域名
    # prefix: /app          # 仅 kind=prefix 时使用，转发前会被剥掉
    target: http://192.168.1.10:8080
    # insecure_tls: true    # 跳过上游证书校验
    # upstream_sni: name    # 自定义上游 SNI
```

| 使用者 | 用途 |
| --- | --- |
| `tunnelagent` | 隧道里的请求转发给谁 |
| `fdn` | 兜底时请求反代给谁 |

仓库里的 `tunnelagent/routes.yaml` 是**模板**（占位值）。真实地址部署时挂载，不要提交进仓库。

> 兜底是**可用性底线**：P2P 失败时站点仍然完整可用，只是流量会经过公网。

### 认证与会话

会话 cookie 通常带 `HttpOnly`，浏览器不允许任何 JS（**包括 Service Worker**）读取它。因此走隧道的认证请求会被目标服务视为未登录。

推荐做法：**把认证接口配置到 `neverTunnel`**，让它走源站——浏览器会原生携带 cookie，同时避免「隧道侧 cookie jar」与「浏览器 cookie」两套会话状态互相打架。

```jsonc
"neverTunnel": ["/api/auth"]   // login / logout / session 一并覆盖
```

---

## 部署

两个部署单元，各自一个镜像：

```
                    公网                              内网
           ┌──────────────────────┐        ┌──────────────────────┐
 浏览器 ──►│  fdn (front desk node)│        │  tunnelagent          │
           │  静态 + 信令 + 兜底反代 │        │  出站连信令 + 按路由转发 │
           └──────────────────────┘        └──────────┬───────────┘
                  ▲                                   │
                  └──────── P2P DataChannel ──────────┘
```

| 单元 | 位置 | 职责 | 监听 |
| --- | --- | --- | --- |
| **`fdn`** | 公网 | 静态资产 + 信令 + **内置兜底反代** | `:8080` |
| **`tunnelagent`** | 内网 | 出站连信令、按路由表转发 | **不监听任何端口** |

### 前置条件

- 公网主机：Docker，一个域名，TLS 证书（或交给上层负载均衡终止 TLS）
- 内网主机：Docker，且能访问要暴露的内网服务
- 两边都能访问同一个信令地址（即 fdn 的 `/__lan/ws`）

### 第 1 步：构建镜像

```bash
# 公网边缘
docker build -f fdn/Dockerfile -t rtcweb2lan/fdn .

# 内网代理
docker build -f tunnelagent/Dockerfile -t rtcweb2lan/tunnelagent .
```

> **跨架构**：若构建机与部署机架构不同（例如 Apple Silicon 构建、x86_64 部署），必须交叉构建：
> ```bash
> docker buildx build --platform linux/amd64 -f fdn/Dockerfile -t rtcweb2lan/fdn --load .
> docker save rtcweb2lan/fdn -o fdn.tar   # 拷到部署机后 docker load
> ```

### 第 2 步：部署 tunnelagent（内网）

先起内网侧，确认它能连上信令。

```bash
docker run -d --name tunnelagent --restart unless-stopped \
  --network host \
  -v /etc/rtcweb2lan/routes.yaml:/app/routes.yaml:ro \
  rtcweb2lan/tunnelagent \
  -signal wss://edge.example.com/__lan/ws \
  -room default \
  -routes /app/routes.yaml
```

`--network host` 通常是必须的：agent 要看到宿主机的内网路由（VPN、overlay 网络等），bridge 网络下看不到。

| 参数 | 说明 |
| --- | --- |
| `-signal` | 信令地址，**必须指向 fdn**，即 `wss://<公网域名>/__lan/ws` |
| `-room` | 房间号，与 `config.json` 的 `signaling.room` 一致 |
| `-routes` | 路由表路径 |
| `-stun` | STUN 服务器（逗号分隔），跨 NAT 打洞需要 |
| `-turn` / `-turn-user` / `-turn-pass` | TURN 兜底（对称型 NAT 才需要） |
| `-advertise-cidr` | 只广播该网段内的主机候选，例如 `10.0.0.0/8`，避免把无关网卡暴露给对端 |
| `-target` | 单目标快捷方式（快速测试用），给了它就不用 `-routes` |
| `-insecure-upstream` | 跳过上游证书校验 |

确认连上：

```bash
docker logs tunnelagent | tail
# 期望看到：joined room "default" via wss://...  /  relay says ready
```

### 第 3 步：部署 fdn（公网）

```bash
docker run -d --name fdn --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /etc/rtcweb2lan/routes.yaml:/app/routes.yaml:ro \
  rtcweb2lan/fdn
```

绑定 `127.0.0.1` 是刻意的：fdn 只服务本机的 TLS 终止层，不直接暴露到公网。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-addr` | `:8080` | 监听地址 |
| `-static` | 镜像内 `/app/dist` | 构建好的前端资产目录 |
| `-routes` | 空 | 兜底反代的路由表；**不传则兜底关闭**，只提供资产与信令 |
| `-prefix` | `/__lan` | 覆盖层资产与信令的 URL 前缀 |
| `-insecure-upstream` | 关 | 跳过兜底目标的证书校验 |

### 第 4 步：TLS 终止

fdn 自己不做 TLS。用一个 nginx（或任意反向代理）把 443 全量转给 fdn：

```nginx
server {
    listen 443 ssl;
    server_name edge.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # 信令 WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

**关键**：`Upgrade` / `Connection` 头必须透传，否则 `/__lan/ws` 信令握手失败。这条 `location /` 就是全部——兜底反代已经在 fdn 内部，nginx 不需要知道任何内网地址。

### 第 5 步：验证

```bash
# 资产
curl -o /dev/null -w '%{http_code}\n' https://edge.example.com/__lan/sw.js          # 200
curl -o /dev/null -w '%{http_code}\n' https://edge.example.com/__lan/config.json   # 200

# 信令已挂载（无 room 参数应返回 400，不是 404）
curl -o /dev/null -w '%{http_code}\n' https://edge.example.com/__lan/ws            # 400

# 兜底反代（首次访问应 302 到连接页）
curl -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' https://edge.example.com/     # 302
```

浏览器打开 `https://edge.example.com/`，应看到连接页 → 自动进入站点。之后在 DevTools 里看 `/api/*` 响应头：**没有 `server` 头 = 走了隧道**。

### 首次访问的行为

| 状态 | 访问 `/` 时 |
| --- | --- |
| 全新浏览器（无 Service Worker） | **302 → 连接页**，建链成功后自动进入站点 |
| 刚连接过（`w2l_grace`，60 秒内） | 直接进站 |
| 用户点过「直接进入」（`w2l_direct`，30 分钟） | 直接进站 |
| API / 非 HTML / 深层路径 | 直接反代，不受影响 |

### 升级

```bash
docker rm -f fdn && docker run -d ... rtcweb2lan/fdn   # 用新镜像重跑
```

前端资产打进了镜像，**升级必须换镜像**，不能只替换文件。

> 换镜像会重启信令，`tunnelagent` 需要重连。若它没有自动恢复，重启一次即可：
> ```bash
> docker restart tunnelagent
> ```

### 排障

| 现象 | 检查 |
| --- | --- |
| 连接页一直转，不进入 | `docker logs tunnelagent` 有无 `joined room`；信令 nginx 是否透传 `Upgrade` 头 |
| 站点能开但全部走兜底 | 浏览器 `config.json` 是否加载成功；`probePath` 是否落在 `apiPrefixes` 内 |
| `/__lan/ws` 返回 404 | `-prefix` 与实际路径不符 |
| 登录后立刻掉登录态 | 认证接口没进 `neverTunnel`（见「认证与会话」） |
| 兜底 502 | `routes.yaml` 里没有匹配该 Host 的条目；看 `docker logs fdn` 的 `no route:` |

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
| `fdn/web/src/overlay-policy.ts` | holder 对「状态查询无响应」的处置策略（不因一次问不到就杀健康连接） |
| `fdn/web/src/exchange-health.ts` | 连续交换失败计数，决定何时判定数据面已死 |
| `agent/internal/fdn/` | 公网边缘：静态资产 + 信令挂载 + 兜底反向代理 + 首次访问引导 |
| `agent/internal/tunnel/` | WebRTC 隧道与请求转发（tunnelagent） |
| `agent/internal/relay/` | 路由表与反向代理，两边共用 |
| `agent/internal/signaling/` | 信令服务端与客户端 |
| `agent/cmd/fdn/` / `agent/cmd/tunnelagent/` | 两个入口 |

---

## 已知限制

| 限制 | 原因 / 说明 |
| --- | --- |
| **WebSocket 无法代理** | Service Worker 的 fetch 拦截只覆盖 HTTP，`/socket.io` 等实时推送走不了隧道。 |
| **首次访问多等一次建链** | 冷浏览器没有 Service Worker，无法自己拦截。fdn 会把首次访问引导到连接页，建链完成后才进入站点（约 2 秒）。 |
| **内网页面不能再建 PWA** | 一个 origin 只能有一个控制 scope `/` 的 Service Worker，已被本项目占用，内网应用自身的 PWA worker 需禁用。 |
| **对称型 NAT 打洞失败** | 此时自动回落 fdn 的兜底反代；如需强制直连可自行部署 TURN。 |
| **HttpOnly cookie 读不到** | 见「认证与会话」，把认证接口配置到 `neverTunnel`。 |

---

## License

见仓库中的许可文件。