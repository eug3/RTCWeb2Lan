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
3. **运行时**：SW 拦到命中配置的请求，序列化成 HTTP/1.1，按帧协议（stream id）写进**同一条** DataChannel；Agent 按 stream 拆出请求、按路由表转发到真实服务，响应按同一 stream 回灌。
4. **优雅降级**：P2P 不可用或连续交换失败时，SW 停止拦截，请求回落 fdn 内置的反向代理；holder 持续重连，恢复后自动切回 P2P。

### 设计要点

| 要点 | 说明 |
| --- | --- |
| **URL 不变** | 目标地址只存在于路由表里，绝不进入地址栏或页面可见 URL。 |
| **单通道多路复用** | 所有交换共用一条 DataChannel，用帧头（kind + stream id）区分。每请求开新通道看似更简单，但每个请求都要一次 DCEP 握手，Chrome 与 pion 经常完不成，实测几乎全失败。 |
| **帧标记 EOF** | DataChannel 有序可靠，用 END 帧标记消息结束，不必加长度前缀。 |
| **Cookie 双轨** | 隧道侧由 Agent 的 cookie jar 维持会话（Agent 自己登录）；回落侧由浏览器原生携带 HttpOnly cookie。两套互不干扰。 |
| **会话不可见** | Service Worker 读不到浏览器的任何 cookie（Chromium 设计，与 HttpOnly 无关）。所以隧道侧的会话只能由 Agent 自己持有，不能指望从浏览器借。 |
| **失败即降级** | 任何一环出问题都退回普通反向代理，宁可慢也不中断。连续三次交换失败才判定数据面已死，单次抖动不会拆掉健康的连接。 |

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
| `site.neverTunnel` | 永远走源站的路径前缀。按**路径段边界**匹配：`"/api/auth"` 覆盖 `/api/auth/login`，但不会误伤 `/api/authenticate`。默认留空——把认证也交给隧道，Agent 自己持有会话（见「认证与会话」）。 |
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

这是本项目最容易踩错的地方，先讲清一条硬限制：

> **Service Worker 读不到浏览器的任何 cookie。**
> 不是「读不到 HttpOnly」——是所有 cookie 都读不到。Chromium 在 SW 的 `fetch` 事件里根本不提供 `Cookie` 头，凭据由网络栈在 SW 之后附加。

所以隧道里的请求**永远不可能带上浏览器的会话**。想让业务接口走 P2P，会话只能来自内网侧。

#### 推荐做法：让 Agent 自己登录

把认证接口**留在隧道内**（`neverTunnel` 为空），登录请求经隧道到达 Agent：

```
用户登录 → 隧道 → Agent → 目标服务返回 Set-Cookie
                          ├→ Agent 的 cookie jar 保存 ✓
                          └→ SW 转成 document.cookie 交给浏览器 ✓
```

两边各自持有会话，后续业务请求就能直接走隧道：

```jsonc
"neverTunnel": []   // 认证也走隧道
```

**代价**：浏览器侧那份 cookie 会失去 `HttpOnly`（`document.cookie` 无法创建 HttpOnly cookie，SW 转发时只能剥掉该属性）。若站点存在 XSS 风险且无法接受，改用下面的方案。

#### 备选：认证走源站

把认证接口排除在隧道外，浏览器原生携带 HttpOnly cookie：

```jsonc
"neverTunnel": ["/api/auth"]
```

这样最安全，但**所有业务接口都会先经隧道拿到 401，再由 SW 重放到源站**——功能正常，代价是每个请求走两次，P2P 实际上没有收益。除非你有额外手段让 Agent 持有会话（例如单独给它一份凭据），否则不建议。

| 方案 | P2P 收益 | 浏览器 cookie | 需要给 Agent 凭据 |
| --- | --- | --- | --- |
| Agent 自登录（推荐） | **完整** | 失去 HttpOnly | 否 |
| 认证走源站 | 无（每请求双跑） | 保留 HttpOnly | 否 |
| 认证走源站 + Agent 自持凭据 | 完整 | 保留 HttpOnly | **是** |

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

浏览器打开 `https://edge.example.com/`，应看到连接页 → 自动进入站点。之后在 DevTools 里看 `/api/*` 的响应头 `x-w2l`：

| `x-w2l` | 含义 |
| --- | --- |
| `tunnel` | 完整走了隧道（P2P 直连） |
| `401-fallback` | 隧道送到了，但上游要求登录，SW 重放走源站 |
| `fallback` | 交换失败，直接走源站 |

只有 `tunnel` 才算真正 P2P。若绝大多数是后两者，按「认证与会话」调整 `neverTunnel`。

> 不要用「有没有 `server` 头」判断——上游可能自己发 `server`，源站也会盖一个，这个信号两个方向都不可靠。

### Docker 配置要点

上面两条 `docker run` 是最小可用形态。以下是容器层面容易踩的地方。

#### 配置从哪来

两个容器都是**配置挂载进容器**，而不是打进镜像：

