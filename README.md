# context-cache

Host-agnostic context cache, multi-agent TPS & prefix-cache telemetry, 5h/7d sliding quota windows, and native Antigravity MCP App plugin.

## Architecture Highlights

- **Zero Runtime Dependencies**: Core Engine, Hooks, MCP Stdio Server, and CLI run purely on Node.js 24 native modules (`node:sqlite`, `node:http`, `node:crypto`). UI bundles `@modelcontextprotocol/ext-apps` at build time via `esbuild` into one self-contained `dist/dashboard.html`; deployed plugin contains **zero `node_modules`**.
- **Two-Tier Tool Visibility (0 LLM Tokens for Live UI)**:
  - **5 slim model-visible tools**: `ctx_open_monitor`, `ctx_brief`, `ctx_save`, `ctx_search`, `ctx_doctor`.
  - **7 app-only tools (`visibility: ["app"]`)**: `app_get_context_breakdown`, `app_get_calls`, `app_get_quota`, `app_calibrate_quota`, `app_vault_manage`, `app_config_manage`, `app_doctor_action`.
- **External Truth Source & Zero Repo Pollution**: Markdown + append-only JSONL truth sources live in `%USERPROFILE%\.context-cache` (overridable via `CONTEXT_CACHE_DATA_DIR`). SQLite WAL + FTS5 (`index.sqlite`) is a rebuildable derived index. Target Git repositories are inspected strictly read-only.
- **Anti-Fragile Hook Adapter**: `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` (no `PreToolUse`). 5s hard timeout, camelCase/snake_case schema normalization, redacted `schema-drift.jsonl`, 3-strike Fail-Open circuit breaker always returning `{}` with exit code `0`.

## Quick Commands

```powershell
# Run full test suite (7 test files, isolated temp dirs)
npm test

# Build single-file MCP App UI + deploy pure bundle to ~/.gemini/config/plugins/context-cache
npm run deploy

# Run health diagnostics (or self-healing repair)
npm run doctor
node --no-warnings scripts/doctor.mjs --repair
```
