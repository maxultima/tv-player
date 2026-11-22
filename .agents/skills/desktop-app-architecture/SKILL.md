---
name: desktop-app-architecture
description: >-
  Use this skill when designing, implementing, or reviewing Windows desktop
  applications (e.g. Tauri v2 with Rust + TypeScript/Vite). Covers IPC boundaries,
  event-driven architecture, i18n, actionable structured logging with rotation,
  and local SQLite storage with encrypted secrets.
---

# Desktop Application Architecture & Conventions

Follow these rules when building or maintaining desktop applications (such as Tauri v2 + Rust + TypeScript/Vite on Windows).

## 1. Architecture, IPC & Runtime Behavior

- **Clean IPC boundary**: Centralize all frontend-to-backend calls in a single IPC module (e.g. `src/ipc/commands.ts`). Provide an in-memory mock fallback for `dev` mode outside Tauri so the UI can be developed without Rust; never enable mocks in production.
- **Serialization conventions**: Use `camelCase` for JSON payloads and `invoke` parameters (`#[serde(rename_all = "camelCase")]` in Rust), and `snake_case` for Rust identifiers and Tauri command names.
- **Event-driven over polling**: Never introduce new background polling threads just to check state. Prefer event-driven wakeups triggered by actual changes. Any new polling thread requires explicit user approval in the current task.
- **No-op operations stay silent**: If an operation does not change the current value/state, do not write to storage/config and do not display a notification.
- **Quiet automatic actions vs. loud user actions**: Automatic/background actions (startup, wake recovery, scheduled tasks, watchdogs) must be silent — never show error toasts or discard state. Show toasts and perform loud cleanup only after direct user interaction (click, keypress, completed login).
- **Windows build hygiene**: Before building a Windows executable/installer, stop any running instance of the app (which locks the `.exe`), and clean stale build artifacts (`target/` debug profiles / old bundles) as part of release builds.

## 2. Internationalization (i18n)

- **Externalize UI strings**: Use an i18n layer (e.g. EN/CS dictionaries) instead of hardcoding user-facing strings in components.
- **Keep translations in sync**: Whenever adding or changing UI labels, tooltips, dialogs, or status messages, update all supported locale files together.

## 3. Structured Logging & Rotation

- **Actionable without re-simulation**: Logs must contain enough concrete detail to diagnose root causes purely from the log file, without needing to reproduce/re-simulate the issue in the app:
  - Include full file/directory paths, relevant setting values, counts, and the **reason for each decision** (which branch was taken and why).
  - Errors must include the failing file/command, tool output, and retry count — never log vague messages like "failed".
  - Log both errors and **successful completions** of meaningful operations.
- **Consistent format**: Include a timestamp, module/feature code, level, and message (e.g. `HH:MM:SS [NNN] LEVEL text`).
- **No log bloat**: Never emit repetitive, monotonous, or meaningless log lines that inflate log files:
  - Do not log `\r` progress lines one by one.
  - Do not log routine background checks that found nothing and made no decision.
  - Do not log UI redraws or no-op actions.
- **Rolling & retention**: Implement automatic log rolling (e.g. daily files `app-YYYY-MM-DD.log`) and automatic cleanup/deletion of old log files. Explicitly decide upfront how cleanup works and where the retention period setting comes from (e.g. app settings/DB, config file, or fixed default); if unclear, ask the user.
- **Never log secrets**: API keys, tokens, and passwords must never appear in logs.

## 4. Local Storage, Configuration & Secrets

- **Choose storage upfront**: At the start of a project, explicitly decide whether the application needs a local database (SQLite) or whether a simple JSON configuration file is sufficient. If unclear, ask the user before implementing persistence.
- **Canonical SQLite schema (when using a database)**: Keep a single canonical `SCHEMA` (`CREATE TABLE`) and a schema check in the data layer (e.g. `storage.rs`) rather than embedding migration frameworks or migration scripts in the app. Reject outdated schemas with a clear user-facing message; migrate existing databases externally when schema changes are implemented.
- **In-memory unit tests**: Test the data layer using in-memory SQLite (`Database::open_in_memory()`) with no on-disk fixture files or persistent test databases.
- **Encrypted secrets**: Store sensitive credentials (API keys, tokens) encrypted using **AES-256-GCM** (e.g. with a versioned prefix like `enc:v1:`). Reject plaintext secrets and never return or log decrypted values unnecessarily.
