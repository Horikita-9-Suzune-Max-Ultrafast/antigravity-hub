# Antigravity Hub

[简体中文](./README.md) | **English**

**Modular Native Control Center (MCP App) for Google Antigravity: Context Cache & Usage Stats, Local Code Review, Ecosystem & Harness Governance, Local Wallpaper Engine, and Zero-Dep Chinese Localization**

[![Version: v1.6.1](https://img.shields.io/badge/Version-v1.6.1-0ea5e9.svg)](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases/tag/v1.6.1)
[![Antigravity 2.36.0 Update Verified](https://img.shields.io/badge/Antigravity%202.36.0-Update%20Verified-10b981.svg)](#battle-tested-official-update-survival-proof)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/Runtime%20Deps-0-brightgreen.svg)](#architecture--design-principles)

> **Core Commitments**: **0 LLM tokens** consumed by live monitoring & UI ｜ **Zero files written** inside your business repositories ｜ **Zero runtime dependencies** (no `node_modules`) ｜ **Battle-tested through live official Antigravity updates with zero data loss & one-click rollback**

---

## Quick Navigation

- [Five Core Modules at a Glance](#five-core-modules-at-a-glance)
- [Battle-Tested: Official Update Survival Proof](#battle-tested-official-update-survival-proof)
- [What's New in v1.6.1 & v1.6.0](#whats-new-in-v161--v160)
- [Quick Start (3-Step Prebuilt Bundle)](#quick-start)
- [Key Features](#key-features)
- [Architecture & Design Principles](#architecture--design-principles)
- [CLI Usage](#cli-usage)
- [Upgrading, Uninstalling & Rollback](#upgrading-uninstalling--rollback)
- [FAQ](#faq)
- [Repository Structure](#repository-structure)

---

## Five Core Modules at a Glance

**Antigravity Hub** ships with a responsive dual-layout shell—a fixed `56px` left icon rail on wide viewports (`> 680px`) that collapses into a compact 5-module top bar in narrow side panes (`<= 680px`)—with **instant zh-CN / English language switching** without reloading.

| Module | Pain Point Solved | Core Capabilities |
| :--- | :--- | :--- |
| **1. Context Cache & Monitor** | Slow turns, unexplained prefix-cache drops, opaque context bloat, no cross-session cumulative spend view | 6-category context breakdown, **Cross-Session Cumulative Usage Stats (`Today/24h/7d/30d/All` + CNY/USD)**, click-through Asset Inspector, one-click Alert jump-to-step, main/sub-agent Decode TPS & TTFT, **Win32 120fps per-pixel alpha Orb with shared-anchor morphing Mini Bar**, unified pill Gemini KV timer, 3-source Handoff Capsule |
| **2. Local Code Review** | Missing hardcoded secrets/merge conflicts/empty catches before commit, tedious manual lint/test, AI review polluting main chat context | Zero-dep Git diff parser (`uncommitted / staged / last_commit / branch`), **8 millisecond L1 static security & quality rules** (added lines only), whitelisted native project gates (`lint/typecheck/test/ruff/mypy/cargo/go`), **L2 isolated subagent review & one-click fix prompt**, persistent ignores & 20-report history |
| **3. Ecosystem & Harness Governance** | Too many plugins/MCPs bloating every session; manual toggling across workflows risks disabling essentials | Effective Harness stack (`P1 Workspace` → `P4 Built-in`), **4-Pillar continuous health scoring**, offline 3-in-1 linter with tiered remediation, multi-signal classifier & interactive scenario profiles, pinned core plugins, immutable snapshots & CLI rollback |
| **4. Local Wallpaper Engine**<br>`Appearance & Wallpaper` | Plain default UI without risking fragile ASAR repacking for visual customization | Zero-new-ASAR hot reload, external local wallpaper library (15 MiB breaker) + 100% read-only local folder scanning, custom rotation pools with dual-buffer crossfade, live slider tuning, light/dark theme bindings, instant & CLI emergency off |
| **5. Antigravity Localization** | English-only native menus and UI; fear of third-party patches translating code or breaking updates | Pure Node.js streaming ASAR patcher (maintains 4 MiB SHA-256 integrity), 739+ curated entries, 3-layer hot-reloaded external dictionary, physical immunity zones (code/terminal/paths), true `app.asar` version anti-downgrade guard & one-click restore |

---

## Battle-Tested: Official Update Survival Proof

The biggest fear with any client-enhancing plugin is simple: **"Will the next official Antigravity update lock the installer, break my IDE, wipe my data, or restore a stale backup?"**

We intentionally ran live, in-place official upgrades through **Antigravity `2.35.1` → `2.35.2` → `2.36.0`** (Electron `44.9.1`) while keeping the full "dirty production state" active — **ASAR localization ON + local wallpaper ON + native floating window running**, with **no pre-uninstall and no pre-restore** — and audited all 6 anti-fragility guarantees end to end:

| Anti-Fragility Check | Result | Verified Runtime Behavior |
| :--- | :---: | :--- |
| **1. Zero Installer Locks & Zero Orphan Processes** | **PASS** | Official updater cleanly overwrote `app.asar` and cold-started with `--updated` (zero file-lock errors or blank screens); old host processes exited cleanly, leaving exactly one healthy `language_server` (`2.36.0`) → MCP Server → Win32 native WebView2 floating host tree |
| **2. 100% External Truth-Source Retention** | **PASS** | Verified item-by-item post-upgrade: Vault memories (232/232), deduplicated SQLite call index (3,325/3,325), user config & model parameters, 1,972 active dictionary entries, and the local wallpaper library (5 images) & rotation schedule all survived with zero loss |
| **3. Automatic Clean `.bak` Refresh & Anti-Downgrade** | **PASS** | Post-upgrade detection accurately identified `outdated_after_update` + true `2.36.0` version and blocked stale-backup downgrade; isolated E2E apply/restore on the real `2.36.0` `app.asar` verified byte-exact `.bak` creation from `current_clean_asar`, clean `dist/main.js` + `dist/preload.js` injection, and byte-identical one-click restore |
| **4. Automatic Wallpaper Recovery (Zero Re-Setup)** | **PASS** | Because the wallpaper engine adds zero new ASAR injection points, the existing library, rotation schedule, opacity, blur, scrim, and glass parameters came right back automatically |
| **5. Hooks, Transcript & Native DB Compatibility** | **PASS** | `SessionStart` brief injection, `PreInvocation`/`PostInvocation` timing, `transcript_full.jsonl`, and native `conversations/<id>.db` (nanosecond TTFT, Decode TPS & thinking/content token split) worked out of the box; `ctx_doctor` reported `HEALTHY (v1.6.1)`, `0` schema drift, and circuit breaker `CLOSED (0/3)` |
| **6. Ecosystem Governance & Regression Suite** | **PASS** | All plugins (9/9), MCP servers (4/4), skills (78/78), rules (3/3), and hooks (4/4) remained intact (0 errors, 0 secrets), and all **86 automated tests** across 21 test suites passed |

> Even if a future Antigravity release changes internal hook schemas, hooks fail open with `{}`, record redacted entries to `schema-drift.jsonl`, and trip the 3-strike circuit breaker so your conversations are never blocked. Running `ctx doctor --repair` rebuilds the SQLite index and resets state losslessly.

---

## What's New in v1.6.1 & v1.6.0

- **Gemini 512K Default Context Window & Model/Parameter Editor Modal (v1.6.1)**: Adjusted default Gemini context window to `512K` to match Antigravity's observed auto-compact threshold (added `gemini-4-carbon` limits & pricing with lossless `v1 → v2` config migration preserving custom overrides); added a dual-entry **Model & Parameter Editor** modal (from the Context `used / limit` card and Settings) with one-click Gemini `256K / 512K / 1.00M` presets, per-model limit & custom prefix editing, alert threshold & FX tuning, and a visual pricing editor; added a `512K` simulator tier and UTF-8 / i18n trie bundling, slimming the single-file UI further to **`466.6 KiB`**.
- **New 5th Top-Level Module: Local Code Review (v1.6.0)**: Zero-dependency Git diff parser (`uncommitted / staged / last_commit / branch`, auto-folding lockfiles/dist/binaries); 8 millisecond L1 static security & quality rules (scanning added lines only); whitelisted native project gate detection & manual runner (`lint / typecheck / test / ruff / mypy / cargo / go vet`); L2 isolated subagent deep-review prompt builder, JSON report import, persistent ignores, 20-report history, and checkbox-driven targeted fix instructions.
- **Cross-Session Cumulative Usage Stats Tab (v1.6.0)**: Added a **Stats** tab (`Context / Calls / Stats / Vault`) backed by SQLite aggregation over all historical calls with `Today / 24h / 7d / 30d / All` time ranges and model filtering; displays cumulative Tokens (input / output / cache breakdown), total requests, timezone-aware `¥ CNY` / `$ USD` cost toggle, cache hit rate progress bar, weighted Decode TPS & average TTFT, and per-model breakdown.
- **Win32 Native 120fps Per-Pixel Alpha Orb, Shared-Anchor Morphing & Compiled `.exe` Cache (v1.6.0)**: Compiles and caches `floating-host-<hash>.exe` via built-in `.NET 4 csc.exe` (`< 5ms` cache hit); native 60–240Hz DWM drag & resize; minimizes into a crisp `WS_EX_LAYERED` + `UpdateLayeredWindow` 48px anti-aliased circular Orb with soft elevation shadow, live telemetry ring, and native right-click menu; Orb ↔ Mini Bar share one focal anchor with a continuous **220ms `cubic ease-out` Dynamic-Island pill morph & opacity crossfade**, shared width sync, and exact vertical centering across high-DPI scales.
- **4-Pillar Governance Scoring & Core Engine Performance Overhaul (v1.6.0)**: Unified `ecosystem-inventory.mjs` scanner (honoring plugin enabled state and splitting `eager` vs. `deferred` MCP tokens) with continuous 4-pillar health scoring; incremental byte-offset transcript parsing, 5×→1× Git subprocess convergence, `WeakMap` SQLite prepared-statement cache, and `rev` digest short-circuiting.
- **Zero-Zod -34% Bundle Diet & Unified Radix Visual System (v1.6.0 → v1.6.1)**: Replaced heavy SDK + `zod` with a lightweight native SEP-1865 MCP App bridge, slimming the single-file UI from `706 KiB` down to **`466.6 KiB`**; standardized on Radix UI Colors 12-step scales, 4 font sizes, and a unified KV countdown pill with clickable help popover; **86 automated tests passing**.

<details>
<summary><strong>Previous Highlights (v1.5.5)</strong></summary>

- **GPU 99% Spike Elimination & Instant Popout Close Sync (v1.5.5)**: Removed CSS `backdrop-filter`, infinite animations, forced `offsetWidth` reflows, and 5s bounds polling; gated 1s KV timer and added `lowPowerMode` for wallpapers.
- **Viewport-Clamped Floating Menus, Responsive Titlebar & Dynamic Calls Table (v1.5.5)**: Upgraded all popovers/menus to viewport `position: fixed` clamping and dynamic Calls table column allocation.
- **Native SQLite Nanosecond TTFT & Decode TPS Engine (v1.5.5)**: Added zero-dep read-only `native-step-metrics.mjs` extracting nanosecond TTFT, pure decode duration, and exact thinking/content token splits with Plan A fail-open fallback.
- **True `app.asar` Version Detection & Anti-Downgrade Guard (v1.5.5)**: Prioritizes `app.asar` `package.json` version and validates `.bak` backups on both apply and restore paths.
- **Atomic SQLite WAL Rebuild & Backend Security Hardening (v1.5.5)**: Transactional `rebuildIndex()` and constant-time `crypto.timingSafeEqual` popout token checks.

</details>

<details>
<summary><strong>Previous Highlights (v1.5.4)</strong></summary>

- **Click-Through Asset Inspector Modal (v1.5.4)**: Click any mounted rule, skill, or custom agent card to inspect its read-only redacted source (strict root whitelist + symlink protection + secret redaction, with copy-path and open-file actions). Click any MCP server to view its full tool breakdown table, per-tool token bar, and jump straight to Governance.
- **One-Click Alert Jump-to-Step (v1.5.4)**: Every alert row is clickable—clicking a cache-drop, low-TPS, or sub-agent alert collapses the banner, switches to **Calls**, scrolls directly to the offending step, expands its anatomy drawer, and pulses a highlight; high-context alerts jump directly to the breakdown section.
- **3-Source Auto-Aggregated Handoff Capsule (v1.5.4)**: Zero-token aggregation across Vault decisions, active `transcript.jsonl` (recent user requests, edited files, produced Artifacts), and live Git changes (`M`/`A`/`?`) + last 2 commits. Choose **Compact (500t) / Standard (1200t) / Full (2500t)** with live recalculation, inline editable Active Goal & Next Action, and per-item checkboxes.
- **Radix Mini Bar Chips & Unified Visual Polish (v1.5.3 → v1.5.4)**: Native Windows frameless floating window with startup auto-launch, follow-cursor FLIP drag reordering, and 5 length presets. Assigns light/dark-adaptive Radix UI Colors semantic chips to all 5 mini bar modules and eliminates all unstyled native `<button>` elements.
- **Focused Local Wallpaper Library (v1.5.4)**: Removed built-in gradient presets to keep the gallery clean; legacy configs pointing to removed preset IDs silently fall back to the first local wallpaper or disabled state with zero errors.

</details>

> [!NOTE]
> **Known Host Boundaries**
> - **Time-to-First-Token (TTFT) & Exact Thinking Split**: Since `v1.5.5`, Antigravity Hub reads nanosecond-level TTFT, pure Decode TPS, and self-verified thinking/content token splits read-only (`node:sqlite` `{ readOnly: true }`) from Antigravity's local `conversations/<id>.db`, automatically failing open to transcript + tool-execution stripping if the DB is unavailable or changes schema.
> - **Conversation Auto-Follow**: Whenever you start or send a message in any conversation, hooks immediately record the active session and all open monitors follow automatically along with the conversation's Git branch and vault. When passively browsing an older conversation without sending a message, picking it once in any monitor's dropdown syncs all open views.
> - **Quota View Hidden**: Because Antigravity does not yet expose a public Quota API, the **Quota** tab is hidden from user-facing UI while preserving all core code and the pluggable `QuotaProvider` interface for future activation.

---

## Quick Start

### Prerequisites
- **Node.js >= 24.0.0** (uses built-in `node:sqlite`; verify with `node -v`)
- **Git** (for read-only repository fingerprinting; non-Git folders also work smoothly)
- **Google Antigravity**

### Option A: Prebuilt Release Bundle (Recommended, 3 Steps, Zero `npm install`)

1. Download `context-cache-v1.6.1-plugin.zip` (readable `.mjs` source + pre-bundled single-file UI, zero `node_modules`) from [Releases](https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases/latest).
2. Extract into `~/.gemini/config/plugins/` so `plugin.json` lives at `~/.gemini/config/plugins/context-cache/plugin.json`:
   - **Windows PowerShell**:
     ```powershell
     Expand-Archive -Path .\context-cache-v1.6.1-plugin.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
     ```
   - **macOS / Linux**:
     ```bash
     mkdir -p ~/.gemini/config/plugins
     unzip -o context-cache-v1.6.1-plugin.zip -d ~/.gemini/config/plugins
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

# 3. Run full 21-file automated test suite (86 test cases, isolated temp dirs)
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
| **App-Only (11 UI private tools)** | `app_get_context_breakdown`, `app_get_calls`, `app_get_quota`, `app_calibrate_quota`, `app_vault_manage`, `app_config_manage`, `app_doctor_action`, `app_i18n_manage`, `app_governance_manage`, `app_appearance_manage`, `app_review_manage` | `["app"]` | **0 tokens** (invisible to model) |

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

# Run diagnostics / self-healing repair (rebuild FTS5 index + reset circuit breaker; add --resync-telemetry to recompute historical TPS)
node --no-warnings bin/ctx.mjs doctor
node --no-warnings scripts/doctor.mjs --repair
node --no-warnings bin/ctx.mjs doctor --repair --resync-telemetry

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
- **Prebuilt Bundle Manual Extract**: Download the latest `context-cache-v1.6.1-plugin.zip` and extract over `~/.gemini/config/plugins`. All vault memories, wallpapers, custom dictionaries, governance preferences, and snapshots live in `%USERPROFILE%\.context-cache` with **zero data loss**.
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
- **Localization**: Preserves a verified clean `app.asar` backup before patching and supports one-click restore. Battle-tested through live in-place upgrades to **Antigravity `2.35.1` → `2.35.2` → `2.36.0`** with localization, wallpaper, and the floating window all running: the app starts normally after the update overwrites `app.asar`, the Hub prompts for a one-click re-apply, `.bak` is automatically refreshed with the new clean original (preventing accidental downgrade), and your wallpaper settings return automatically.
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
│   │   ├── native-step-metrics.mjs      # Zero-dep read-only native DB reader (nanosecond TTFT, decode duration & exact thinking split)
│   │   ├── telemetry.mjs                # Multi-agent calls, Decode TPS, tool-exec stripping, cache-drop attribution & 4 alert classes
│   │   ├── session-tracker.mjs          # Active conversation auto-follow & cross-view sync
│   │   ├── quota.mjs                    # 5h/7d sliding window, calibration & QuotaProvider hook
│   │   ├── popout-server.mjs            # 127.0.0.1 token-authenticated floating host server
│   │   ├── win-floating-host.ps1        # Windows native frameless WebView2 floating window host
│   │   ├── client-restart.mjs           # Detached safe Antigravity restart (never touches app.asar)
│   │   ├── self-update.mjs              # GitHub Release update check, SHA-256 verification & atomic swap
│   │   ├── doctor.mjs                   # Diagnostics, schema-drift report, backup export & self-healing
│   │   ├── review/                      # Local code review engine (Git diff parser, L1 static rules, native gates, L2 subagent flow)
│   │   ├── governance/                  # Ecosystem governance (scanner, 4-pillar scoring, classifier, profiles, linter, snapshots)
│   │   ├── appearance/                  # Local wallpaper engine (library, read-only scan, rotation, fallback)
│   │   └── i18n/                        # Zero-dep streaming ASAR localization engine & dictionaries
│   ├── adapters/antigravity/            # Thin fail-open Hook adapter (5s timeout, 3-strike circuit breaker)
│   ├── mcp/server.mjs                   # Zero-dep MCP Stdio Server (5 Model + 11 App-Only tools)
│   └── ui/                              # Self-contained single-file modular console frontend
│       ├── index.html                   # Console shell & Asset Inspector / Capsule / Settings modals
│       ├── styles.css                   # Light/dark Radix UI Colors theme & Mini Bar semantic chips
│       ├── app.mjs                      # Monitor UI, alert jump-to-step & floating host integration
│       ├── i18n-ui.mjs                  # Zero-dep zh-CN / English UI dictionary
│       ├── build-ui.mjs                 # esbuild single-file bundler
│       └── modules/                     # review-module / appearance-module / governance-module / i18n-module
├── plugin/                              # Antigravity plugin manifest, hooks, rules, skills & logo
├── scripts/                             # deploy.mjs, pack-release.mjs & doctor.mjs
├── tests/                               # 21 automated test suites (86 E2E / unit / resilience test cases)
├── LICENSE                              # MIT License
├── README.md                            # Simplified Chinese documentation
├── README.en.md                         # English documentation
└── package.json
```

---

## License

Licensed under the [MIT License](./LICENSE).
