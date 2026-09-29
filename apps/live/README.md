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

需要 Windows 10/11 与 WebView2 Runtime。Rust 使用本目录 `src-tauri/rust-toolchain.toml` 的 `stable`。

安装包已改为 **embedBootstrapper**（内嵌 WebView2 引导程序），不再在安装时临时下载执行外部 bootstrapper。

### 调试包 vs 正式包

| 形态 | 说明 |
|------|------|
| `tauri dev` / 未签名 `release` | 本地调试用；360 等杀软**仍可能**启发式拦截，属预期 |
| 已 Authenticode 签名的 NSIS/MSI | 对外分发形态；需再配合 360 白名单提报 |

## Windows 代码签名（降低 360 / SmartScreen 误报）

签名**不是** Windows/Tauri 自带能力，需向受信任 CA 购买 **Authenticode 代码签名证书**（OV 或 EV）。自签证书只对本机有效，不能解决用户侧 360 误报。

常见渠道：DigiCert、Sectigo、GlobalSign、SSL.com，或国内代理售卖的同类代码签名证书（通常需企业营业执照）。新发证书私钥多要求放在 USB token / HSM。

配置示例（本机已安装证书后）：

```bat
set TAURI_SIGNING_PRIVATE_KEY=...
rem 或在 tauri.conf.json 的 bundle.windows 中配置 certificateThumbprint / signCommand
```

也可用 `signtool`：

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a "lumen-live.exe"
```

请对 **exe + NSIS/MSI** 一并签名，并带 RFC3161 时间戳。

本仓库**不内置**可用的公开发布证书。

## 360 误报说明

常见触发原因（本项目已主动规避行为指纹）：

- 未签名的新发布者 EXE/安装包
- 历史上曾有的 `powershell -ExecutionPolicy Bypass`、Chrome CDP `--remote-debugging-port` 等（**当前代码已移除**）

建议流程：

1. 使用签名后的正式安装包分发  
2. 到 [360 软件宝 / 开放平台](https://open.soft.360.cn/) 提交白名单  
3. 保持固定的 `productName`、`identifier`、`publisher`（当前为 Lumen MD / `com.lumenmd.live`）

用户若仍被隔离：在 360 中恢复文件并加入信任区；仅信任**已签名**的正式包。
