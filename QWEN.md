# Qwen Code 项目上下文

本文件提供了项目上下文信息，用于指导未来的交互。

## 项目概述

这是一个基于 Next.js App Router 的 OpenAI 翻译调试工具。其主要功能是提供一个用户界面来调用 OpenAI 翻译 API，同时通过 Redis 跟踪每日的 token 使用量，确保不超过免费的 2.5M token 额度。项目的架构设计为在 Serverless 环境（如 Vercel）中部署时，通过 Redis 实现多实例间的额度状态同步。

### 核心特点
- **额度限制**：严格依赖 Redis 统计每日 2.5M token 免费额度的使用情况。如果 Redis 不可用，API 会返回 `503 redis_unavailable` 错误，从而阻止翻译请求。
- **前端界面**：提供一个基于 React 的用户界面，允许用户输入文本、选择模型和语言，并显示实时的额度使用情况（每 5 秒轮询一次 `/api/quota`）。
- **流式响应**：翻译结果通过 Server-Sent Events (SSE) 以流式 NDJSON 格式返回给前端，提供更流畅的用户体验。
- **Token 预估**：前端会对输入文本进行 token 预估，以帮助用户了解请求是否会超出剩余额度。

## 技术栈

- **前端框架**: Next.js 15.5.4 (使用 App Router)
- **语言**: TypeScript, React 19.1.0
- **样式**: Tailwind CSS 4
- **API 客户端**: OpenAI API 客户端 (openai@^5.23.1)
- **缓存/会话**: Redis (redis@^5.8.2)
- **Token 计算**: tiktoken (tiktoken@^1.0.22) 用于精确的 token 预估
- **构建工具**: Bun (推荐使用)

## 项目结构

```
E:\OpenAI翻译\
├── .next/                 # Next.js 构建输出目录
├── node_modules/          # Node.js 依赖包
├── public/                # 静态资源目录
├── src/                   # 源代码目录
│   ├── app/               # Next.js App Router 页面和路由
│   │   ├── api/           # API 路由 (translate, quota)
│   │   ├── globals.css    # 全局样式
│   │   ├── layout.tsx     # 布局组件
│   │   └── page.tsx       # 主页面组件（翻译界面）
│   ├── config/            # 配置文件
│   │   └── models.ts      # 支持的模型列表
│   └── lib/               # 通用工具库
│       ├── quotaStore.ts  # 额度与 Redis 交互逻辑
│       └── tokenEstimator.ts # Token 预估逻辑
├── package.json           # 项目依赖和脚本
├── next.config.ts         # Next.js 配置
├── tsconfig.json          # TypeScript 配置
├── bun.lock               # Bun 锁文件
├── vercel.json            # Vercel 部署配置
├── README.md              # 项目说明
└── 其他配置文件 (gitignore, eslint, postcss 等)
```

## 关键功能模块

1. **API 路由 (`src/app/api/`)**:
   - `/api/translate`: 处理翻译请求，仅允许配置文件中列出的免费模型。返回流式翻译结果和最终的 token 使用情况。
   - `/api/quota`: 获取当前的 token 使用额度信息。

2. **额度管理 (`src/lib/quotaStore.ts`)**:
   - 负责与 Redis 交互，记录和检索每日的 token 使用量。
   - 额度数据在 UTC 午夜（北京时间 8 点）自动过期。

3. **前端页面 (`src/app/page.tsx`)**:
   - 提供翻译界面，包含源文本输入、目标文本输出、模型和语言选择。
   - 实现了对 `/api/quota` 的轮询，实时显示额度状态。
   - 通过 SSE 接收 `/api/translate` 的流式响应，并将翻译结果逐步显示。

4. **模型配置 (`src/config/models.ts`)**:
   - 定义允许使用的 OpenAI 模型列表及其标签。

## 开发/运行指令

1. **安装依赖**: `bun install`
2. **本地开发**:
   - 设置环境变量 `OPENAI_API_KEY` 和 `REDIS_URL`（在 `.env.local` 中）
   - 运行 `bun run dev` 启动开发服务器
   - 访问 [http://localhost:3000](http://localhost:3000)
3. **构建**: `bun run build`
4. **启动生产服务器**: `bun run start`

## 部署

项目已配置为可在 Vercel 上部署。需要在 Vercel 项目设置中配置 `OPENAI_API_KEY` 和 `REDIS_URL` 环境变量。

## 开发约定

- 代码使用 TypeScript 编写，遵循严格的类型检查。
- 代码风格遵循 ESLint 和 Prettier 规范（通过配置文件定义）。
- 使用相对路径导入（`@/*` 指向 `./src/*`）。