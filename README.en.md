# Antigravity Console (`context-cache`)

[简体中文](./README.md) | **English**

**Modular Native Antigravity Console (MCP App): Context Monitor, Multi-Agent Telemetry, Cross-Session Vault & Zero-Dep Chinese Localization**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/Runtime%20Deps-0-brightgreen.svg)](#architecture--design-principles)

Starting in **v1.3.0**, `context-cache` evolves into the modular **Antigravity Console** (preserving the `context-cache` plugin ID, `%USERPROFILE%\.context-cache` data directory, and all existing MCP tools for seamless zero-migration upgrades), featuring a responsive dual-layout shell (left icon rail on wide screens, compact top module bar in narrow side panes) with two built-in modules:
1. **Context Monitor**: Context window breakdown, main/sub-agent TPS & prefix-cache drop attribution, auto-following active conversations across views, native frameless floating monitor, Git-aware cross-session memory & dual-view handoff capsules.
2. **Antigravity Localization**: Pure Node.js zero-dependency streaming ASAR patcher, 739+ curated default Chinese entries (native menus + UI + dynamic regex patterns), 3-layer hot-reloaded external dictionary, physical immunity zones, brand customization, update-drift reminders, and detached apply/restore worker.

**Core goals: 0 model tokens consumed by live monitoring & console UI, zero files written into target business repositories, and resilient operation across Antigravity host updates.**

> [!NOTE]
> **Known Host Boundaries**
> - **Time-to-First-Token (TTFT)**: Official `transcript.jsonl` files do not currently expose streaming TTFT. The latency column reports per-step model duration and automatically switches if `ttft_ms` / `ttftMs` appears in future host logs.
> - **Conversation Auto-Follow**: Whenever you start or send a message in Conversation 2 or 3, hooks immediately record the active session and all open monitors (right Aux Pane & floating window) follow automatically along with the conversation's Git branch and vault. When passively browsing an older conversation without sending a message, picking it once in any monitor's dropdown syncs all open views.
> - **Quota View Hidden**: Because Antigravity does not yet expose a public Quota API, the **Quota** tab is hidden from user-facing UI starting in v1.1.0 while preserving all core code and the pluggable `QuotaProvider` interface for future activation.

---

## Key Features

### 1. Context Inspector
- Aligns live `input_tokens + cache_read_tokens` against the active model's context limit.
- Breaks down active usage into `Messages`, `System baseline`, `MCP tools` (separating eager vs. `deferred` schemas), `Skills`, `Memory & Rules`, and `Custom agents`.
- **Bloat Attribution**: Identifies the top 3 context consumers and surfaces zero-token optimization hints when usage exceeds the warning threshold (default `75%`) or any MCP server exceeds `15K` tokens.

### 2. Multi-Agent Live Calls & TPS Telemetry
- Automatically discovers sub-agents launched via `invoke_subagent` (`主`, `子1`, `子2`…) and merges their transcripts for step-level inspection, agent/model summaries, multi-dimensional filtering, and a prominent hero summary bar (steps, token-weighted TPS, cost, and active model).
- **1-to-1 Dual-Source Timing & Weighted TPS**: Matches `PreInvocation` → `PostInvocation` `hook_ms` strictly 1-to-1 by `startMs` (preventing same-second collisions), falling back cleanly to `hybrid_tool_split` / `transcript_fallback`; computes token-weighted average throughput (`totalOutputTokens / totalDurationSec`).
- **Prefix-Cache Drop Attribution & Step Anatomy**: Classifies drops into `model_changed`, `idle_ttl_expired`, `context_compacted_or_reset`, and `prefix_mutated_unknown` with an inline expandable drawer showing the **source session/sub-agent**, **full model name**, cache-hit ratio bar, and drop attribution.
- **Zero-Token Alerts & Single-Line Status Banner**: Locally detects 4 alert classes (high context, cache drop, sub-agent burst, 3-step low TPS `< 15 tok/s`) and optionally renders a user-only single-line status banner in chat via `metadata.user_markdown` (`systemMessage: ""`).

### 3. Multi-Conversation Auto-Follow, Sub-Agent Retention & Active Aggregation (Upgraded in v1.2.0)
- **Live Auto-Follow**: Hooks record the latest active conversation and workspace on `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`, keeping the right side pane, left sidebar, and floating window aligned with the active conversation's context, Git branch, rules, and vault.
- **Active Aggregation & Persistent Sub-Agents**: Recent active sub-agents remain selectable in the session dropdown (with live dot and `子N` badges) even after switching back to the main thread; includes a dedicated **"All Running Conversations (Main + Sub)"** aggregate view.
- **Cross-View Sync & Pin Toggle**: Picking a conversation in any open monitor syncs all other views; click the follow/pin button next to the selector anytime to pin a specific conversation locally.

### 4. Git-Aware Cross-Session Vault & Dual-View Handoff Capsule
- Performs strictly **read-only** Git fingerprint/branch/`HEAD` detection (never writes files inside target repos) and isolates `working_state`, `decision`, `architecture`, `pitfall`, and `Stop` checkpoints by `project_id + branch`.
- Auto-redacts secrets (Bearer tokens, API keys, JWTs, PEM private keys) before writing to disk; injects a `< 500 tokens` brief at `SessionStart` with `HEAD` staleness indicators.
- **Fixed-Height Dual-View Handoff Capsule**: Toggle between human-readable cards (with live per-decision checkboxes updating the token budget) and the compact `[CTX-CAPSULE]` agent payload, with optional `updateModelContext` attachment in Aux Pane.

### 5. Native Frameless Floating Host, Responsive Console Shell & Settings (Upgraded in v1.3.0)
- **Responsive Modular Console Shell**: Displays a `56px` left icon rail on wide viewports (`> 680px`) and automatically collapses into a compact top module bar in narrow side panes (`<= 680px`), maintaining zero horizontal overflow and dynamic popover viewport clamping.
- **Native Windows Frameless WebView2 Floating Window** (`global`: `Antigravity Console`): Launches a native rounded borderless OS window over a `127.0.0.1` ephemeral port with one-time token auth (falling back to Edge/Chrome `--app` on other platforms). Supports Always-on-Top pinning, **quick-collapse mini bar (with Context %, TPS & Model badges + horizontal resize)**, **independent minimize & foreground restore**, high-DPI scaling, 8-edge resize, and **auto-port release on close**.
- Configurable auto-refresh interval (`3s` / `5s` / `10s` / `30s` / `60s` / `manual`), running exclusively over app-only tools at **0 LLM token cost**.

### 6. Antigravity Chinese Localization Module (New in v1.3.0)
- **Zero-Dep Pure Node.js Streaming ASAR Patcher**: Patches `resources/app.asar` in-place without unpacking thousands of `node_modules` files, maintaining full Electron 4 MiB block SHA-256 `integrity` hashes and preserving `unpacked`/`executable`/`link` entries verbatim.
- **5-State Detection & Clean Backup Guard**: Auto-detects install path, version, and state (`not_found` / `unpatched` / `patched_by_console` / `patched_by_other` / `outdated_after_update`). Never backs up a patched `app.asar` as a clean original—when a third-party patch is present, uses its clean backup (e.g. `app.asar.zh-cn.bak`) as the base.
- **Detached Breakaway Apply/Restore Worker**: On Windows, spawns via WMI `Win32_Process.Create` completely outside Antigravity's process tree and Job Object to safely close Antigravity, release `app.asar`, apply or restore, and relaunch the app cleanly.
- **Curated Default Dictionary & 3-Layer Hot-Reload**: Ships **739+ curated entries** (127 Electron menu items + 612 Antigravity 2.0 UI strings + 34 dynamic regex patterns) with 3-layer merging (`custom > community MIT > builtin`) compiled to `%USERPROFILE%\.context-cache\i18n\runtime-bundle.json`—day-to-day dictionary, immunity, and brand edits take effect without repacking `app.asar`.
- **Physical Immunity Zones, Brand Customization & Update Alerts**: Protects code editors, inputs, terminals, file paths, and custom CSS selectors from accidental translation; customizes top-left brand display; alerts automatically when an official Antigravity update overwrites `app.asar`.

---

## Architecture & Design Principles

### Two-Tier Tool Visibility Isolation (0 LLM Tokens for UI Polling)

| Tier | Tools | Visibility | Model Context Impact |
| :--- | :--- | :--- | :--- |
| **Model-Visible (5 slim tools)** | `ctx_open_monitor`, `ctx_brief`, `ctx_save`, `ctx_search`, `ctx_doctor` | `["model", "app"]` | Minimal footprint (~`0.6K` tokens) |
| **App-Only (8 UI private tools)** | `app_get_context_breakdown`, `app_get_calls`, `app_get_quota`, `app_calibrate_quota`, `app_vault_manage`, `app_config_manage`, `app_doctor_action`, `app_i18n_manage` | `["app"]` | **0 tokens** (invisible to model) |

### Five-Layer Anti-Fragile Design
1. **Zero Runtime Dependencies**: Core Engine, Hooks, MCP Stdio Server, and CLI run purely on Node.js 24 native modules (`node:sqlite`, `node:http`, `node:crypto`). Only dev-time bundling uses `@modelcontextprotocol/ext-apps` + `esbuild` to emit a single self-contained HTML; deployed bundles contain **zero `node_modules`**.
2. **External Truth Source + Rebuildable Index**: Markdown and append-only JSONL files live in `%USERPROFILE%\.context-cache` (or `CONTEXT_CACHE_DATA_DIR`). SQLite WAL + FTS5 (`index.sqlite`) can be deleted and rebuilt losslessly anytime.
3. **Thin Fail-Open Hook Adapter**: Registers only `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` (**no `PreToolUse`**, preserving native command approval). Enforces a 5s hard timeout, camelCase/snake_case normalization, redacted `schema-drift.jsonl`, and a 3-strike circuit breaker that always fails open with `{}` and exit code `0`.
4. **Spaced Windows Path Safety**: `hooks.json` uses relative paths + `--no-warnings`, and portable Release bundles use Antigravity's `${PLUGIN_ROOT}` expansion with zero hardcoded local paths.
5. **Host-Safe Deployment**: Never modifies Antigravity binaries or `~/.gemini/config/config.json`.

---

## Quick Start

### Prerequisites
- **Node.js >= 24.0.0** (built-in `node:sqlite`)
- **Git** (for read-only repository fingerprinting)
- **Google Antigravity**

### Option A: Prebuilt Release Bundle (Recommended, No `npm install`)

1. Download `context-cache-v1.3.0-plugin.zip` from [Releases](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases) (plain readable `.mjs` source + pre-bundled single-file UI, zero `node_modules`).
2. Extract into `~/.gemini/config/plugins/` so `plugin.json` lives at `~/.gemini/config/plugins/context-cache/plugin.json`:
   - **Windows PowerShell**:
     ```powershell
     Expand-Archive -Path .\context-cache-v1.3.0-plugin.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
     ```
   - **macOS / Linux**:
     ```bash
     mkdir -p ~/.gemini/config/plugins
     unzip -o context-cache-v1.3.0-plugin.zip -d ~/.gemini/config/plugins
     ```
3. Antigravity discovers and loads the plugin automatically (no restart required).

### Option B: Build, Test & Deploy from Source

```powershell
# 1. Clone repository
git clone https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub.git
cd antigravity-hub

# 2. Install dev-only UI build tools (never copied into deployed bundle)
npm install

# 3. Run full 10-file automated test suite (16 test cases, isolated temp dirs)
npm test

# 4. Build single-file MCP App UI and deploy to ~/.gemini/config/plugins/context-cache
npm run deploy

# 5. Run diagnostics (or build a portable Release zip)
npm run doctor
npm run pack:release
```

---

## CLI Usage

The host-agnostic CLI (`bin/ctx.mjs`) works in any terminal:

```powershell
# Print <500t project brief
node --no-warnings bin/ctx.mjs brief

# Save a redacted decision entry
node --no-warnings bin/ctx.mjs save --kind decision --title "Title" --summary "Key rationale" --tags arch,cache

# Full-text FTS5 search
node --no-warnings bin/ctx.mjs search "cache drop"

# Inspect calls/TPS or local quota reference summary
node --no-warnings bin/ctx.mjs calls
node --no-warnings bin/ctx.mjs quota

# Run diagnostics / self-healing repair (rebuild FTS5 index + reset circuit breaker)
node --no-warnings bin/ctx.mjs doctor
node --no-warnings scripts/doctor.mjs --repair

# Export sanitized backup to ~/.context-cache/exports/
node --no-warnings bin/ctx.mjs export

# Antigravity localization status, live bundle refresh, apply, and restore
node --no-warnings bin/ctx.mjs i18n status
node --no-warnings bin/ctx.mjs i18n refresh
node --no-warnings bin/ctx.mjs i18n apply
node --no-warnings bin/ctx.mjs i18n restore
```

---

## License

Licensed under the [MIT License](./LICENSE).
