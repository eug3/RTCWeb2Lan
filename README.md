# RTCWeb2Lan

在浏览器里访问内网 web:**内网 web 零改造、地址栏 URL 全程不变、稳态流量 P2P 直连不经公网中转**(仅信令与首次静态资源走公网)。

```
浏览器                                 公网 VPS (1号机)                 内网
+----------------------------------+   +-----------------------+   +------------------+
| /            Sense SPA(nginx 静态)|   | nginx                 |   | 229: web2lan-   |
| /__lan/       初始化/连接页(信令容器)|-->| /__lan/* → 信令容器    |   |      agent(容器外 |
| Service Worker 拦截 /api/*        |   | 其余     → Sense 静态  |   |      systemd 服务)|
|        ↕ hidden holder iframe     |   +-----------------------+   |        ↓          |
| RTCPeerConnection ══ P2P DataChannel ════════════════════════>  230: Sense(容器)  |
+----------------------------------+        (信令只做 SDP/ICE 配对)   +------------------+
```

## 工作流程

1. **首次访问** 打开 `https://<host>/__lan/connect.html`(闪屏页):注册 Service Worker(scope `/`)→ 连信令房间 → WebRTC offer/answer → ICE → 把数据面(MessagePort)接入 SW → 探测验证 → 跳转 `/`。
2. 之后访问 `/` 时,SW 给页面注入一个隐藏 `holder.html` iframe 常驻持有 P2P 连接;页面间导航不再断链,断线自动重连。
3. **运行时**:SW 拦截 `/api/*`,HTTP/1.1 编码后经 DataChannel(一请求一通道)送到内网 Agent;Agent 按路由表反代到真实服务,响应原路回灌。**Cookie 双轨**:Agent 侧 cookiejar 管会话(隧道路径),SW 把 `Set-Cookie` 转发给 holder 用 `document.cookie` 落盘(回落路径)——浏览器无法直接在 SW 合成的 Response 上设置 Set-Cookie(Fetch 规范禁止),必须这么中转。
4. **优雅降级**:P2P 不可用或交换失败时,SW 立即停止拦截,请求回落 nginx 反代(站点照常可用);holder 持续重连,恢复后自动切回 P2P。

## 生产部署(当前实测拓扑)

| 位置 | 组件 | 说明 |
| --- | --- | --- |
| 1号机 10.1.1.1(公网 VPS) | nginx + `web2lan` 容器 | 容器 = web2lan-signal `-static /app/dist`(信令 `/__lan/ws` + 静态页);nginx 按路径分流,并把 `/api`、`/health` 反代到内网作回落 |
| 229 10.1.1.229 | `web2lan-agent`(systemd) | 出站连信令(不监听端口),`-routes routes.yaml -stun …`,经 EasyTier 转发到目标 |
| 230 10.1.1.230:9011 | Sense(GSDJSense 容器) | 真实内网目标,零改造 |

### 部署步骤

```bash
# 前端(dist/ → 1号机容器,文件服务按请求读盘,无需重启)
pnpm build && tar -cf /tmp/dist.tar -C dist .
scp /tmp/dist.tar root@10.1.1.1:/tmp/
ssh root@10.1.1.1 'mkdir -p /tmp/d && tar -xf /tmp/dist.tar -C /tmp/d && docker cp /tmp/d/. web2lan:/app/dist/'

# Agent(229)
cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o /tmp/agent ./cmd/web2lan-agent
scp /tmp/agent beijihu@10.1.1.229:/home/beijihu/web2lan/web2lan-agent.new
ssh beijihu@10.1.1.229 'cd ~/web2lan && mv web2lan-agent.new web2lan-agent && chmod +x web2lan-agent && sudo systemctl restart web2lan-agent'
```

### 验证要点(测试时盯住)

- **路径判别**:nginx 反代的响应带 `server: nginx/1.22.1`;隧道响应**无 `server` 头**——用这个头区分"走了 P2P"还是"走了回落",别只看状态码。
- 响应 URL 不得出现内网 IP(`10.1.1.x`)。
- Agent 日志(229 `~/web2lan/agent.log`)能看到 `GET/POST … -> http://10.1.1.230:9011` 即隧道转发生效。
- 状态行:`P2P 直连`(local=host/srflx)优于 `经 TURN 中转`;打洞失败自动 `回落反代`。

## 配置(解耦:改配置不改代码)

