---
name: context-cache
description: >-
  Deep operations handbook for the context-cache plugin: cross-session handoff capsules,
  prefix cache drop diagnosis, multi-agent TPS telemetry, 5h/7d quota baseline calibration,
  and anti-fragile recovery after Antigravity host updates.
---

# Context Cache Operations Handbook

## 1. Handoff Capsule Workflow (Context > 75%)

1. Open the monitor (`ctx_open_monitor`) or switch to the **Context** tab and click **生成交接胶囊**.
2. In **易读视图**, review the current goal and toggle individual decisions to stay strictly under `< 500 tokens`.
3. Optionally inspect **Agent 原文** (`[CTX-CAPSULE] ...`) to verify exact payload density.
4. Click **存入并附着到下条消息** (in Aux Pane) to attach the capsule via `updateModelContext`, or **仅存入记忆库** before running `/compact` or starting a fresh session.

## 2. Prefix Cache Drop Diagnosis

In the **明细** tab, enable **仅看缓存击穿** and click any row to open the inline step anatomy drawer:
- `model_changed`: Expected cold rebuild after switching models.
- `idle_ttl_expired`: Idle gap exceeded prefix cache TTL (~5m+); batch follow-ups to preserve warm cache.
- `context_compacted_or_reset`: Triggered by `/compact` or history reset.
- `prefix_mutated_unknown`: System rules, MCP tool schemas, or early message prefix mutated.

## 3. Quota Sliding Window & Calibration

- `context-cache` never probes undocumented internal Quota RPCs.
- Open the **额度** tab and click **校准基线** to input remaining `%` and reset countdown from Antigravity Settings; subsequent local calls deduct weighted usage automatically and roll over cleanly after reset.

## 4. Antigravity Update Recovery (`Doctor`)

All truth sources live outside the plugin and target repos in `%USERPROFILE%\.context-cache` (Markdown + append-only JSONL). SQLite WAL + FTS5 (`index.sqlite`) is purely a rebuildable derived index.

If an Antigravity update changes hook payload schemas:
1. Hooks automatically fall back (camelCase/snake_case), record redacted entries in `diagnostics/schema-drift.jsonl`, and Fail-Open with `{}` (circuit breaker trips after 3 consecutive errors).
2. Run `ctx_doctor` with `repair: true` (or CLI `npm run doctor -- --repair` / `node bin/ctx.mjs doctor --repair`) to rebuild SQLite FTS5 from truth sources, reset the circuit breaker, and verify zero `node_modules` deployment integrity.
3. Export a sanitized backup anytime from **插件设置 → 导出备份** or `node bin/ctx.mjs export`.
