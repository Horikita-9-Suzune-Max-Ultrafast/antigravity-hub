# Antigravity Hub

[简体中文](./README.md) | **English**

**Modular Native Control Center (MCP App) for Google Antigravity: Context Cache & Monitor, Ecosystem & Harness Governance, Local Wallpaper Engine, and Zero-Dep Chinese Localization**

[![Version: v1.5.4](https://img.shields.io/badge/Version-v1.5.4-0ea5e9.svg)](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases/tag/v1.5.4)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/Runtime%20Deps-0-brightgreen.svg)](#architecture--design-principles)

> **Core Commitments**: **0 LLM tokens** consumed by live monitoring & UI ｜ **Zero files written** inside your business repositories ｜ **Zero runtime dependencies** (no `node_modules`) ｜ **100% readable source & one-click lossless rollback**

---

## Quick Navigation

- [Four Core Modules at a Glance](#four-core-modules-at-a-glance)
- [What's New in v1.5.4](#whats-new-in-v154)
- [Quick Start (3-Step Prebuilt Bundle)](#quick-start)
- [Key Features](#key-features)
- [Architecture & Design Principles](#architecture--design-principles)
- [CLI Usage](#cli-usage)
- [Upgrading, Uninstalling & Rollback](#upgrading-uninstalling--rollback)
- [FAQ](#faq)
- [Repository Structure](#repository-structure)

---

## Four Core Modules at a Glance

**Antigravity Hub** ships with a responsive dual-layout shell—a fixed `56px` left icon rail on wide viewports (`> 680px`) that collapses into a compact top module bar in narrow side panes (`<= 680px`)—with **instant zh-CN / English language switching** without reloading.

| Module | Pain Point Solved | Core Capabilities |
| :--- | :--- | :--- |
| **1. Context Cache & Monitor** | Slow turns, unexplained prefix-cache drops, opaque context bloat, repeating background in every new chat | 6-category context breakdown, **click-through Asset Inspector Modal**, **one-click Alert jump-to-step**, main/sub-agent TPS & cache-drop attribution, **native frameless floating window & 5-chip Radix Mini Bar**, Gemini KV timer, **3-source Handoff Capsule (3 budget tiers)**, safe restart |
| **2. Ecosystem & Harness Governance** | Too many plugins/MCPs bloating every session; manual toggling across workflows risks disabling essentials | Effective Harness stack (`P1 Workspace` → `P4 Built-in`), offline 3-in-1 linter (MCP bloat / Skill conflicts & broken links / secret audit) with **tiered remediation**, multi-signal classifier & **interactive scenario profiles**, pinned core plugins, immutable config snapshots & CLI rollback |
| **3. Local Wallpaper Engine**<br>`Appearance & Wallpaper` | Plain default UI without risking fragile ASAR repacking for visual customization | Zero-new-ASAR hot reload, external local wallpaper library (15 MiB breaker) + **100% read-only local folder scanning**, custom rotation pools with dual-buffer crossfade, **live slider tuning (opacity/blur/saturation/scrim/glass)**, light/dark theme bindings, instant & CLI emergency off |
| **4. Antigravity Localization** | English-only native menus and UI; fear of third-party patches translating code or breaking updates | Pure Node.js streaming ASAR patcher (maintains 4 MiB SHA-256 integrity), **739+ curated entries** (menus + dynamic UI + regex patterns), 3-layer hot-reloaded external dictionary, **physical immunity zones** (code/terminal/paths), clean original backup guard & one-click restore |

---

## What's New in v1.5.4

- **Click-Through Asset Inspector Modal (v1.5.4)**: Click any mounted rule, skill, or custom agent card to inspect its read-only redacted source (strict root whitelist + symlink protection + secret redaction, with copy-path and open-file actions). Click any MCP server to view its full tool breakdown table, per-tool token bar, and jump straight to Governance.
- **One-Click Alert Jump-to-Step (v1.5.4)**: Every alert row is clickable—clicking a cache-drop, low-TPS, or sub-agent alert collapses the banner, switches to **Calls**, scrolls directly to the offending step, expands its anatomy drawer, and pulses a highlight; high-context alerts jump directly to the breakdown section.
- **3-Source Auto-Aggregated Handoff Capsule (v1.5.4)**: Zero-token aggregation across Vault decisions, active `transcript.jsonl` (recent user requests, edited files, produced Artifacts), and live Git changes (`M`/`A`/`?`) + last 2 commits. Choose **Compact (500t) / Standard (1200t) / Full (2500t)** with live recalculation, inline editable Active Goal & Next Action, and per-item checkboxes.
- **Radix Mini Bar Chips & Unified Visual Polish (v1.5.3 → v1.5.4)**: Native Windows frameless floating window with startup auto-launch, follow-cursor FLIP drag reordering, and 5 length presets. v1.5.4 assigns light/dark-adaptive Radix UI Colors semantic chips to all 5 mini bar modules (Context, TPS, KV Countdown, Model, Cache Hit) and eliminates all unstyled native `<button>` elements.
- **Focused Local Wallpaper Library (v1.5.4)**: Removed built-in gradient presets to keep the gallery clean; legacy configs pointing to removed preset IDs silently fall back to the first local wallpaper or disabled state with zero errors.

> [!NOTE]
> **Known Host Boundaries**
> - **Time-to-First-Token (TTFT)**: Official `transcript.jsonl` files do not currently expose streaming TTFT. The latency column reports per-step model duration and automatically switches if `ttft_ms` / `ttftMs` appears in future host logs.
> - **Conversation Auto-Follow**: Whenever you start or send a message in any conversation, hooks immediately record the active session and all open monitors follow automatically along with the conversation's Git branch and vault. When passively browsing an older conversation without sending a message, picking it once in any monitor's dropdown syncs all open views.
> - **Quota View Hidden**: Because Antigravity does not yet expose a public Quota API, the **Quota** tab is hidden from user-facing UI while preserving all core code and the pluggable `QuotaProvider` interface for future activation.

---

## Quick Start

### Prerequisites
- **Node.js >= 24.0.0** (uses built-in `node:sqlite`; verify with `node -v`)
- **Git** (for read-only repository fingerprinting; non-Git folders also work smoothly)
- **Google Antigravity**

### Option A: Prebuilt Release Bundle (Recommended, 3 Steps, Zero `npm install`)

1. Download `context-cache-v1.5.4-plugin.zip` (~433 KiB, readable `.mjs` source + pre-bundled single-file UI, zero `node_modules`) from [Releases](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases/latest).
2. Extract into `~/.gemini/config/plugins/` so `plugin.json` lives at `~/.gemini/config/plugins/context-cache/plugin.json`:
   - **Windows PowerShell**:
     ```powershell
     Expand-Archive -Path .\context-cache-v1.5.4-plugin.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
     ```
   - **macOS / Linux**:
     ```bash
     mkdir -p ~/.gemini/config/plugins
     unzip -o context-cache-v1.5.4-plugin.zip -d ~/.gemini/config/plugins
     ```
3. Antigravity discovers and loads the plugin automatically (no restart required):
   - **Left Sidebar**: Open **`Antigravity Hub`** for the full-page console;
   - **Right Aux Pane**: Open **`Antigravity Hub`** from the `+` menu for the compact side pane;
   - **Floating Window**: Click the popout icon in the Monitor toolbar (or enable auto-launch on startup in Settings).

### Option B: Build, Test & Deploy from Source

```powershell
# 1. Clone repository
git clone https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub.git
cd antigravity-hub

# 2. Install dev-only UI build tools (never copied into deployed bundle)
npm install

# 3. Run full 15-file automated test suite (41 test cases, isolated temp dirs)
npm test

# 4. Build single-file MCP App UI and deploy to ~/.gemini/config/plugins/context-cache
npm run deploy

# 5. Run diagnostics / build portable Release zip (with SHA-256)
npm run doctor
npm run pack:release
```

---

## Key Features

### 1. Context Inspector & Asset Inspector Modal
- Aligns live `input_tokens + cache_read_tokens` against the active model's context limit, with interactive model-switch water-level simulation.
- Breaks down usage into `Messages`, `System baseline`, `MCP tools` (eager vs. `deferred`), `Skills`, `Memory & Rules`, and `Custom agents`.
- **Click-Through Asset Inspection**: Inspect read-only redacted source for any rule, skill, or agent (with copy-path and open-file actions), or inspect every tool and token bar inside an MCP server with one-click jump to Governance.
- **Bloat Attribution**: Surfaces top 3 context consumers and zero-token warnings when usage crosses the threshold (default `75%`) or any MCP server exceeds `15K` tokens.

### 2. Multi-Agent Live Calls, TPS Telemetry & Alert Jumps
- Automatically discovers sub-agents launched via `invoke_subagent` (`主`, `子1`, `子2`…) and merges their transcripts for step-level inspection, agent/model summaries, multi-dimensional filtering, and a hero summary bar (steps, token-weighted TPS, estimated cost, active model).
- **1-to-1 Dual-Source Timing & Weighted TPS**: Matches `PreInvocation` → `PostInvocation` `hook_ms` strictly 1-to-1 by `startMs`, falling back cleanly to `hybrid_tool_split` / `transcript_fallback`; calculates token-weighted average TPS.
- **Prefix-Cache Drop Attribution & Step Anatomy**: Classifies drops into `model_changed`, `idle_ttl_expired`, `context_compacted_or_reset`, and `prefix_mutated_unknown` with an expandable anatomy drawer.
- **Zero-Token Clickable Alerts**: Detects 4 alert classes locally (high context, cache drop, sub-agent burst, 3-step low TPS `< 15 tok/s`); clicking an alert jumps straight to the target step or context section. Optionally renders a user-only single-line chat status banner (`systemMessage: ""`).

### 3. Multi-Conversation Auto-Follow, Sub-Agent Retention & Active Aggregation
- **Live Auto-Follow**: Hooks track the latest active conversation and workspace on `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`, keeping all monitors aligned with the active conversation's Git branch, rules, and vault.
- **Active Aggregation & Persistent Sub-Agents**: Recent active sub-agents remain selectable for 2 hours even after returning to the main thread; includes an **"All Running Conversations (Main + Sub)"** aggregate view.
- **Cross-View Sync & Pin Toggle**: Picking a conversation in any view syncs all open monitors; toggle follow/pin anytime.

### 4. Git-Aware Cross-Session Vault & 3-Source Handoff Capsule
- Performs strictly **read-only** Git fingerprint/branch/`HEAD` detection (never writes inside target repos) and isolates `working_state`, `decision`, `architecture`, `pitfall`, and `Stop` checkpoints by `project_id + branch`.
- Auto-redacts secrets (Bearer tokens, API keys, JWTs, PEM private keys) before writing to disk; injects a `< 500 tokens` brief at `SessionStart` with `HEAD` staleness indicators.
- **3-Source Auto-Aggregated Handoff Capsule (0 LLM Tokens)**: Combines Vault decisions, active `transcript.jsonl` (recent user requests, edited files, Artifacts), and live Git changes (`M`/`A`/`?`) + last 2 commits. Supports **Compact (500t) / Standard (1200t) / Full (2500t)** live recalculation, inline editable Active Goal & Next Action, and selectable items with one-click copy or `updateModelContext` attachment.

### 5. Native Frameless Floating Host, Radix Mini Bar, Gemini KV Timer & Settings
- **Auto-Launch on Antigravity Startup**: Opens the frameless floating window once per Antigravity lifecycle (deduplicated by `language_server.exe` PID, auto-closes on exit, toggleable in Settings).
- **Mini Floating Bar 5-Chip Radix Styling & Follow-Cursor Studio**:
  - Distinct light/dark-adaptive Radix UI Colors semantic chips: Context (Indigo), TPS (Violet / low-TPS Amber), KV Countdown (Cyan → Amber → Red), Model (Slate with crisp 1px border), Cache Hit (Green).
  - 5 quick length presets (`Mini 1` to `Full 5`) plus free horizontal drag-resizing; Settings includes a live preview bar with follow-cursor FLIP drag-and-drop and click-to-swap ordering.
- **Gemini KV Cache Freshness Countdown & Three-State Icon**: Zero-token local 1-second countdown after each turn (15m default reference window, customizable) tinting the Hub icon **Blue → Amber → Red**.
- **Native Windows Frameless WebView2 Floating Window**: Launches over an ephemeral `127.0.0.1` port with one-time token auth (falling back to Edge/Chrome `--app` on other platforms), supporting Always-on-Top, quick-collapse mini bar, independent minimize/restore, high-DPI scaling, 8-edge resize, and port release on close.
- **Monitor Safe Restart, Self-Update & 4-Section Settings**: Confirmation-guarded detached **Restart Antigravity** (never touches `app.asar`), manual **Check Updates & SHA-256 Verified One-Click Update** (strict official GitHub Release allowlist, Zip-Slip protection, atomic directory swap with automatic rollback, zero user data touched), plus Settings grouped into General & Language, Monitor & Alerts, Floating Window, and Maintenance & Actions.

### 6. Ecosystem & Harness Governance
- **Effective Harness Stack & Offline 3-in-1 Linter**: Scans Rules, Skills, Hooks, and MCP servers across `P1 Workspace > P2 Global > P3 Plugin > P4 Built-in`, detecting broken MCP targets, shadowed/broken skills (filtering code blocks and placeholder links), and plaintext secrets (auto-redacted) offline.
- **Tiered Remediation & Persistent Ignore**: Skill/config findings open an editable preset prompt modal to send directly to the active Agent (or copy in full-page views) plus batch bundling; heavy MCPs jump to the toggle list; secret alerts offer redacted preview; per-finding ignore updates health scores immediately and is restorable anytime.
- **Multi-Signal Classifier & Interactive Scenario Profiles**: Classifies plugins and global MCPs via weighted bilingual signals across manifest descriptions, `SKILL.md`, MCP tool names, and launch args. Pin core plugins, override categories, preview per-item Rules/Skills/MCP token deltas in a checkbox diff modal, and save as custom profiles in one step.
- **5-Layer Guardrails & Snapshot Time Machine**: Protects `context-cache` from accidental disablement, captures immutable host config snapshots before every write, and supports one-click lossless rollback in UI or via `ctx gov rollback`.

### 7. Local Wallpaper Engine (`Appearance & Wallpaper`)
- **Zero-Intrusion Hot Reload**: Pushes live visual updates through the existing fail-open client runtime without repacking `app.asar`, with instant toggle and CLI emergency disable (`ctx wallpaper off`).
- **Local Library & Read-Only Folders**: Supports external local wallpaper library (15 MiB circuit breaker + Blob cleanup) and 100% read-only folder scanning, with source filtering, custom library subset rotation, 1-minute custom intervals, and dual-buffer crossfade.
- **Real-Time Tuning & Theme Bindings**: Drag sliders for live opacity, blur, saturation, global scrim, panel `scrimOpacity`, and glassmorphism, with independent light/dark theme bindings.

### 8. Antigravity Chinese Localization
- **Zero-Dep Pure Node.js Streaming ASAR Patcher**: Patches `resources/app.asar` in-place while maintaining Electron 4 MiB block SHA-256 `integrity` hashes and preserving `unpacked`/`executable`/`link` metadata.
- **5-State Detection & Clean Backup Guard**: Auto-detects install path, version, and state; never backs up a patched `app.asar` as a clean original.
- **Detached Breakaway Apply/Restore Worker**: On Windows, spawns via WMI `Win32_Process.Create` outside Antigravity's process tree and Job Object to safely close Antigravity, patch/restore `app.asar`, and relaunch.
- **739+ Curated Entries & 3-Layer Hot-Reload**: Merges `custom > community MIT > builtin` into `%USERPROFILE%\.context-cache\i18n\runtime-bundle.json` so dictionary, brand, and immunity edits apply without repacking `app.asar`.
- **Physical Immunity Zones & Update Alerts**: Protects code editors, inputs, terminals, file paths, and custom CSS selectors; alerts automatically when an official Antigravity update overwrites `app.asar`.

---

## Architecture & Design Principles

### Two-Tier Tool Visibility Isolation (0 LLM Tokens for UI Polling)

| Tier | Tools | Visibility | Model Context Impact |
| :--- | :--- | :--- | :--- |
| **Model-Visible (5 slim tools)** | `ctx_open_monitor`, `ctx_brief`, `ctx_save`, `ctx_search`, `ctx_doctor` | `["model", "app"]` | Minimal footprint (~`0.6K` tokens) |
| **App-Only (10 UI private tools)** | `app_get_context_breakdown`, `app_get_calls`, `app_get_quota`, `app_calibrate_quota`, `app_vault_manage`, `app_config_manage`, `app_doctor_action`, `app_i18n_manage`, `app_governance_manage`, `app_appearance_manage` | `["app"]` | **0 tokens** (invisible to model) |

### Five-Layer Anti-Fragile Design
1. **Zero Runtime Dependencies**: Core Engine, Hooks, MCP Stdio Server, and CLI run purely on Node.js 24 native modules (`node:sqlite`, `node:http`, `node:crypto`). Deployed bundles contain **zero `node_modules`**.
2. **External Truth Source + Rebuildable Index**: Markdown and append-only JSONL files live in `%USERPROFILE%\.context-cache` (or `CONTEXT_CACHE_DATA_DIR`). SQLite WAL + FTS5 (`index.sqlite`) can be deleted and rebuilt losslessly anytime.
3. **Thin Fail-Open Hook Adapter**: Registers only `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` (**no `PreToolUse`**). Enforces a 5s hard timeout, camelCase/snake_case normalization, redacted `schema-drift.jsonl`, and a 3-strike circuit breaker that always fails open with `{}` and exit code `0`.
4. **Spaced Windows Path Safety**: `hooks.json` uses relative paths + `--no-warnings`, and portable Release bundles use Antigravity's `${PLUGIN_ROOT}` expansion with zero hardcoded local paths.
5. **Host-Safe Deployment**: Normal monitoring and repair never modify Antigravity binaries or `~/.gemini/config/config.json`.

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

# Ecosystem governance status, offline lint, and host config rollback escape hatch
node --no-warnings bin/ctx.mjs gov status
node --no-warnings bin/ctx.mjs gov lint
node --no-warnings bin/ctx.mjs gov snapshots
node --no-warnings bin/ctx.mjs gov rollback

# Appearance & wallpaper status, rotation, and emergency off
node --no-warnings bin/ctx.mjs wallpaper status
node --no-warnings bin/ctx.mjs wallpaper next
node --no-warnings bin/ctx.mjs wallpaper off

# Antigravity localization status, live bundle refresh, apply, and restore
node --no-warnings bin/ctx.mjs i18n status
node --no-warnings bin/ctx.mjs i18n refresh
node --no-warnings bin/ctx.mjs i18n apply
node --no-warnings bin/ctx.mjs i18n restore
```

---

## Upgrading, Uninstalling & Rollback

### Smooth Upgrade
- **In-App One-Click Update (v1.5.4+ Recommended)**: Open **Settings → Maintenance & Actions**, click **Check Updates**, then click **Update Now (SHA-256)** to verify checksums, atomically swap the plugin directory (auto-rollback on lock/error), and safely restart Antigravity.
- **Prebuilt Bundle Manual Extract**: Download the latest `context-cache-v1.5.4-plugin.zip` and extract over `~/.gemini/config/plugins`. All vault memories, wallpapers, custom dictionaries, governance preferences, and snapshots live in `%USERPROFILE%\.context-cache` with **zero data loss**.
- **Source Users**: Run `git pull && npm run deploy`.

### Clean Uninstall & Lossless Rollback
1. **If you applied Chinese Localization**: Click **Restore Original** in the Localization tab (or run `node --no-warnings ~/.gemini/config/plugins/context-cache/bin/ctx.mjs i18n restore`).
2. **If you switched Governance profiles**: Roll back to your baseline snapshot in **Governance → Snapshots** (or run `ctx gov rollback`).
3. **Remove the plugin**: Delete `~/.gemini/config/plugins/context-cache` (and optionally `%USERPROFILE%\.context-cache` if you also want to remove local memories and cached wallpapers).

---

## FAQ

<details>
<summary><strong>1. Does Antigravity Hub consume my model quota or extra tokens?</strong></summary>

No. Live monitoring refreshes, floating window updates, Asset Inspector previews, Handoff Capsule generation, offline governance linting, wallpaper hot-reloading, and localization run exclusively over private `app`-only tools or local files at **0 LLM token cost**. Only 5 slim tool schemas (~`0.6K` tokens) are visible to the model.
</details>

<details>
<summary><strong>2. Why does the plugin fail with a missing <code>node:sqlite</code> error?</strong></summary>

Ensure **Node.js >= 24.0.0** is installed (`node -v`). Antigravity Hub relies on Node 24's built-in `node:sqlite` to maintain zero runtime dependencies.
</details>

<details>
<summary><strong>3. Will Localization or Wallpaper break Antigravity after an official update?</strong></summary>

- **Wallpaper**: Introduces zero new ASAR injection points and can be disabled instantly in UI or via `ctx wallpaper off`.
- **Localization**: Preserves a verified clean `app.asar` backup before patching and supports one-click restore. If an official Antigravity update overwrites `app.asar`, the app continues running normally and the Hub displays an update reminder to re-apply in one click.
</details>

<details>
<summary><strong>4. Does it write temporary files into my Git repositories?</strong></summary>

**Never.** Target workspaces are strictly read-only. All plugin data, indexes, snapshots, and wallpapers live under `%USERPROFILE%\.context-cache`. Secrets (API keys, Bearer tokens, JWTs, PEM keys) are auto-redacted, and asset previews strictly enforce root whitelists while rejecting `.env` and private key files.
</details>

---

## Repository Structure

```text
context-cache/
├── bin/ctx.mjs                          # Host-agnostic CLI (vault / monitor / doctor / gov / wallpaper / i18n)
├── src/
│   ├── core/                            # Zero-dependency Node.js 24 core engine
│   │   ├── paths.mjs                    # Cross-platform paths & external data directory resolution
│   │   ├── config.mjs                   # Config, model limits, pricing, mini-bar layout & calibration
│   │   ├── redact.mjs                   # Secret & credential redaction filter
│   │   ├── git-context.mjs              # Read-only Git inspection (branch, changed files, recent commits)
│   │   ├── storage.mjs                  # Atomic Markdown / JSONL truth-source I/O
│   │   ├── index-db.mjs                 # node:sqlite WAL + FTS5 derived index & lossless rebuild
│   │   ├── vault.mjs                    # Cross-session memory CRUD, Compact Brief & 3-source Handoff Capsule
│   │   ├── context-inspector.mjs        # Context breakdown, asset metadata, redacted preview & bloat analysis
│   │   ├── transcript-parser.mjs        # Incremental multi-version transcript parser & sub-agent discovery
│   │   ├── telemetry.mjs                # Multi-agent calls, TPS, cache-drop attribution & 4 alert classes
│   │   ├── session-tracker.mjs          # Active conversation auto-follow & cross-view sync
│   │   ├── quota.mjs                    # 5h/7d sliding window, calibration & QuotaProvider hook
│   │   ├── popout-server.mjs            # 127.0.0.1 token-authenticated floating host server
│   │   ├── win-floating-host.ps1        # Windows native frameless WebView2 floating window host
│   │   ├── client-restart.mjs           # Detached safe Antigravity restart (never touches app.asar)
│   │   ├── self-update.mjs              # GitHub Release update check, SHA-256 verification & atomic swap
│   │   ├── doctor.mjs                   # Diagnostics, schema-drift report, backup export & self-healing
│   │   ├── governance/                  # Ecosystem governance (scanner, classifier, profiles, linter, snapshots)
│   │   ├── appearance/                  # Local wallpaper engine (library, read-only scan, rotation, fallback)
│   │   └── i18n/                        # Zero-dep streaming ASAR localization engine & dictionaries
│   ├── adapters/antigravity/            # Thin fail-open Hook adapter (5s timeout, 3-strike circuit breaker)
│   ├── mcp/server.mjs                   # Zero-dep MCP Stdio Server (5 Model + 10 App-Only tools)
│   └── ui/                              # Self-contained single-file modular console frontend
│       ├── index.html                   # Console shell & Asset Inspector / Capsule / Settings modals
│       ├── styles.css                   # Light/dark Radix UI Colors theme & Mini Bar semantic chips
│       ├── app.mjs                      # Monitor UI, alert jump-to-step & floating host integration
│       ├── i18n-ui.mjs                  # Zero-dep zh-CN / English UI dictionary
│       ├── build-ui.mjs                 # esbuild single-file bundler
│       └── modules/                     # appearance-module / governance-module / i18n-module
├── plugin/                              # Antigravity plugin manifest, hooks, rules, skills & logo
├── scripts/                             # deploy.mjs, pack-release.mjs & doctor.mjs
├── tests/                               # 15 automated test suites (41 E2E / unit / resilience test cases)
├── LICENSE                              # MIT License
├── README.md                            # Simplified Chinese documentation
├── README.en.md                         # English documentation
└── package.json
```

---

## License

Licensed under the [MIT License](./LICENSE).