前端**不再写死任何内网地址或站点路径**。所有站点相关信息集中在 `public/config.json`(⚠️ 不要把密钥之类放这里;它随静态资源公开),**发布到 `dist/config.json`,改完刷新页面即生效,无需重新构建**。

```jsonc
{
  "routes": [
    { "kind": "host", "host": "sense.jshuaxin.net",
      "target": { "ipv4": "10.1.1.230", "port": 9011 } }
  ],
  "site": {
    "apiPrefixes": ["/api/"],              // 走隧道的路径前缀;其余静态资源留在 nginx
    "neverTunnel": ["/api/auth/session"],  // 永远走源站(需要浏览器 httpOnly cookie 的接口)
    "probePath": "/health"                 // 建链后验证隧道的探针;任意 HTTP 状态即视为通
  },
  "signaling": { "room": "lan", "stun": "stun:stun.chat.bilibili.com:3478" }
}
```

- **routes**:公网 Host/前缀 → 内网目标。`kind="host"` 整站路由,`kind="prefix"` 路径前缀路由。
- **site/***:站点行为。`probePath` 默认 `/`,建议改成轻量健康接口(别用慢的业务接口,否则健康隧道会被误判为死)。
- **signaling**:信令房间与 STUN(`stun: ""` 关闭 STUN,仅主机候选,适合纯内网)。
- 加载顺序:①`?config=<urlencoded JSON>` 查询参数(临时测试)> ②`config.json` > ③ 内置默认(不含内网地址)。
- 代码位置:`src/config.ts`(契约/默认值/校验)、`src/config-loader.ts`(加载并推给 SW)、`src/sw.ts`(按 config 决定拦哪些路径、路由到哪)。

## 本地开发

```bash
pnpm install
pnpm test          # 57 个 TS 单测
pnpm run test:go   # Go 单测
pnpm run dev:stack # 一键本地栈(信令 + Agent + 假内网服务,http://127.0.0.1:5273/)
```

对接真实内网(本机需在 EasyTier 网内):

```bash
./.dev-bin/signal -addr 127.0.0.1:8787
./.dev-bin/agent  -signal ws://127.0.0.1:8787/ws -room real -routes routes.yaml
npx vite --port 5273   # 打开 /?signal=…&room=real
```

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/sw.ts` | fetch 拦截、导航门(splash/holder 注入)、隧道交换、失败自愈、Set-Cookie 转发 |
| `src/nav-gate.ts` | `/` 的导航决策(connect-page / inject-holder / passthrough)与 holder 注入 |
| `src/connect.html` + `src/connect.ts` | 闪屏页:注册 SW、建链重试、跳转 |
| `src/holder.html` + `src/holder.ts` | 常驻 iframe:持有/重连数据面、健康检查、落地 Cookie |
| `src/connect-flow.ts` | 建链流程(信令→ICE→接入→验证)与 SW 控制消息 |
| `src/peer.ts` | RTCPeerConnection 封装(发起/应答、通道工厂) |
| `src/channel.ts` | 单通道收发约定(16KiB-1 分片、空消息 EOF、背压) |
| `src/data-plane.ts` | 页面侧数据面:交换队列 + 楔死通道重试 |
| `src/port-transport.ts` | SW↔页面 MessagePort 传输(含死端口超时) |
| `src/http1.ts` / `src/router.ts` | HTTP/1.1 增量编解码 / host+前缀路由(URL 保持不变) |
| `src/cookie-relay.ts` | Set-Cookie → document.cookie 转换(剥 HttpOnly) |
| `agent/` | Go:信令服务器(`web2lan-signal`)与内网 Agent(`web2lan-agent`,pion/webrtc v4) |

## 已知限制

- **WebSocket 不可代理**:内网页面依赖 `/socket.io` 等实时推送时,SW 帮不上忙(回落路径也仅覆盖 HTTP)。
- **引导鸡生蛋**:冷浏览器首次访问 `/` 没有 SW,只会看到 nginx 版站点;需先访问一次 `/__lan/connect.html`。
- **SCTP 首流偶发楔死**:个别连接的第一条 DataChannel 会开而不通;已用"6 秒宽限 + 换新通道重试 + Agent 15 秒读超时"缓解,根因待查。
- 对称型 NAT 下打洞会失败(自动回落);229 出口实测为受限锥形,双向打洞可行。
- 内网页面自身不能再注册 Service Worker(槽位被占,如 Angular ngsw 会与本 SW 竞争,holder 会自动夺回)。
