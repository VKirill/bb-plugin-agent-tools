---
title: OpenCode provider and model management
type: component
created: 2026-09-27
updated: 2026-09-27
status: active
confidence: high
tags: [opencode, providers, models]
sources:
  - opencode.ts
  - host.ts
  - server.ts
  - contract.ts
  - app.tsx
  - agents.ts
---
# OpenCode provider and model management
The OpenCode feature scans provider, plugin, enabled-state, and model settings per host, compares them across machines, and can sync or remove provider configuration (`host.ts:790-914`, `server.ts:1712-1852`).

## Purpose

Each host scan reports whether OpenCode is installed, the config path and writeability, default and small model IDs, enabled providers, provider definitions, and configured plugins (`contract.ts:193-206`). The server combines scans into provider rows and drift against a selected source host (`server.ts:954-1052`, `opencode.ts:179-238`, `opencode.ts:265-324`).

## How it works

1. The host searches `~/.config/opencode/opencode.json`, then `opencode.jsonc`; comments mark the found file read-only (`host.ts:790-851`).
2. `parseOpenCodeText` normalizes providers, models, plugin names, API-key presence, and enabled providers (`opencode.ts:43-102`).
3. The server caches the scan by host, builds provider rows, selects a canonical source host, and compares model/provider state (`server.ts:576-585`, `server.ts:954-989`).
4. The UI displays host models and provider matrix, and offers sync, stale-provider cleanup, provider removal, and default-model selection (`app.tsx:2954-3012`, `app.tsx:3421-3431`).
5. Sync copies selected provider definitions, models, and enabled providers from the source to connected targets; each group can be disabled in RPC input (`server.ts:1712-1798`).
6. Writes apply operations to JSON, make a backup, atomically replace the file, and rescan (`host.ts:854-914`, `host.ts:435-463`).
7. Default model selection can update connected OpenCode configs and BB's `project_execution_defaults` setting (`server.ts:738-775`, `server.ts:2018-2055`).

## Modes, variants, and states

| Variant | Behavior |
|---|---|
| `opencode.json` | Parsed and writable if valid JSON (`host.ts:790-851`, `host.ts:854-914`). |
| `opencode.jsonc` with comments | Scanned, but marked non-writable; apply returns an error before writing (`host.ts:802-813`, `host.ts:881-887`). |
| Provider sync | Copies raw provider configuration and its enabled state when `syncProviders` is true (`server.ts:1744-1757`). |
| Model sync | Copies default and small model IDs when `syncModels` is true (`server.ts:1760-1766`). |
| Enabled-set sync | Copies enabled provider IDs when `syncEnabled` is true (`server.ts:1768-1773`). |
| Stale cleanup | Removes explicit IDs or IDs in `STALE_OPENCODE_PROVIDERS`; supports dry run (`opencode.ts:18-25`, `server.ts:1800-1852`). |
| Drift | Reports model, small-model, stale, missing, or disabled provider difference (`contract.ts:337-345`, `opencode.ts:265-324`). |

## Failures

- No OpenCode config returns `ok: false` for apply (`host.ts:881-883`).
- Commented JSONC is never rewritten (`host.ts:885-887`).
- Invalid JSON returns a parse error and no scan result (`host.ts:889-900`).
- A host RPC rejection or failed apply is returned in the sync error list (`server.ts:1777-1797`, `server.ts:1831-1851`).
- BB model-default read/write failures are caught and represented as `null` or `false` (`server.ts:738-775`).

## Business rules

- Sync source defaults to a named Mini host when present, otherwise the first BB host; callers can pass an explicit source (`server.ts:1724-1732`).
- Sync targets must be connected and cannot be the source host (`server.ts:1734-1739`).
- Provider/model/enabled settings are independently selectable in RPC (`server.ts:381-394`).
- `dryRun` computes and returns a scan without writing the config (`host.ts:902-913`).
- BB default model storage uses the `project_execution_defaults` row with the greatest `updated_at` and provider `acp-opencode`; if none exists, a row is inserted for the first BB project or a fallback ID (`server.ts:738-775`).

## Public API or commands

See [API and commands](../api.md). OpenCode RPC methods are `opencode_sync`, `opencode_clean`, `opencode_apply`, and `opencode_set_default_model` (`server.ts:381-433`). CLI commands are `opencode`, `opencode-sync`, `opencode-clean`, and `opencode-set-default` (`server.ts:2245-2264`).

## Gotchas

- `hasApiKey` reports presence only; the raw provider config is retained for source-to-target sync (`contract.ts:181-190`, `opencode.ts:43-102`).
- The canonical host fallback is based on the BB host list and name/ID predicate in the server implementation (`server.ts:977-980`, `server.ts:1724-1727`).
- The code catches BB database errors and reports the BB default as not updated; successful OpenCode changes can therefore coexist with a failed BB preference update (`server.ts:2018-2055`).

See [data model](../data-model.md) and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
