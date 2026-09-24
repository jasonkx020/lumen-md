# Lumen MD 架构

## 双轨

| 轨道 | 入口 | 渲染 / 编辑 | 可信边界 |
|------|------|-------------|----------|
| **Live** | `apps/live`（Tauri 2） | Milkdown Crepe（contenteditable） | Rust 沙箱 FS IPC；前端仅编辑态 |
| **Classic** | `crates/lumen-app` / `lumen-cli` | egui 块编辑 + comrak 预览 | 全部业务在 Rust；无 WebView |

主产品为 Live。Classic 保留为 Win7 绿包与离线块编辑路径。

## Live 数据流

1. 打开：`open_workspace` / `open_absolute_file` → 沙箱内 `fs_read` → 前端 `setMarkdown`
2. 编辑：Crepe 文档为真理；`markdownUpdated` 驱动脏标记与大纲
3. 保存：`getMarkdown()` → `fs_write`（tmp + flush + rename 原子写）
4. 拖放：`onDragDropEvent` → 打开文件夹或 md

安全：路径沙箱拒绝 `..` / 绝对逃逸；CSP `default-src 'self'`；文件软上限 8 MiB。

## Classic 威胁模型

| 资产 | 威胁 | 缓解 |
|------|------|------|
| 磁盘文件 | 路径逃逸读写 | `Workspace::resolve` 拒绝 `..` / 绝对路径；canonicalize 前缀校验 |
| 磁盘文件 | 写入中断损坏 | tmp + flush + rename 原子写 |
| 用户数据 | 远程代码执行 | 无 WebView；HTML 块仅等宽转义展示；禁 http(s) 图片 |
| 大文件 | DoS / 卡死 | 8MiB 软上限；预览防抖 + 块虚拟化 |

可信边界：Classic 业务逻辑在 Rust（`lumen-core` / `lumen-render`）。egui 仅 UI。

## Classic 渲染管线

1. 源码变更 → 防抖 120ms  
2. `comrak` 解析 → `RenderModel`（指纹缓存）  
3. 预览 `ScrollArea` 按估计高度跳过离屏块（±1 屏）  
4. 行内 `LayoutJob`；本地图片惰性解码（沙箱内路径）

## Crate / 目录

- `apps/live`：Tauri Live 主产品（沙箱实现于 `src-tauri/src/sandbox_fs.rs`，与 lumen-core 同思路）
- `crates/lumen-core`：Classic 沙箱 FS、方言、校验  
- `crates/lumen-render`：AST→块、绘制、虚拟化  
- `crates/lumen-app`：Classic 壳 + IME  
- `crates/lumen-cli`：Classic `lumen.exe`

## 平台说明

- **Live**：Windows 10/11 + WebView2；不承诺 Win7  
- **Classic**：可用 crt-static 绿包跑 Win7 SP1 x64
