# Lumen MD

双轨产品：

| 产品 | 技术 | 平台 | 交互 |
|------|------|------|------|
| **Live（主产品）** | Tauri 2 + WebView + Milkdown Crepe | **Windows / macOS / Linux** | 真所见即所得（边看边写） |
| **Classic（可选）** | egui + comrak | Win7 绿包 / 10 / 11 | 块级编辑 + 源码预览 |

## Live（推荐）

### 开发

```bash
cd apps/live
npm install
npm run tauri dev
```

Windows 也可用：

```bat
cd apps\live
npm install
npm run tauri dev
```

### 发布构建

```bash
cd apps/live
npm run tauri build
```

产物目录：`apps/live/src-tauri/target/release/` 与 `bundle/`：

| 平台 | 常见产物 |
|------|----------|
| Windows | NSIS / MSI（需 WebView2 Runtime） |
| macOS | `.app` / `.dmg` |
| Linux | `.deb` / `.rpm` / AppImage（需 WebKitGTK） |

Live 使用独立 `stable` Rust 工具链（见 `apps/live/src-tauri/rust-toolchain.toml`），不占用仓库根 `1.77.2`（供 Classic）。

### 依赖提示

- **Windows**：WebView2；PDF 导出可用 Edge/Chrome，或 LibreOffice / Word
- **macOS**：Xcode CLT；PDF 导出可用 Chrome / Edge / Chromium，或 LibreOffice
- **Linux**：`webkit2gtk` 等 Tauri 系统依赖；PDF 导出可用 Chromium/Chrome/Edge，或 LibreOffice；API Key 走 Secret Service（如 gnome-keyring）

### 快捷键

- `Ctrl/⌘+O` 打开文件夹 · `Ctrl/⌘+S` 保存 · `Ctrl/⌘+/` 源代码模式
- `Ctrl/⌘+B` / `Ctrl/⌘+I` 加粗/斜体（编辑器内）

## Classic（Win7 绿包）

```bat
rustup run 1.77.2 cargo build -p lumen-cli --release
pack-green.bat
```

产物：`dist\lumen.exe`（crt-static）。详见 `crates/lumen-app`。

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
