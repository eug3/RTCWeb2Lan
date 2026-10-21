# RTCWeb2Lan 工作约定

## 每次会话开始:先加载 openviking 记忆(用户指示,必须执行)

1. 读 `~/.openviking/ovcli.conf` 拿到 `url` 与 `api_key`(不要把 key 复制进代码或文档)。
2. 检索本项目记忆:
   ```bash
   curl -s -X POST "$URL/api/v1/search/find" \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"query":"RTCWeb2Lan 部署 运维","limit":8}'
   ```
   重点条目:`viking://user/beijihu/memories/entities/项目/RTCWeb2Lan_部署与运维.md`。
3. 有新结论(部署变更、排障结论)时用 `POST /api/v1/content/write` 写回记忆库。

## 部署快照(2026-10-21,详见 openviking 记忆)

- 前端 + web2lan-signal 信令:10.1.1.1(443 = Go 信令服务,`/healthz` 可探活)。
- 229(10.1.1.229):部署了代理(实测 magpie gateway :3425、LiteLLM :4000)。
- 真实内网目标:10.1.1.230:9011(Sense)。

## 本仓常用命令

```bash
pnpm test          # TS 单测
pnpm run test:go   # Go 单测
pnpm run dev:stack # 一键本地栈(假内网)
```
