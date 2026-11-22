# Context Cache Protocol

Use the `context-cache-server` slim tools intentionally without bloating context:

- `ctx_open_monitor`: Open the native Context & Telemetry console in the side pane when the user asks to inspect context usage, TPS, cache hit rate, quota windows, or cross-session memory.
- `ctx_brief`: Fetch the `<500` token project brief on demand if needed mid-session.
- `ctx_save`: Persist high-value `decision`, `working_state`, `architecture`, or `pitfall` entries after material decisions (secrets are auto-redacted; never write raw keys).
- `ctx_search`: Query cross-session project memory via FTS5 before repeating solved investigations.
- `ctx_doctor`: Run diagnostics or `--repair` if hooks, index sync, or telemetry report anomalies.

Never write plugin cache files inside the target business repository; all truth sources live in `%USERPROFILE%\.context-cache`.
