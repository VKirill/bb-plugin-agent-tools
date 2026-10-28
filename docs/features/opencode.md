---
title: OpenCode provider and model management
type: component
created: 2026-09-27
updated: 2026-10-28
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
The OpenCode feature scans provider, plugin, enabled-state, and model settings per host, compares them across machines, and can sync or remove provider configuration (`host.ts:581-705`, `server.ts:1947-2087`).

## Purpose

Each host scan reports whether OpenCode is installed, the config path and writeability, default and small model IDs, enabled providers, provider definitions, and configured plugins (`contract.ts:193-206`). The server combines scans into provider rows and drift against a selected source host (`server.ts:944-1042`, `opencode.ts:179-238`, `opencode.ts:265-324`).

## How it works

1. The host searches `~/.config/opencode/opencode.json`, then `opencode.jsonc`; comments mark the found file read-only (`host.ts:581-643`).
2. `parseOpenCodeText` normalizes providers, models, plugin names, API-key presence, and enabled providers (`opencode.ts:43-102`).
3. The server caches the scan by host, builds provider rows, selects a canonical source host, and compares model/provider state (`server.ts:624-645`, `server.ts:979-1042`).
4. The UI displays host models and provider matrix, and offers sync, stale-provider cleanup, provider removal, and default-model selection (`app.tsx:2960-3018`, `app.tsx:3428-3438`).
5. Sync copies selected provider definitions, models, and enabled providers from the source to connected targets; each group can be disabled in RPC input (`server.ts:1947-2031`).
6. Writes reject absent or commented configs, apply operations to JSON, back up changed files, atomically replace them, and rescan (`host.ts:645-705`, `host.ts:220-248`).
7. Default model selection can update connected OpenCode configs and BB's `project_execution_defaults` setting (`server.ts:786-825`, `server.ts:2253-2289`).

## Modes, variants, and states

| Variant | Behavior |
|---|---|
| `opencode.json` | Scan reads the first config file found; apply reports `ok:true` after parsing and rescanning (`host.ts:581-643`, `host.ts:645-705`). |
| `opencode.jsonc` with comments | Scan keeps parsed values but sets `writable:false`; apply returns an error before writing (`host.ts:593-604`, `host.ts:672-678`). |
| Provider sync | Copies raw provider definitions and their enabled flags when `syncProviders` is true (`server.ts:1981-1991`). |
| Model sync | Copies default and small model IDs when `syncModels` is true (`server.ts:1994-2000`). |
| Enabled-set sync | Copies enabled provider IDs when `syncEnabled` is true (`server.ts:2002-2007`). |
| Stale cleanup | Removes explicit IDs or IDs in `STALE_OPENCODE_PROVIDERS`; supports dry run (`opencode.ts:18-25`, `server.ts:2034-2085`). |
| Drift | Reports model, small-model, stale, missing, or disabled provider difference (`contract.ts:337-345`, `opencode.ts:265-324`). |

## Failures

- No OpenCode config returns `ok:false` and no scan (`host.ts:672-675`).
- Commented JSONC returns a read-only error before writing (`host.ts:676-678`).
- Invalid JSON returns a parse error and no scan (`host.ts:680-690`).
- A host RPC rejection or failed apply is returned in the sync error list (`server.ts:2011-2031`); cleanup collects per-host errors and returns at most 100 (`server.ts:2065-2085`).
- BB model-default read/write failures are caught and represented as `null` or `false` (`server.ts:786-825`).

## Business rules

- Sync source defaults to a named Mini host when present, otherwise the first BB host; callers can pass an explicit source (`server.ts:1955-1966`).
- Sync targets must be connected and cannot be the source host (`server.ts:1968-1973`).
- Provider/model/enabled settings are independently selectable in RPC (`server.ts:381-394`).
- `dryRun` computes and returns a scan without writing the config (`host.ts:693-704`).
- BB default reads use the newest `acp-opencode` row; writes update matching rows or insert one using the first BB project or a fallback ID (`server.ts:786-825`).

## Public API or commands

See [API and commands](../api.md). OpenCode RPC methods are `opencode_sync`, `opencode_clean`, `opencode_apply`, and `opencode_set_default_model` (`server.ts:400-455`). CLI commands are `opencode`, `opencode-sync`, `opencode-clean`, and `opencode-set-default` (`server.ts:2482-2500`, `server.ts:2910-2950`).

## Gotchas

- `hasApiKey` reports presence only; the raw provider config is retained for source-to-target sync (`contract.ts:181-190`, `opencode.ts:43-102`).
- The canonical host fallback is based on the BB host list and name/ID predicate in the server implementation (`server.ts:1955-1966`).
- The code catches BB database errors and reports the BB default as not updated; successful OpenCode changes can therefore coexist with a failed BB preference update (`server.ts:2253-2289`).

See [data model](../data-model.md) and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
