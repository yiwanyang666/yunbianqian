# 云便签 (CloudNote)

高颜值、极轻占用、免登录、支持 **真·端到端零知识加密** 的在线云便签与跨设备文件中转站。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yc696/yunbianqian)

> **零配置一键上云**：点击上方 **Deploy to Cloudflare** 按钮即可自动创建 Cloudflare Worker + 免费 D1 数据库并部署静态资源，**无需绑定信用卡、无需手动建表、无需配置 R2**，约 1 分钟即可拥有全球边缘加速的专属云便签。

---

## 核心特性

- **极简高颜值纸感 UI**：内置「晨光纸韵」与「暗夜曜石」双主题，支持专注纸张 / 宽屏画布、Markdown 编辑 / 分屏 / 预览三视图。
- **双模式端到端零知识加密（Web Crypto API）**：
  - **密码端到端加密**：浏览器本地执行 `PBKDF2-HMAC-SHA256`（600,000 次迭代）+ `HKDF-SHA256` 域隔离，派生独立的加密密钥（永不离开浏览器）与鉴权令牌；数据采用 `AES-256-GCM` + 每次保存全新 96-bit 随机 IV + `AAD` 路径绑定防密文替换。
  - **链接密钥 E2EE (`#k=...`)**：一键生成 256-bit 随机密钥藏于 URL 片段（浏览器不会将 `#` 后的片段发送给服务器），零密码即可端到端加密。
  - **便捷跨端同步模式**：兼容经典 `/<自定义路径>` 免密直达体验，落盘仍由服务端 `AES-256-GCM` 静态加密，并可随时一键升级为端到端加密。
- **零知识密文检查器**：随时查看服务端实际保存的原始 Base64 密文、IV、Salt 与 AAD。
- **加密文件中转**：支持拖拽上传任意格式文件，E2EE 模式下文件名与内容均在本地加密后再传输（Cloudflare D1 免费版分片存储支持单文件 ≤ 10 MB；Node.js 自托管流式读写支持单文件 ≤ 25 MB）。
- **本地二维码分享**：100% 在本机浏览器 Canvas 生成，不向任何第三方接口泄露链接与 `#k=` 密钥。
- **防误触阅后即焚 & 自动过期 & 实时同步**：密码校验通过后才销毁，防止输错密码或链接预览误删；支持 10 分钟 ~ 30 天定时过期与只读保护。
- **极致轻量化**：前端基于 Preact + 全模块按需懒加载（首页首屏 JS 仅 ~16 KB gzip）；Node.js 自托管服务端 0 第三方依赖（仅需 `node:http` + `node:sqlite`）。
- **SEO 与隐私兼顾**：首页内置完整 Meta / Open Graph / JSON-LD 结构化数据、`robots.txt` 与 `sitemap.xml`；用户私密便签路径自动动态注入 `noindex, nofollow`，防止搜索引擎收录私人内容。

---

## 部署方式

### 方式一：Cloudflare Workers 一键部署（推荐，完全免费）

直接点击页面顶部的 **Deploy to Cloudflare** 按钮即可。Cloudflare 会自动：
1. 克隆仓库并执行 `npm run build` 构建前端；
2. 自动创建并绑定免费 **D1 SQLite 数据库**（`yunbianqian-db`）；
3. 首次访问 API 时自动初始化数据表结构，立即生效。

*(可选)* 如需为「便捷免密模式」自定义服务端落盘静态加密密钥，可在 Cloudflare Worker 设置的 Variables & Secrets 中添加一个随机 64 位十六进制密钥 `SERVER_MASTER_KEY`。

### 方式二：零依赖 Node.js 自托管（适合轻量 VPS / 本地运行）

需要 Node.js 22.5+（推荐 Node 24，内置 `node:sqlite`）：

```bash
# 1. 安装构建依赖
npm install

# 2. 构建前端并预压缩 Brotli / Gzip
npm run build:node

# 3. 启动极轻服务（默认端口 3456，V8 堆上限 64MB）
npm start
```

生产环境下只需保留 `server/` 与 `dist/` 两个目录即可直接 `node --max-old-space-size=64 server/index.js` 运行，无需 `node_modules`。

#### 可选环境变量（Node.js 模式）
- `PORT`：监听端口，默认 `3456`
- `HOST`：监听地址，默认 `0.0.0.0`
- `CIPHERNOTE_MASTER_KEY`：64 位十六进制（32 字节）服务端静态加密主密钥
