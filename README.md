# context-cache

**简体中文** | [English](./README.en.md)

**Antigravity 原生上下文缓存、多 Agent 实时遥测与跨会话记忆插件（MCP App）**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/Runtime%20Deps-0-brightgreen.svg)](#架构与设计原则)

`context-cache` 是为 **Google Antigravity** 打造的原生 MCP App 观测与跨会话记忆插件，集 **上下文构成透视、主/子 Agent 实时 TPS 与缓存击穿归因、多对话自动跟随与跨视图联动、左侧边栏一键无框独立悬浮窗、Git 感知跨会话记忆库与双视图交接胶囊、抗宿主更新自愈底座** 于一体。

**核心目标：实时监控 0 模型 Token 消耗、对业务代码仓库零写入污染、Antigravity 升级改版不崩不丢数据。**

> [!NOTE]
> **已知边界说明**
> - **首字延迟（TTFT）**：官方 `transcript.jsonl` 暂未暴露流式 TTFT，调用明细中的耗时列如实展示**单步模型耗时**（已预留 `ttft_ms` / `ttftMs` 字段兼容，未来官方补充后自动切换）。
> - **多对话自动跟随**：只要在对话 2 / 3 新建或发送任意消息，Hook 会第一时间记录活跃会话并让右侧边栏与独立悬浮窗自动跟随切换（含对应项目 Git 分支与记忆库）；若仅鼠标点选旧对话浏览（未发消息），在任一面板顶部下拉框点选即可让所有监控视图同步联动。
> - **额度模块**：由于 Antigravity 暂未提供公开额度查询 API，v1.1.0 起界面已隐藏「额度」页（核心代码与 `QuotaProvider` 扩展口仍完整保留在源码中，待官方接口开放后可无痛启用）。

---

## 核心特性

### 1. 上下文构成透视（Context Inspector）
- 精确对齐当前会话 `input_tokens + cache_read_tokens` 与模型窗口上限，实时展示占比与剩余空间。
- 自动拆解 `Messages`、`System baseline`、`MCP tools`（区分常驻与 `deferred` 懒加载工具）、`Skills`、`Memory & Rules`、`Custom agents` 六大构成。
- **膨胀归因体检**：自动识别前 3 大上下文占用来源，在占用超过警戒线（默认 `75%`）或单一 MCP Server 过重（`>= 15K` tokens）时给出本地零消耗提示。

### 2. 主 / 子 Agent 实时调用明细与 TPS 监控（Live Calls & Telemetry）
- 自动识别主对话 `transcript.jsonl` 中的 `invoke_subagent` 调用并追踪所有子 Agent（编号 `主`、`子1`、`子2`…），支持按步查看、按 Agent / 模型维度汇总与多维筛选。
- **双源计时与吞吐**：优先使用 `PreInvocation` → `PostInvocation` 实测 `hook_ms`，缺失时平滑回退至 `hybrid_tool_split` / `transcript_fallback`。
- **前缀缓存击穿自动归因**：自动区分 `model_changed`、`idle_ttl_expired`、`context_compacted_or_reset`、`prefix_mutated_unknown` 四类原因，支持行内展开单步解剖抽屉。
- **零模型 Token 消耗预警与单行状态条**：本地实时检测 4 类异常（上下文超警戒线、缓存击穿、子 Agent 突发高耗、连续 3 步低速 `< 15 tok/s`）；支持在聊天流中通过 `metadata.user_markdown`（`systemMessage: ""`）展示仅用户可见的单行 TPS/Cache 状态条。

### 3. 多对话自动跟随与跨视图联动（v1.1.0 新增）
- **自动跟随活跃对话**：Hook 在 `SessionStart` / `PreInvocation` / `PostInvocation` / `Stop` 实时记录最新活跃会话及其所属工作区，右侧边栏、左侧边栏与独立悬浮窗均自动切换，连同 Git 分支、Rules 清单与记忆库一并对齐目标项目。
- **跨视图同步与按需锁定**：在任一监控面板切换历史对话，其他已打开的监控视图同步联动；点击下拉框旁的「跟随 / 锁定」图标即可在“自动跟随”与“钉住当前对话”间一键切换。

### 4. Git 感知跨会话记忆库与双视图交接胶囊（Context Vault）
- 对目标业务仓库严格**只读探测** Git 指纹、分支与 `HEAD`（绝不在业务仓库写入任何缓存文件），按 `project_id + branch` 隔离存储 `working_state`、`decision`、`architecture`、`pitfall` 与 `Stop` 自动 `checkpoint`。
- 所有记忆写入前自动脱敏（过滤 Bearer Token、API Key、JWT、PEM 私钥等），`SessionStart` 在 `< 500 tokens` 硬预算内注入极简项目索引并提示 `HEAD` 前进标脏。
- **固定高度双视图交接胶囊**：默认展示人眼易读卡片（逐条勾选决策实时计算 Token 预算），一键切换 Agent 紧凑载荷原文（`[CTX-CAPSULE] ...`），在 Aux Pane 中支持通过 `updateModelContext` 一键附着到下一条消息。

### 5. 原生挂载形态、独立悬浮弹窗与专属设置
- **左侧边栏一键独立悬浮窗**（`global`: `Context Monitor`）：默认自动弹出基于 `127.0.0.1` 一次性令牌的无框独立窗体，原生支持自由拖动、任意边缘缩放、记住窗口位置与尺寸、防重复多开，且**关闭浮窗后自动释放本地端口**；也可在设置中关闭自动弹出或点击「在当前页内嵌查看」。
- **右侧边栏可调宽入口**（`aux_pane`: `Context & Telemetry`）：内置顶部快捷浮窗按钮，随时与聊天界面并行监控。
- 定时检测周期可调（`3s` / `5s` / `10s` / `30s` / `60s` / `手动暂停`），全部面板刷新走私有工具，**0 模型 Token 消耗**。

---

## 架构与设计原则

### 双层 Tool Visibility 隔离（0 模型 Token 轮询）

| 层级 | 工具清单 | 可见性 | 对模型上下文的影响 |
| :--- | :--- | :--- | :--- |
| **Model-Visible（5 个精简工具）** | `ctx_open_monitor`、`ctx_brief`、`ctx_save`、`ctx_search`、`ctx_doctor` | `["model", "app"]` | 常驻定义极简（约 `0.6K` tokens） |
| **App-Only（7 个 UI 私有工具）** | `app_get_context_breakdown`、`app_get_calls`、`app_get_quota`、`app_calibrate_quota`、`app_vault_manage`、`app_config_manage`、`app_doctor_action` | `["app"]` | **0 tokens**（模型不可见、不触发推理） |

### 五层抗 Antigravity 破坏性更新设计
1. **零运行时依赖**：Core Engine、Hooks、MCP Server、CLI 纯基于 Node.js 24 原生能力（含 `node:sqlite`）；仅开发期使用 `@modelcontextprotocol/ext-apps` + `esbuild` 将前端打包为单一零外链静态 HTML，部署产物**零 `node_modules`**。
2. **外置真相源 + 可重建派生索引**：Markdown 与追加式 JSONL 真相源独立存放于 `%USERPROFILE%\.context-cache`（支持 `CONTEXT_CACHE_DATA_DIR` 覆盖），SQLite WAL + FTS5（`index.sqlite`）随时可删并无损重建。
3. **极薄 Fail-Open Hook 层**：仅挂载 `SessionStart`、`PreInvocation`、`PostInvocation`、`Stop`（**不挂载 `PreToolUse`**，绝不干扰原生命令审批）；统一 5s 硬超时、camelCase/snake_case 多版本兼容、脱敏 `schema-drift.jsonl` 录制与 3 次连续异常熔断（任何异常恒定返回 `{}`，退出码 `0`）。
4. **Windows 含空格路径免疫**：`hooks.json` 使用相对路径 + `--no-warnings`，Release 包使用 Antigravity 原生 `${PLUGIN_ROOT}` 变量展开，源码库零本机路径硬编码。
5. **不改宿主敏感配置**：部署与自愈绝不修改 Antigravity 程序文件或 `~/.gemini/config/config.json`。

---

## 快速开始

### 环境要求
- **Node.js >= 24.0.0**（原生内置 `node:sqlite`）
- **Git**（用于只读识别仓库指纹与分支）
- **Google Antigravity**

### 方式一：下载 Release 免构建插件包（推荐，零 `npm install`）

1. 前往 [Releases](https://github.com/Horikita-9-Suzune-Max-Ultrafast/context-cache/releases) 下载 `context-cache-v1.1.0-plugin.zip`（内部为全明文可读 `.mjs` 源码 + 预编译单文件 UI，零 `node_modules`）。
2. 解压至 Antigravity 插件目录，使目录结构为 `~/.gemini/config/plugins/context-cache/plugin.json`：
   - **Windows PowerShell**：
     ```powershell
     Expand-Archive -Path .\context-cache-v1.1.0-plugin.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
     ```
   - **macOS / Linux**：
     ```bash
     mkdir -p ~/.gemini/config/plugins
     unzip -o context-cache-v1.1.0-plugin.zip -d ~/.gemini/config/plugins
     ```
3. Antigravity 会自动发现并加载插件（无需重启）。

### 方式二：从源码克隆、测试并部署

```powershell
# 1. 克隆仓库
git clone https://github.com/Horikita-9-Suzune-Max-Ultrafast/context-cache.git
cd context-cache

# 2. 安装开发期 UI 打包依赖（仅 devDependencies，不会进入部署产物）
npm install

# 3. 运行全套 7 个自动化测试文件（完全隔离临时目录，零真实数据污染）
npm test

# 4. 构建单文件 MCP App UI 并幂等部署至 ~/.gemini/config/plugins/context-cache
npm run deploy

# 5. 运行健康体检（或打包便携 Release 压缩包）
npm run doctor
npm run pack:release
```

部署完成后：
- 在左侧边栏打开 **`Context Monitor`**（全页视图）；
- 或在对话右侧边栏 `+` 菜单打开 **`Context & Telemetry`**（侧边栏视图）；
- 点击右上角齿轮图标进入 **「插件设置」** 调整轮询周期、单行状态条、告警阈值、独立悬浮小窗或执行 Doctor 维护。

---

## 命令行工具（CLI）

内置宿主无关 CLI（`bin/ctx.mjs`），可在任意终端直接调用：

```powershell
# 查看当前项目 <500t 极简记忆简报
node --no-warnings bin/ctx.mjs brief

# 写入一条项目决策（自动脱敏）
node --no-warnings bin/ctx.mjs save --kind decision --title "标题" --summary "核心结论" --tags arch,cache

# FTS5 全文检索记忆库
node --no-warnings bin/ctx.mjs search "缓存击穿"

# 查看会话调用明细与 TPS / 额度参考统计
node --no-warnings bin/ctx.mjs calls
node --no-warnings bin/ctx.mjs quota

# 健康体检 / 一键自愈（重建 SQLite FTS5 索引 + 复位熔断器）
node --no-warnings bin/ctx.mjs doctor
node --no-warnings scripts/doctor.mjs --repair

# 导出脱敏备份至 ~/.context-cache/exports/
node --no-warnings bin/ctx.mjs export
```

---

## 目录结构

```text
context-cache/
├── bin/ctx.mjs                          # 宿主无关 CLI
├── src/
│   ├── core/                            # Node.js 24 零依赖核心引擎
│   │   ├── paths.mjs                    # 跨平台路径与外置数据目录解析
│   │   ├── config.mjs                   # 配置、模型窗口、价目表、额度分组与校准
│   │   ├── redact.mjs                   # 敏感凭据脱敏过滤器
│   │   ├── git-context.mjs              # 目标仓库只读 Git 探测
│   │   ├── storage.mjs                  # Markdown / JSONL 真相源原子读写
│   │   ├── index-db.mjs                 # node:sqlite WAL + FTS5 派生索引与无损重建
│   │   ├── vault.mjs                    # 跨会话记忆 CRUD、Compact Brief 与双视图交接胶囊
│   │   ├── context-inspector.mjs        # 上下文构成拆解、MCP 扫描与膨胀归因
│   │   ├── transcript-parser.mjs        # 多版本增量游标解析与子 Agent 自动发现
│   │   ├── telemetry.mjs                # 多 Agent 调用明细、TPS、缓存击穿与 4 类预警
│   │   ├── quota.mjs                    # 5h/7d 滑动窗口、基线校准与 QuotaProvider 扩展口
│   │   ├── popout-server.mjs            # 可选 127.0.0.1 令牌鉴权悬浮小窗服务（默认关闭）
│   │   └── doctor.mjs                   # 体检、漂移报告、备份导出与自愈
│   ├── adapters/antigravity/            # 极薄 Fail-Open Hook 适配层
│   │   ├── normalize.mjs                # 多版本字段归一化与脱敏漂移录制
│   │   ├── circuit-breaker.mjs          # 3 次异常熔断 5 分钟
│   │   └── hook.mjs                     # 统一 Hook 入口（5s 硬超时）
│   ├── mcp/server.mjs                   # 零依赖 MCP Stdio Server（5 Model + 7 App-Only）
│   └── ui/                              # 单文件自包含 MCP App 前端与 esbuild 打包脚本
├── plugin/                              # Antigravity 插件清单、Hooks、Rules、Skills 与图标
├── scripts/                             # deploy.mjs、pack-release.mjs 与 doctor.mjs
├── tests/                               # 7 个端到端 / 单元 / 韧性测试文件
├── LICENSE                              # MIT License
├── README.md                            # 简体中文文档
├── README.en.md                         # English documentation
└── package.json
```

---

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