| 配置 | 容器内路径 | 谁读 | 怎么给 |
| --- | --- | --- | --- |
| `routes.yaml` | `/app/routes.yaml` | fdn（兜底）+ tunnelagent（隧道） | `-v` 挂载同一个文件 |
| `config.json` | `/app/dist/config.json` | 浏览器（SW） | **已打进镜像**，改它需要重建镜像 |

`routes.yaml` 是运行时挂载的，**改完 `docker restart` 即生效**，不必重建。
`config.json` 随前端资产构建，**必须重建镜像**（或用 `docker cp` 临时覆盖，不推荐）。

> 镜像里内置的 `routes.yaml` 只是占位模板（`app.example.com`）。不挂载真实路由表，兜底会 502。

#### 端口与网络

| 容器 | 网络 | 端口 | 说明 |
| --- | --- | --- | --- |
| `fdn` | bridge（默认） | `-p 127.0.0.1:8080:8080` | **绑 127.0.0.1**，只让本机 TLS 层访问 |
| `tunnelagent` | **`--network host`** | 不监听 | 必须 host，否则看不到宿主的内网路由 |

`tunnelagent` 用 host 网络的两个理由：

1. 它要访问内网服务（VPN、EasyTier/WireGuard 等虚拟网卡只存在于宿主机命名空间）
2. 它要广播正确的 ICE host candidate；bridge 下只有 `172.17.x.x`，对端根本连不上

如果确实不能用 host 网络，退路是给容器加内网路由，或用 `-advertise-cidr` 限定广播范围——但通常不值得，host 网络最省事。

#### 用 compose 编排

```yaml
# 公网侧 docker-compose.yml
services:
  fdn:
    image: rtcweb2lan/fdn
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./routes.yaml:/app/routes.yaml:ro
    command:
      - -addr
      - ":8080"
      - -static
      - /app/dist
      - -routes
      - /app/routes.yaml
```

```yaml
# 内网侧 docker-compose.yml
services:
  tunnelagent:
    image: rtcweb2lan/tunnelagent
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./routes.yaml:/app/routes.yaml:ro
    command:
      - -signal
      - wss://edge.example.com/__lan/ws
      - -room
      - default
      - -routes
      - /app/routes.yaml
      - -advertise-cidr
      - 10.0.0.0/8
      - -stun
      - stun:stun.example.com:3478
```

#### 健康检查

`fdn` 有可探测的端点，可以直接用于编排的 healthcheck：

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/__lan/config.json"]
  interval: 30s
  timeout: 5s
  retries: 3
```

`tunnelagent` **没有 HTTP 端口**，无法用 curl 探活。只能看日志或从 fdn 侧观察：

```bash
docker logs --since 1m tunnelagent | grep -E 'joined room|relay says ready'
```

#### 升级顺序

两端共用同一套帧协议，**必须同时升级**，否则隧道不工作（表现为所有请求回落兜底，功能仍可用）。

```bash
# 1. 先升内网侧（此时旧 fdn 与新 agent 协议不一致，隧道暂时不可用）
docker compose -f intranet/docker-compose.yml pull && docker compose -f intranet/docker-compose.yml up -d

# 2. 立刻升公网侧，隧道恢复
docker compose -f public/docker-compose.yml pull && docker compose -f public/docker-compose.yml up -d
```

重启 `fdn` 会中断信令，`tunnelagent` 会在几秒内自动重连。若没重连，重启它一次：

```bash
docker restart tunnelagent
```

#### 多架构

镜像默认按构建机架构产出。构建机与部署机不同（例如 Apple Silicon 构建、x86_64 部署）时必须交叉构建：

```bash
docker buildx build --platform linux/amd64 -f fdn/Dockerfile -t rtcweb2lan/fdn --load .
docker save rtcweb2lan/fdn -o fdn.tar
scp fdn.tar root@edge:/tmp/ && ssh root@edge 'docker load -i /tmp/fdn.tar'
```

验证架构：

```bash
docker image inspect rtcweb2lan/fdn --format '{{.Os}}/{{.Architecture}}'
```

#### 配置示例（routes.yaml）

```yaml
routes:
  - name: app
    kind: host
    host: app.example.com
    target: https://192.168.1.10:8443
    insecure_tls: true          # 内网自签证书
    # upstream_sni: app.internal  # vhost 靠 SNI 分流时指定

  - name: other
    kind: prefix
    host: app.example.com
    prefix: /other
    target: http://192.168.1.11:8080
