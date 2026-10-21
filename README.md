# EasyTier Web2Lan

在浏览器里访问内网 web，**内网 web 本身不需要任何改造**，且地址栏 URL 全程不变。

## 设计要点

用户访问一个静态初始化页（只需一次），它注册 Service Worker 并建立 P2P 链路；
此后访问内网域名时，SW 拦截请求、经 overlay 直达内网 web，公网不再参与。

```
浏览器                        公网 VPS                    内网
+--------------+             +----------+             +--------------+
| 初始化页(静态) |---一次----->| 仅静态文件 |             |              |
|      |       |             +----------+             |  普通 web    |
| Service Worker|<-------- P2P / overlay 直连 -------->|  (零改造)    |
+--------------+                                       +--------------+
```

关键约束与推导见 [docs/架构决策.md](docs/架构决策.md)。

## 当前进度

| 层 | 状态 |
| --- | --- |
| URL 保持不变的请求路由 | 已实现，并在真实 Chrome 中验证 |
| Service Worker 拦截 + Response 回灌 | 已实现，e2e 通过 |
| HTTP/1.1 编解码 | Content-Length / chunked / EOF 三种定界，22 个单测 |
| 传输接缝（OverlayTransport） | 接口已定，mock 实现可用 |
| 对接 EasyTier / WebRTC 真实数据面 | 等待架构决策 |

## 快速开始

```bash
npm install
npm test        # 22 个单测
npm run dev     # http://127.0.0.1:5273/
```

## 代码地图

| 文件 | 职责 |
| --- | --- |
| src/router.ts | 按 host / path 前缀解析出 overlay 目标，**不改动 URL** |
| src/sw.ts | fetch 拦截与 Response 构造 |
| src/http1.ts | HTTP/1.1 帧编解码（增量解析） |
| src/transport.ts | 传输接缝：connect(authority) -> {write, read, close} |
| src/easytier-transport.ts | 对接官方 connectTcp 的适配器骨架 |
| src/mock-transport.ts | 无网络假对端，用于回归 |

## 已知坑（实测踩到的）

1. **SW scope 限制**：SW 的最大 scope 默认等于其脚本所在目录。dev 下脚本在 /src/sw.ts，注册 scope: "/" 会抛 SecurityError。解决：由 Vite 注入 Service-Worker-Allowed: / 响应头。
2. **SPA fallback 吞掉 sw.js**：dev 下请求 /sw.js 会拿到 index.html（HTML），导致 MIME 错误注册失败。解决：dev 注册 /src/sw.ts，生产注册 /sw.js。
3. **@easytier/* 未发布 npm**，接入须 vendor 源码并用 wasm32-wasip1 构建。