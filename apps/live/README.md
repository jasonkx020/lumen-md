# Lumen MD Live

真 Typora 级所见即所得 Markdown 编辑器（Tauri 2 + Milkdown Crepe）。

## 开发

```bat
npm install
npm run tauri dev
```

## 发布

```bat
npm run tauri build
```

产物：

- `src-tauri\target\release\lumen-live.exe`
- `src-tauri\target\release\bundle\nsis\` / `msi\`

需要 Windows 10/11 与 WebView2。Rust 使用本目录 `src-tauri/rust-toolchain.toml` 的 `stable`。
