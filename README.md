````markdown
# OpenAI 翻译调试面板

基于 Next.js App Router 的翻译调试工具，默认仅调用每日 2.5M token 免费额度的模型。后端接口部署在 Vercel，额度统计优先写入 Redis，并在每日 UTC 0 点自动重置；缺少 Redis 时自动退化为进程内存，方便开源使用和本地调试。

## 快速开始

1. 安装依赖（推荐使用 Bun）：

   ```bash
   bun install
   ```

2. 配置环境变量：在根目录创建 `.env.local`，至少包含：

   ```bash
   OPENAI_API_KEY=sk-xxxx
   # 可选：配置 Redis 以实现多实例额度共享
   REDIS_URL=redis://default:password@host:6379
   ```

3. 启动开发服务器：

   ```bash
   bun run dev
   ```

   浏览 [http://localhost:3000](http://localhost:3000) 查看页面。前端会每 5 秒轮询 `/api/quota` 并展示当前使用情况，超过额度后提示“请等待下一次北京时间 8 点再来”。

## 接口概览

- `POST /api/translate`
  - 请求体：`{ text, sourceLang?, targetLang?, model? }`
  - 仅允许 `src/config/models.ts` 中列出的免费模型。
  - 额度用尽返回 `429`，响应中包含最新 `quota` 信息。

- `GET /api/quota`
  - 返回今日累计用量、剩余额度、UTC 重置时间以及北京时间展示字段。

额度存储 key 以 `token-usage:` 为前缀，使用 Redis 时会自动设置过期时间（下一个 UTC 午夜）。未配置 Redis 时，使用内存 fallback，仅适用于单实例调试场景。

## 部署到 Vercel

1. 在 Vercel 项目设置中配置环境变量 `OPENAI_API_KEY`（必填）和 `REDIS_URL`（推荐）。
2. 依赖通过 `bun.lock` 固定版本；构建命令保持 `bun install && bun run build`。
3. 默认运行时为 Node.js（`runtime = "nodejs"`），无需额外配置即可使用。

## 贡献与开源

项目已考虑无 Redis 的开源场景，欢迎提交 PR：

- 新增模型时更新 `src/config/models.ts`。
- 调整额度策略可修改 `src/lib/quotaStore.ts`。
- 如需自定义提示语或前端行为，请在 `src/app/page.tsx` 中调整。
````
