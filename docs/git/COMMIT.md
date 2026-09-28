# Git 提交说明规范

本仓库采用 **Google 工程实践习惯 + Conventional Commits**。  
模板文件：[`.gitmessage`](../../.gitmessage)  
格式钩子：[`.githooks/commit-msg`](../../.githooks/commit-msg)（不合规则**拒绝提交**）

## 本机启用（每个克隆执行一次）

Git **不会**把模板随仓库自动生效，需在本机配置一次。仓库根目录执行：

```bat
git config commit.template .gitmessage
git config core.hooksPath .githooks
```

或一键：

```bat
.\scripts\setup-git.bat
```

- `commit.template`：仅在 **`git commit` 且不带 `-m`/`-F`**、由编辑器打开说明时预填模板  
- Cursor / VS Code 源码管理里直接填「消息」再提交，等价于 `git commit -m`，**不会**出现模板正文  
- `core.hooksPath`：启用版本库内钩子；**未设置则不会拦截不合规说明**

仅影响当前仓库，勿使用 `--global`（除非你明确需要全局统一）。

自检钩子（可选）：

```bat
"C:\Program Files\Git\bin\bash.exe" .githooks/test-commit-msg.sh
```

## 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

| 部分 | 要求 |
|------|------|
| type | 必填，见下表 |
| scope | 可选，小写，如 `live` / `export` |
| subject | 祈使语气短句；整行 ≤72 字符；**不以** `.` / `。` 结尾 |
| body | 可选；与首行之间**必须空一行**；写清为什么改 |
| footer | 可选，如 `Fixes: #123` |

### type

| type | 含义 |
|------|------|
| feat | 新功能 |
| fix | 缺陷修复 |
| docs | 文档 |
| style | 格式（不影响逻辑） |
| refactor | 重构 |
| perf | 性能 |
| test | 测试 |
| build | 构建 / 依赖 |
| ci | CI |
| chore | 杂项 |
| revert | 回滚 |

### scope 示例

`live` · `classic` · `export` · `ai` · `docs`

## 示例

好：

```
feat(live): add export progress overlay

Show a simulated progress bar after the save path is chosen so
users know PDF/DOCX export is still running.
```

```
fix(export): align PDF table borders with horizontal rules
```

坏（会被钩子拒绝）：

```
update stuff
```

```
fix: trailing period.
```

```
feat(live): missing blank line before body
Body starts immediately.
```

## 自动放行

Git 生成的下列首行不校验类型前缀：

- `Merge ...`
- `Revert "..."`
