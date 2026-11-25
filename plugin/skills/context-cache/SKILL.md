---
name: context-cache
description: >-
  Deep operations handbook for Antigravity Hub (context-cache v1.5.5): 3-source
  budgeted handoff capsules, mounted asset inspection, prefix-cache drop diagnosis,
  ecosystem governance snapshots, local wallpaper & localization recovery, and
  anti-fragile Doctor repair.
---

# Antigravity Hub Operations Handbook (v1.5.5)

## 1. 3-Source Handoff Capsule Workflow (Context > 75%)

1. Open **Antigravity Hub** (`ctx_open_monitor`) or switch to the **上下文 / Context** tab and click **生成交接胶囊**.
2. Choose a token budget tier (**紧凑 500t / 标准 1200t / 完整 2500t**) — the capsule automatically aggregates Vault decisions, active `transcript.jsonl` (recent user requests, edited files, Artifact paths), and live Git changes (`M`/`A`/`?`) + last 2 commits at 0 LLM tokens.
3. Edit **Active Goal** and **Next Action** inline, toggle individual decisions/files/artifacts, and inspect the redacted payload.
4. Click **复制交接胶囊** or **存入并附着到下条消息** (in Aux Pane via `updateModelContext`) before running `/compact` or starting a fresh session.

## 2. Mounted Asset Inspection & Prefix-Cache Drop Diagnosis

- **Mounted Asset Modal**: Click any rule, skill, or custom agent card to inspect its read-only redacted source (enforces root whitelist + `.env`/key blocking) with copy-path and open-file actions; click any MCP server to inspect its full tool breakdown and jump to Governance.
- **Alert Jump & Step Anatomy**: Click any alert row to collapse the banner and jump straight to the offending step in **明细 / Calls** (expanding the inline anatomy drawer with highlight pulse). Filter by **仅看缓存击穿** to inspect drop causes:
  - `model_changed`: Expected cold rebuild after switching models.
  - `idle_ttl_expired`: Idle gap exceeded prefix cache TTL (~5m+); batch follow-ups to preserve warm cache.
  - `context_compacted_or_reset`: Triggered by `/compact` or history reset.
  - `prefix_mutated_unknown`: System rules, MCP tool schemas, or early message prefix mutated.

## 3. Ecosystem Governance, Wallpaper & Localization Recovery

- **Governance Rollback**: Every profile switch or toggle captures an immutable snapshot first. Roll back anytime from **生态治理 → 快照** or CLI `node --no-warnings bin/ctx.mjs gov rollback`.
- **Wallpaper Emergency Off**: Local wallpaper engine introduces zero new ASAR injection points; disable instantly in UI or via `node --no-warnings bin/ctx.mjs wallpaper off`.
- **Localization Restore**: Pure Node.js streaming ASAR patcher reads the real `app.asar` `package.json` version and enforces an anti-downgrade guard against stale `.bak` files; restore anytime in **界面汉化** or via `node --no-warnings bin/ctx.mjs i18n restore`.

## 4. Antigravity Update Recovery (`Doctor`)

All truth sources live outside the plugin and target repos in `%USERPROFILE%\.context-cache` (Markdown + append-only JSONL). SQLite WAL + FTS5 (`index.sqlite`) is purely a rebuildable derived index.

If an Antigravity update changes hook payload schemas:
1. Hooks automatically fall back (camelCase/snake_case), record redacted entries in `diagnostics/schema-drift.jsonl`, and Fail-Open with `{}` (circuit breaker trips after 3 consecutive errors).
2. Run `ctx_doctor` with `repair: true` (or CLI `npm run doctor -- --repair` / `node --no-warnings bin/ctx.mjs doctor --repair`) to atomically rebuild SQLite FTS5 from truth sources, reset the circuit breaker, and verify zero `node_modules` deployment integrity. Append `--resync-telemetry` to recompute and compact historical TPS telemetry from local transcripts.
3. Export a sanitized backup anytime from **插件设置 → 导出备份** or `node --no-warnings bin/ctx.mjs export`.
