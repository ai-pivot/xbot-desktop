# xbot desktop（Tauri 2 重写版）

**全新界面，不包装旧 Web UI。** 旧 WPF 客户端保留在 `../src/`，这里是独立的 Tauri 2 应用。

```
React 19 + TypeScript + Vite
        │  invoke / event
        ▼
Tauri 2 (Rust)
  ├─ reqwest：登录、Cookie、REST、RPC、文件上传
  └─ SSE 任务：/api/sse → app.emit("xbot-sse")
        │
        ▼
xbot server（web channel，零改动）
```

## 为什么是 Tauri

- Windows 使用系统 **WebView2**，安装包 12 MB（旧 WPF 68 MB），内存更低。
- 前端可以自由重写（本项目使用 React + 自定义 CSS + lucide 图标 + Shiki 代码高亮）。
- Rust 侧负责 Cookie/SSE/文件上传，前端不直接跨域请求，避免 CORS / Cookie 差异。
- 相比 Electron 不捆绑 Chromium；相比 WPF FlowDocument，Markdown/代码高亮/表格生态成熟得多。

## 功能（MVP）

- 登录 / 首个账号注册 / Cookie 持久化
- 会话树（含 SubAgent）、搜索、新建、重命名、Fork、删除
- 新建会话支持服务端目录树选择工作目录（懒加载、可输入路径、上一级/根目录）
- 历史分页 + SSE 流式输出
- Markdown（GFM）、深色代码块 + 复制按钮
- 思考过程折叠、工具卡片（参数/输出）、AskUser、待发队列
- 停止生成、模型切换、上下文预算
- 设置：默认模型、订阅/模型启用、智能体参数、工具开关

未实现：Tauri Updater 签名更新（当前是自定义 HTTPS + SHA256 更新）、GenUI 插件渲染、`!cmd` 历史行恢复、虚拟列表、Mica 自绘标题栏。

## 开发

前置：Node 20+、Rust 1.90+、Windows 需 MSVC Build Tools、WebView2 Runtime（Win11 自带）。

```bash
cd tauri
npm install
npm run tauri dev     # 需要桌面会话，WebView2 才能创建窗口
```

## 构建（Windows）

```bash
npm install
npm run build
cd src-tauri
cargo build --release --features custom-protocol
# 产物：src-tauri/target/release/xbot-desktop.exe
```

⚠️ **`--features custom-protocol` 不能省**。裸 `cargo build --release` 会走 Tauri 的 dev 模式，
把 `http://localhost:1420` 嵌进 exe（表现为启动后直接连 localhost / 页面空白）。

也可以使用 Tauri CLI（会自动设置 custom-protocol，但需要完整 npm 依赖）：

```bash
npm run tauri build -- --no-bundle
```

> 从 SSH/服务会话启动 GUI 会报 `WebView2 error: 无效的窗口句柄`；这是没有交互桌面导致的，必须在登录的桌面会话里双击运行。

## 更新机制

0.1.2 起接入应用内更新：

- 清单：`https://minio.cjiw.site/uploads/share/xbot-desktop/tauri/latest.json`
  ```json
  { "version": "0.1.3", "url": "https://.../xbot-desktop-tauri-0.1.3-win-x64.exe",
    "sha256": "...", "notes": "..." }
  ```
- 登录后自动检查；「设置 → 关于 → 检查更新」可手动检查。
- 发现新版本后聊天页顶部出现提示；弹窗里下载（带进度）、校验 SHA256、退出后由 `.cmd` 等待进程退出、替换 exe 并重启。
- 0.1.2 是第一个带更新器的版本，0.1.25 是当前最新版；0.1.24 可直接验证更新到 0.1.25。
- 目前是**自定义便携版更新**（HTTPS + SHA256），没有 Tauri Updater 的签名校验。

## 数据目录

`%APPDATA%\site.cjiw.xbot.desktop\session.json`（服务端地址 + 会话 Cookie）

## 目录

```
src/                 React UI
  components/        登录 / 侧栏 / 聊天 / 工具卡 / 设置
  chat/reducer.ts    聊天状态机（纯函数，Vitest 覆盖）
  state/store.ts     Zustand 应用状态 + SSE 桥
src-tauri/           Rust 后端
  src/api.rs         登录/Cookie/REST/RPC/上传命令
  src/sse.rs         SSE 解析 + 重连 + 事件桥
  src/state.rs       AppState / CookieJar
```

## CI

两个 GitHub Actions 工作流（`.github/workflows/`）：

- **check**：push / PR 到 `main` 时执行
  - `frontend`：`npm ci` → `npm test` → `npm run build`
  - `rust`：装 Tauri 的 Ubuntu 依赖后 `cargo check --release --features custom-protocol`
- **release**：推送 `v*` tag（或手动 dispatch 指定已存在的 tag）时执行
  - 校验 tag 与 `package.json` 版本一致
  - 矩阵构建三个平台：
    | 平台 | Runner | 产物 |
    |---|---|---|
    | Windows x64 | `windows-latest` | `xbot-desktop-tauri-<ver>-win-x64.exe`（便携版，供自动更新） |
    | macOS arm64 | `macos-14` | `xbot-desktop-tauri-<ver>-macos-arm64.dmg` |
    | Linux amd64 | `ubuntu-22.04` | `xbot-desktop-tauri-<ver>-linux-amd64.deb` |
  - 全部产物 + `SHA256SUMS.txt` 附加到 GitHub Release
  - 若仓库配置了下列 secrets，则同时上传三个产物到 MinIO 并更新 `latest.json`（仍指向 Windows exe）：

| Secret | 说明 |
|---|---|
| `MINIO_ENDPOINT` | 例如 `https://minio.cjiw.site` |
| `MINIO_ACCESS_KEY` | MinIO access key |
| `MINIO_SECRET_KEY` | MinIO secret key |
| `MINIO_BUCKET` | 例如 `uploads` |
| `MINIO_PREFIX` | 例如 `share/xbot-desktop/tauri` |

发版流程：

```bash
# 先把三处版本号改成同一个（package.json / tauri.conf.json / Cargo.toml）
git tag v0.1.25 && git push origin v0.1.25
```

## 验证

- `npm run build`：TypeScript + Vite 构建通过
- `npm test`：19 个测试通过（含缓存、rewind、跨会话串台回归测试）
- `cargo check` / `cargo build --release`：Windows 原生编译通过
- CI：`check` 工作流覆盖前端测试/构建与 `cargo check`
