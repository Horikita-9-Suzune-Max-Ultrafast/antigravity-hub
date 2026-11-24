# Antigravity Hub

**简体中文** | [English](./README.en.md)

**模块化 Antigravity 原生控制中心（MCP App）：集上下文缓存与监控、生态治理与场景预设、外观壁纸引擎与零依赖界面汉化于一体**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/Runtime%20Deps-0-brightgreen.svg)](#架构与设计原则)

**Antigravity Hub** 是为 **Google Antigravity** 打造的模块化原生控制中心，采用**宽屏左侧窄图标栏 / 窄屏顶部紧凑切换条**的响应式双形态外壳，支持**简体中文 / English 双语界面免刷新实时切换**，内置四大核心模块：
1. **上下文缓存与监控（Context Cache & Monitor）**：上下文构成透视与切模型水位模拟、已挂载资产完整双语展示、主/子 Agent 实时 TPS 与缓存击穿/卫生体检、多对话自动跟随、顶栏一键安全重启 Antigravity（不触碰 `app.asar`）、右侧边栏一键呼出原生无框悬浮窗、Git 感知跨会话记忆库与交接胶囊（含新手悬停说明）。
2. **生态治理与 Harness 体检（Ecosystem & Harness Governance）**：Effective Harness 全景生效栈（P1 工作区 → P4 内置）、三合一纯离线体检（MCP 健康/Schema 冗余、Skill 质量/冲突/断链、隐私防泄露审计盾）与**分层修复闭环（一键预览/发送预设提示词给 Agent、本地跳转处理、脱敏预览、单条忽略与实时重算评分）**、五重零事故安全护栏开关、**多信号内容分类与可勾选场景预设（支持用户自定义常驻核心、分类覆盖、Rules/Skills/MCP Token 拆分预览与一步另存）**，以及宿主配置快照时间机器（含 CLI 应急逃生舱）。
3. **外观壁纸系统（Appearance & Wallpaper）**：复用现有 Fail-Open 客户端运行时（零新增 ASAR 侵入点）、原创纯 CSS 渐变氛围预设、外置本地壁纸库与 100% 只读文件夹扫描、**本地壁纸库轮播池子集选择与双缓冲淡入淡出**、15 MiB 体积熔断与 Blob 内存自动释放、**实时拖动热调参（不透明度/模糊/饱和度/遮罩/面板不透明度/毛玻璃）**、深浅主题独立绑定、定时/启动轮播（支持 1 分钟自定义间隔）与秒级热关闭（含 CLI 急救命令）。
4. **界面汉化（Antigravity Localization）**：纯 Node.js 零依赖流式 ASAR 补丁引擎、739+ 精校内置词典（含原生菜单与动态模板正则）、三层词典外置热加载、物理免疫区防误翻、品牌名自定义、官方升级覆盖自动提醒与脱离进程一键应用/无损还原。

**核心目标：实时监控与控制台管理 0 模型 Token 消耗、对业务代码仓库零写入污染、Antigravity 升级改版不崩不丢数据。**

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
- 自动识别主对话 `transcript.jsonl` 中的 `invoke_subagent` 调用并追踪所有子 Agent（编号 `主`、`子1`、`子2`…），支持按步查看、按 Agent / 模型维度汇总、多维筛选，以及顶部大字汇总看板（步数 / 加权均速 / 累计费用 / 当前模型）。
- **1-to-1 双源计时与 Token 加权吞吐**：`PreInvocation` → `PostInvocation` 实测 `hook_ms` 采用 `startMs` 优先一对一消费机制（防同秒错配），缺失时平滑回退至 `hybrid_tool_split` / `transcript_fallback`；平均速度按总输出 Token / 总耗时加权计算。
- **前缀缓存击穿自动归因与单步解剖**：自动区分 `model_changed`、`idle_ttl_expired`、`context_compacted_or_reset`、`prefix_mutated_unknown` 四类原因；点击任意行可展开单步解剖抽屉，查看**信息来源**（所属会话/子代理）、**完整模型名**、缓存命中比例条与击穿归因。
- **零模型 Token 消耗预警与单行状态条**：本地实时检测 4 类异常（上下文超警戒线、缓存击穿、子 Agent 突发高耗、连续 3 步低速 `< 15 tok/s`）；支持在聊天流中通过 `metadata.user_markdown`（`systemMessage: ""`）展示仅用户可见的单行 TPS/Cache 状态条。

### 3. 多对话自动跟随、子代理保留与运行汇总（v1.2.0 升级）
- **自动跟随活跃对话**：Hook 在 `SessionStart` / `PreInvocation` / `PostInvocation` / `Stop` 实时记录最新活跃会话及其所属工作区，右侧边栏、左侧边栏与独立悬浮窗均自动切换，连同 Git 分支、Rules 清单与记忆库一并对齐目标项目。
- **当前运行汇总与子代理不丢失**：下拉列表保留近 2 小时活跃的子代理（带 `子1` 徽章与运行绿点），切回主会话后仍可随时再选；新增顶部 **「汇总 · 当前运行中的全部对话 (主+子)」** 视图，实时聚合所有并行运行的会话调用流。
- **跨视图同步与按需锁定**：在任一监控面板切换历史对话，其他已打开的监控视图同步联动；点击下拉框旁的「跟随 / 锁定」图标即可在“自动跟随”与“钉住当前对话”间一键切换。

### 4. Git 感知跨会话记忆库与双视图交接胶囊（Context Vault）
- 对目标业务仓库严格**只读探测** Git 指纹、分支与 `HEAD`（绝不在业务仓库写入任何缓存文件），按 `project_id + branch` 隔离存储 `working_state`、`decision`、`architecture`、`pitfall` 与 `Stop` 自动 `checkpoint`。
- 所有记忆写入前自动脱敏（过滤 Bearer Token、API Key、JWT、PEM 私钥等），`SessionStart` 在 `< 500 tokens` 硬预算内注入极简项目索引并提示 `HEAD` 前进标脏。
- **固定高度双视图交接胶囊**：默认展示人眼易读卡片（逐条勾选决策实时计算 Token 预算），一键切换 Agent 紧凑载荷原文（`[CTX-CAPSULE] ...`），在 Aux Pane 中支持通过 `updateModelContext` 一键附着到下一条消息。

### 5. 原生无框悬浮窗、迷你条交互排序、Gemini KV 倒计时与专属设置（v1.5.3 升级）
- **随 Antigravity 启动自动弹出悬浮窗**：MCP Server 握手完成后自动拉起默认形态无框悬浮窗（基于宿主 `language_server.exe` PID 去重，单次运行仅弹一次，退出自动收尾，设置页可随时开关）。
- **迷你悬浮条快捷长度档位与跟手拖拽排序**：彻底修复窄宽截断（按模块整块显隐），内置「极简 1 / 紧凑 2 / 标准 3 / 加宽 4 / 完整 5」5 级快捷长度并保留自由拖宽；设置页提供等比可视化预览条，支持跟手拖拽实时让位（FLIP 动画 + 折行防抖）与点击选中互换。
- **Gemini KV Cache 保鲜倒计时与图标三态变色**：对话结束后本地 1 秒倒计时（0 模型 Token，默认 15 分钟参考窗口且可自定义），悬浮窗与侧栏 Hub 图标随空闲风险平滑切换 **蓝 → 琥珀黄 → 警示红**，配套 `?` 原理轻提示；同步统一顶栏 Git 徽章视觉与「非 Git 目录」语义展示。
- **响应式模块化控制台外壳与双语实时切换**：宽屏（`> 680px`，左侧边栏全页或宽屏悬浮窗）展示 `56px` 固定左侧图标导航栏，窄屏（`<= 680px`，右侧边栏或紧凑悬浮窗）自动折叠为顶部紧凑模块切换条；内置零依赖中英双语词典（`src/ui/i18n-ui.mjs`），可在设置中一键切换 **简体中文 / English** 并即时生效，完整汉化监控页「已挂载资产」（MCP 服务、按需/常驻工具、记忆与规则文件、生效技能与自定义代理等）。
- **监控顶栏安全重启与 4 分区设置中心**：监控页顶栏与设置页维护区均提供 **「重启 Antigravity」** 按钮（带确认弹窗防误触，通过脱离进程安全重启且绝不触碰 `app.asar`）；设置页按「常规与语言 / 监控与告警 / 独立悬浮窗 / 维护与快捷操作」清晰分组，集成健康体检、重建索引、导出备份与恢复默认配置。
- **Windows 原生无框 WebView2 悬浮窗**（`global`: `Antigravity Hub`）：基于 `127.0.0.1` 一次性令牌自动拉起无浏览器标题栏的原生圆角悬浮窗（非 Windows 或异常时自动降级至 Edge/Chrome `--app`），支持 Always-on-Top 一键置顶固定、**快捷收缩为迷你悬浮条（含上下文占比 / TPS / 模型徽章且支持横向拉伸）**、**独立最小化与一键唤醒还原**、8 方向缩放与高 DPI 精准记忆，关闭即释放本地端口。
- 定时检测周期可调（`3s` / `5s` / `10s` / `30s` / `60s` / `手动暂停`），全部面板刷新走私有工具，**0 模型 Token 消耗**。

### 6. Antigravity 界面汉化模块（v1.3.0 新增）
- **纯 Node.js 零依赖流式 ASAR 补丁引擎**：无需 `node_modules` 或解包数千文件，直接流式原位重写 `resources/app.asar` 并完整维护 Electron 4 MiB 分块 SHA-256 `integrity` 校验，无损保留 `unpacked`/`executable`/`link` 元数据。
- **5 态精准感知与干净备份保护**：自动探测客户端安装目录、版本号与汉化状态（未汉化 / 控制台已汉化 / 检测到第三方补丁 / 官方更新待重打 / 未找到）；严格保护原版备份，若检测到第三方补丁（如已有 `app.asar.zh-cn.bak`），自动以干净原版备份为基底，绝不误将已补丁文件存为原版。
- **脱离进程安全重启（Windows WMI Breakaway）**：点击「一键应用汉化」或「一键还原原版」时，通过脱离宿主进程树与 Job Object 的独立后台进程自动关闭客户端、释放文件锁、写入/还原 `app.asar` 并重新拉起 Antigravity，执行结果回写 `last-job.json`。
- **高质量默认词典 + 三层外置热加载**：内置 **739+ 精校词条**（127 条 Electron 原生菜单 + 612 条 Antigravity 2.0 高频界面 + 34 条动态变量正则模板），支持 `自定义覆盖 > 社区 MIT 词典导入/HTTPS 同步 > 内置词典` 三层合并，实时编译至 `%USERPROFILE%\.context-cache\i18n\runtime-bundle.json`——**日常改词条、切品牌名、调免疫规则无需重新打包 `app.asar`**。
- **防误翻物理免疫区、品牌定制与更新提醒**：支持一键开关代码块（`.monaco-editor`/`pre`/`code`）、输入框、终端（`.xterm`）、文件路径及自定义 CSS 选择器免疫；支持原版/中文/自定义/隐藏左上角品牌显示；官方升级覆盖 `app.asar` 后顶部自动提醒一键重新汉化。

### 7. 生态治理与场景预设（Ecosystem & Harness Governance）
- **Effective Harness 全景生效栈与离线三合一体检**：按 `P1 工作区 > P2 全局 > P3 插件 > P4 内置` 扫描全部 Rules、Skills、Hooks 与 MCP Server，纯离线检测 MCP 断路径/过重 Schema、Skill 覆盖冲突/断链（自动过滤代码块与占位符防误报）以及规则/配置中的明文密钥风险（自动脱敏）。
- **体检分层修复闭环与忽略持久化（v1.5.1 新增）**：每条体检项附带简明修复建议与分层处置按钮——Skill/配置类支持预览/微调预设提示词后一键发送给当前对话 Agent（全页视图自动切为复制提示词）或批量打包修复；重型 MCP 一键跳转停用；隐私安全类提供脱敏预览与禁止回显明文的安全改造提示词；支持单条忽略（实时回升健康评分）与底部折叠区随时恢复。
- **多信号内容分类与用户偏好**：内置分类器综合读取插件 Manifest 描述、`SKILL.md` 描述、MCP 工具名与启动参数（支持中英文语义），不再仅凭名称盲猜；用户可在「插件/MCP」页一键将核心插件设为**常驻保护**，或手动覆盖任意插件/全局 MCP 的场景分类（开发 / 办公协作 / 通用），配置持久化于 `%USERPROFILE%\.context-cache\governance\preferences.json`。
- **确定性预设 + 可勾选推荐模板**：内置「极简省流」「全部启用」（确定性）与「专注编码」「办公协作」（推荐模板，未归类项默认保持现状防误关）；预览弹窗支持**逐项勾选微调**、实时重算 **Rules / Skills / MCP 拆分 Token 变化**，并可一步勾选**「执行后同时另存为自定义预设」**。
- **五重安全护栏与快照时间机器**：系统级保护 `context-cache` 防失联、所有修改前自动留存不可变宿主配置快照（含永久基线），支持界面一键无损回滚与 CLI 逃生舱（`ctx gov rollback`）。

### 8. 外观壁纸系统（Appearance & Wallpaper）
- **零新增侵入点热加载**：复用 Fail-Open 客户端运行时实时推送样式，无需重新打包 `app.asar`；支持秒级总开关与 CLI 一键急救关闭（`ctx wallpaper off`）。
- **多元壁纸来源与轮播池**：支持纯 CSS 渐变氛围预设、外置本地壁纸库（15 MiB 体积熔断）与只读本地文件夹扫描；支持**按来源筛选轮播池与自定义壁纸库子集**、双缓冲平滑淡入淡出及 1 分钟自定义轮播间隔。
- **实时参数调节与深浅主题绑定**：滑块拖动即时生效，支持不透明度、模糊、饱和度、全局遮罩、面板不透明度（`scrimOpacity`）与毛玻璃调节，并支持浅色/深色主题独立绑定壁纸。

---

## 架构与设计原则

### 双层 Tool Visibility 隔离（0 模型 Token 轮询）

| 层级 | 工具清单 | 可见性 | 对模型上下文的影响 |
| :--- | :--- | :--- | :--- |
| **Model-Visible（5 个精简工具）** | `ctx_open_monitor`、`ctx_brief`、`ctx_save`、`ctx_search`、`ctx_doctor` | `["model", "app"]` | 常驻定义极简（约 `0.6K` tokens） |
| **App-Only（10 个 UI 私有工具）** | `app_get_context_breakdown`、`app_get_calls`、`app_get_quota`、`app_calibrate_quota`、`app_vault_manage`、`app_config_manage`、`app_doctor_action`、`app_i18n_manage`、`app_governance_manage`、`app_appearance_manage` | `["app"]` | **0 tokens**（模型不可见、不触发推理） |

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

1. 前往 [Releases](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases) 下载 `context-cache-v1.5.3-plugin.zip`（内部为全明文可读 `.mjs` 源码 + 预编译单文件 UI，零 `node_modules`）。
2. 解压至 Antigravity 插件目录，使目录结构为 `~/.gemini/config/plugins/context-cache/plugin.json`：
   - **Windows PowerShell**：
     ```powershell
     Expand-Archive -Path .\context-cache-v1.5.3-plugin.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
     ```
   - **macOS / Linux**：
     ```bash
     mkdir -p ~/.gemini/config/plugins
     unzip -o context-cache-v1.5.3-plugin.zip -d ~/.gemini/config/plugins
     ```
3. Antigravity 会自动发现并加载插件（无需重启）。

### 方式二：从源码克隆、测试并部署

```powershell
# 1. 克隆仓库
git clone https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub.git
cd antigravity-hub

# 2. 安装开发期 UI 打包依赖（仅 devDependencies，不会进入部署产物）
npm install

# 3. 运行全套 13 个自动化测试文件（31 项用例，完全隔离临时目录，零真实数据与宿主污染）
npm test

# 4. 构建单文件 MCP App UI 并幂等部署至 ~/.gemini/config/plugins/context-cache
npm run deploy

# 5. 运行健康体检（或打包便携 Release 压缩包）
npm run doctor
npm run pack:release
```

部署完成后：
- 在左侧边栏打开 **`Antigravity Hub`**（全页视图，含左侧窄图标模块栏）；
- 或在对话右侧边栏 `+` 菜单打开 **`Antigravity Hub`**（侧边栏视图，顶部紧凑模块切换条）；
- 点击左下角 / 右上角齿轮图标进入 **「插件设置」** 调整轮询周期、单行状态条、告警阈值、独立悬浮小窗或执行 Doctor 维护。

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

# Antigravity 生态治理体检与宿主配置应急回滚逃生舱（v1.4.0）
node --no-warnings bin/ctx.mjs gov status
node --no-warnings bin/ctx.mjs gov lint
node --no-warnings bin/ctx.mjs gov snapshots
node --no-warnings bin/ctx.mjs gov rollback

# Antigravity 外观壁纸状态、切图与一键急救关闭（v1.5.0）
node --no-warnings bin/ctx.mjs wallpaper status
node --no-warnings bin/ctx.mjs wallpaper next
node --no-warnings bin/ctx.mjs wallpaper off

# Antigravity 汉化状态探测、词典热更新与应急还原
node --no-warnings bin/ctx.mjs i18n status
node --no-warnings bin/ctx.mjs i18n refresh
node --no-warnings bin/ctx.mjs i18n apply
node --no-warnings bin/ctx.mjs i18n restore
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
│   │   ├── session-tracker.mjs          # 活跃对话自动跟随、跨视图联动与工作区对齐
│   │   ├── quota.mjs                    # 5h/7d 滑动窗口、基线校准与 QuotaProvider 扩展口
│   │   ├── popout-server.mjs            # 127.0.0.1 令牌鉴权悬浮小窗服务、握手与自动降级
│   │   ├── win-floating-host.ps1        # Windows 原生无框 WebView2 置顶/收缩/最小化悬浮窗宿主
│   │   ├── client-restart.mjs           # 脱离进程安全重启 Antigravity（不触碰 app.asar）
│   │   ├── doctor.mjs                   # 体检、漂移报告、备份导出与自愈
│   │   ├── governance/                  # 生态治理（全景扫描/多信号分类器/场景预设/离线体检修复闭环/护栏快照）
│   │   ├── appearance/                  # 外观壁纸引擎（预设/外置库/只读扫描/轮播池/热加载）
│   │   └── i18n/                        # 零依赖 Antigravity 汉化引擎（ASAR/词典/脱离重启）
│   ├── adapters/antigravity/            # 极薄 Fail-Open Hook 适配层
│   │   ├── normalize.mjs                # 多版本字段归一化与脱敏漂移录制
│   │   ├── circuit-breaker.mjs          # 3 次异常熔断 5 分钟
│   │   └── hook.mjs                     # 统一 Hook 入口（5s 硬超时）
│   ├── mcp/server.mjs                   # 零依赖 MCP Stdio Server（5 Model + 10 App-Only）
│   └── ui/                              # 单文件自包含模块化控制台前端（含 i18n-ui.mjs 双语词典与 governance/appearance/i18n）
├── plugin/                              # Antigravity 插件清单、Hooks、Rules、Skills 与图标
├── scripts/                             # deploy.mjs、pack-release.mjs 与 doctor.mjs
├── tests/                               # 13 个端到端 / 单元 / 韧性测试文件（31 项用例）
├── LICENSE                              # MIT License
├── README.md                            # 简体中文文档
├── README.en.md                         # English documentation
└── package.json
```

---

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
