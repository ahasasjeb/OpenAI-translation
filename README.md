````markdown
# OpenAI 翻译调试面板

基于 Next.js App Router 的翻译调试工具，默认仅调用每日 2.5M token 免费额度的模型。额度统计严格依赖 Redis：缺少 Redis 会导致接口直接返回 `503 redis_unavailable`，从而阻止翻译请求，确保额度不被错误重置。

## 快速开始

1. 安装依赖（推荐使用 Bun）：

   ```bash
   bun install
   ```

2. 配置环境变量：在根目录创建 `.env.local`，必须包含：

   ```bash
   OPENAI_API_KEY=sk-xxxx
   REDIS_URL=redis://default:password@host:6379
   ```

   > ⚠️ 未配置 `REDIS_URL` 时，接口会返回 `redis_unavailable`，前端按钮也会被禁用。

3. 启动开发服务器：

   ```bash
   bun run dev
   ```

   浏览 [http://localhost:3000](http://localhost:3000) 查看页面。前端每 5 秒轮询 `/api/quota`，展示今日额度；达到上限后显示“请等待下一次北京时间 8 点再来”。

## 接口概览

- `POST /api/translate`
  - 请求体：`{ text, sourceLang?, targetLang?, model? }`
  - 仅允许 `src/config/models.ts` 中列出的免费模型。
  - 额度用尽返回 `429`，响应包含最新 `quota`；Redis 不可用时返回 `503 redis_unavailable`。

- `GET /api/quota`
  - 返回今日累计用量、剩余额度、UTC 重置时间以及北京时间展示字段。
  - Redis 不可用时同样返回 `503 redis_unavailable`。

额度数据以 `token-usage:` 为前缀写入 Redis，并在下一次 UTC 午夜自动过期，可安全部署在 Serverless 环境下的多实例架构中。

## 部署到 Vercel

1. 在 Vercel 项目设置中配置 `OPENAI_API_KEY` 和 `REDIS_URL`。
2. 构建命令保持：

   ```bash
   bun install
   bun run build
   ```

3. 默认运行时为 Node.js（`runtime = "nodejs"`），无需额外配置。

## 贡献与开源

- 新增模型时更新 `src/config/models.ts`。
- 额度/Redis 逻辑位于 `src/lib/quotaStore.ts`。
- 前端交互位于 `src/app/page.tsx`。

欢迎提交 PR 改进 UI、校验逻辑或监控输出。
````
