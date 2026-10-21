# Roadmap

## Phase 1 — SW 拦截骨架（已完成）

- [x] overlay URL 方案 `/__et__/<ip>[:port]/<path>`
- [x] HTTP/1.1 编解码（Content-Length / chunked / EOF 三种定界）
- [x] Service Worker fetch 拦截与 Response 回灌
- [x] mock transport，19 个单测
- [x] 真实 Chrome 中验证注册与拦截

## Phase 2 — 接真实数据面

- [ ] 以子模块 vendored `easytier-js`，从源码构建 WASM（需 `wasm32-wasip1`，本机已装）
- [ ] `createEasyTierTransport` 接上 `connectTcp`
- [ ] 主线程 ↔ SW 的 MessagePort 通道（SW 不能直接持有 WASM 实例时）
- [ ] 连接复用（keep-alive），去掉每请求一条流

## Phase 3 — 工程化

- [ ] 大文件 / 流式响应（`ReadableStream` 不缓冲整包）
- [ ] 并发上限与背压
- [ ] 门户侧配置 UI（选择目标网段 / 节点）
- [ ] 公网中继（可用官方 `@easytier/cloudflare`）

## 待决策

- **传输层**：官方走 WebSocket 中继；自建 WebRTC DataChannel 等于 fork EasyTier 传输层，
  工作量差一个数量级，需单独评估收益。
- **WASM 实例归属**：SW 是单线程且可能被终止，WASM 实例大概率应放在页面/SharedWorker，
  SW 只做协议转换与转发。
