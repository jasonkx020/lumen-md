# Lumen MD

双轨产品：

| 产品 | 技术 | 平台 | 交互 |
|------|------|------|------|
| **Live（主产品）** | Tauri 2 + WebView2 + Milkdown Crepe | **Windows 10/11** | 真所见即所得（边看边写） |
| **Classic（可选）** | egui + comrak | Win7 绿包 / 10 / 11 | 块级编辑 + 源码预览 |

## Live（推荐）

```bat
cd apps\live
npm install
npm run tauri dev
```

发布构建：

```bat
cd apps\live
npm run tauri build
```

产物目录：`apps\live\src-tauri\target\release\`（exe）与 `apps\live\src-tauri\target\release\bundle\`（NSIS/MSI）。

要求：Windows 10/11 + [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。Live 使用独立 `stable` Rust 工具链（见 `apps/live/src-tauri/rust-toolchain.toml`），不占用仓库根 `1.77.2`（供 Classic）。

### 快捷键

- `Ctrl+O` 打开文件夹 · `Ctrl+S` 保存 · `Ctrl+/` 源代码模式
- `Ctrl+B` / `Ctrl+I` 加粗/斜体（编辑器内）

## Classic（Win7 绿包）

```bat
rustup run 1.77.2 cargo build -p lumen-cli --release
pack-green.bat
```

产物：`dist\lumen.exe`（crt-static）。详见 `crates/lumen-app`。

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
