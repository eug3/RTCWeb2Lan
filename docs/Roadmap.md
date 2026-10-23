# Roadmap

## 已完成

- [x] Service Worker 拦截与 Response 回灌（scope `/`，URL 全程不变）
- [x] HTTP/1.1 编解码（Content-Length / chunked / EOF 三种定界）
- [x] 自建 WebRTC DataChannel 数据面（pion/webrtc + 浏览器原生 RTCPeerConnection）
- [x] **单通道多路复用**：帧头 `kind + stream id`，替代「一请求一通道」
- [x] 内网 Agent：路由表 + 反向代理 + 每 target 的 cookie jar
- [x] 认证走隧道：Agent 自己登录并持有会话，业务接口全程 P2P
- [x] 兜底反代内置进 `fdn`，取代宿主机 nginx vhost
- [x] 首次访问引导：无 Service Worker 时由 `fdn` 302 到连接页
- [x] 优雅降级：连续三次交换失败才判定数据面已死
- [x] 连接页（明亮紧凑）与 holder 常驻 iframe
- [x] 双镜像：`fdn`（公网边缘）与 `tunnelagent`（内网）

## 待办

- [ ] 大文件 / 流式响应（当前整包缓冲，`ReadableStream` 可省内存）
- [ ] 并发上限与更细的背压（当前对 SW 侧串行）
- [ ] WebSocket 走隧道（受 Service Worker API 限制，见「已知限制」）
- [ ] 多站点部署的配置校验工具（当前靠 `fdn` 日志的 `no route:`）

## 已否决的方向

| 方向 | 为什么否决 |
| --- | --- |
| vendored `easytier-js` + WASM | 浏览器内 WASM overlay 通常禁用 P2P，只能经 WebSocket 中继，达不到「稳态流量不过公网」。改为自建 WebRTC 数据面。 |
| 一请求一 DataChannel | 每请求一次 DCEP 握手，Chrome/pion 经常完不成；实测命中率 0/25。改为单通道多路复用。 |
| 认证绕开隧道（`neverTunnel: ["/api/auth"]`） | 会让每个业务请求先经隧道拿 401 再重放源站，P2P 无收益。改为 Agent 自登录。 |