```

#### 容器内没有 shell

运行镜像是 `alpine` 但**只装了 `ca-certificates` 和 `tzdata`**，没有 `sh`、`curl`、`tar`、`python3`。

这意味着：

- 不能用 `docker exec ... sh -c` 做运维
- 备份/替换文件走宿主机：`docker cp` 或挂载卷
- 健康检查用 `wget`（busybox 自带）而不是 `curl`

需要调试时，用临时容器挂同一个卷：

```bash
docker run --rm -it -v /etc/rtcweb2lan:/cfg alpine sh
```

### 首次访问的行为

| 状态 | 访问 `/` 时 |
| --- | --- |
| 全新浏览器（无 Service Worker） | **302 → 连接页**，建链成功后自动进入站点 |
| 刚连接过（`w2l_grace`，60 秒内） | 直接进站 |
| 用户点过「直接进入」（`w2l_direct`，30 分钟） | 直接进站 |
| API / 非 HTML / 深层路径 | 直接反代，不受影响 |

### 排障

| 现象 | 检查 |
| --- | --- |
| 连接页一直转，不进入 | `docker logs tunnelagent` 有无 `joined room`；信令 nginx 是否透传 `Upgrade` 头 |
| 站点能开但全部走兜底 | 浏览器 `config.json` 是否加载成功；`probePath` 是否落在 `apiPrefixes` 内 |
| `/__lan/ws` 返回 404 | `-prefix` 与实际路径不符 |
| 登录后立刻掉登录态 | 认证接口没走隧道（`neverTunnel` 应为空，见「认证与会话」）；或 Agent 重启导致其 jar 丢失，重新登录一次 |
| 所有请求都是 `401-fallback` | 同上；也可先看 `docker logs tunnelagent` 有无 `POST /api/auth/login` |
| 兜底 502 | `routes.yaml` 里没有匹配该 Host 的条目；看 `docker logs fdn` 的 `no route:` |

---

## 性能

一组内网服务在千兆内网、浏览器经公网 TLS 边缘接入的实测（30 次 API 调用）：

| 指标 | 数值 |
| --- | --- |
| P2P 命中率 | **30/30** |
| p50 | **31ms** |
| p95 | 42ms |
| 最大 | 58ms |
| 126 KB 响应 | 经隧道完整返回 |

对比「每请求开一条 DataChannel」的旧实现：命中率 0/25，p50 78ms，最大 3080ms——几乎全部静默回落兜底。

延迟大头在建链（约 2 秒，每个标签页一次），之后每个请求就是内网往返加隧道编解码开销。

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
| `fdn/web/src/peer.ts` | RTCPeerConnection 封装（发起/应答、通道工厂） |
| `fdn/web/src/mux.ts` / `mux-client.ts` | 多路复用帧协议（kind + stream id）/ 客户端实现（单通道承载多请求） |
| `fdn/web/src/channel.ts` | 分片、EOF 与背压的底层约定 |
| `fdn/web/src/data-plane.ts` / `port-transport.ts` | 页面侧数据面 / SW ↔ 页面 MessagePort 传输 |
| `fdn/web/src/http1.ts` / `router.ts` | HTTP/1.1 增量编解码 / Host + 前缀路由 |
| `fdn/web/src/cookie-relay.ts` | Set-Cookie → `document.cookie` 转换（剥 HttpOnly） |
| `fdn/web/src/overlay-policy.ts` | holder 对「状态查询无响应」的处置策略（不因一次问不到就杀健康连接） |
| `fdn/web/src/exchange-health.ts` | 连续交换失败计数，决定何时判定数据面已死 |
| `agent/internal/fdn/` | 公网边缘：静态资产 + 信令挂载 + 兜底反向代理 + 首次访问引导 |
| `agent/internal/tunnel/` | WebRTC 隧道与请求转发（tunnelagent） |
| `agent/internal/tunnel/mux.go` / `frame.go` | 多路复用服务端 / 与前端一致的帧协议 |
| `agent/internal/relay/` | 路由表与反向代理，两边共用 |
| `agent/internal/signaling/` | 信令服务端与客户端 |
| `agent/cmd/fdn/` / `agent/cmd/tunnelagent/` | 两个入口 |

---

## 已知限制

| 限制 | 原因 / 说明 |
| --- | --- |
| **WebSocket 无法走隧道** | Service Worker 的 fetch 拦截只覆盖 HTTP，`/socket.io` 等实时推送经隧道走不了。它仍可用——回落路径会正常代理（fdn 的兜底支持 WebSocket 升级），只是不经 P2P。 |
| **首次访问多等一次建链** | 冷浏览器没有 Service Worker，无法自己拦截。fdn 会把首次访问引导到连接页，建链完成后才进入站点（约 2 秒）。 |
| **内网页面不能再建 PWA** | 一个 origin 只能有一个控制 scope `/` 的 Service Worker，已被本项目占用，内网应用自身的 PWA worker 需禁用。 |
| **对称型 NAT 打洞失败** | 此时自动回落 fdn 的兜底反代；如需强制直连可自行部署 TURN。 |
| **SW 读不到任何浏览器 cookie** | Chromium 在 SW 的 fetch 事件里不提供 `Cookie` 头。隧道侧的会话必须由 Agent 自己持有（见「认证与会话」）。 |
| **两端协议耦合** | `fdn` 与 `tunnelagent` 共用同一套帧协议，**升级必须同时进行**，否则隧道无法工作。 |

---

## License

见仓库中的许可文件。