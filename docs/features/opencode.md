---
title: OpenCode provider and model management
type: component
created: 2026-09-27
updated: 2026-11-14
status: active
confidence: medium
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
The OpenCode feature scans provider, plugin, enabled-state, and model settings per host, compares them across machines, and can sync or remove provider configuration (`host.ts:581-705`, `server.ts:1901-2040`).

## Purpose

Each host scan reports whether OpenCode is installed, the config path and writeability, default and small model IDs, enabled providers, provider definitions, and configured plugins (`contract.ts:193-206`). The server combines scans into provider rows and drift against a selected source host (`server.ts:1059-1160`, `opencode.ts:179-238`, `opencode.ts:265-324`).

## How it works

1. The host searches `~/.config/opencode/opencode.json`, then `opencode.jsonc`; comments mark the found file read-only (`host.ts:581-643`).
2. `parseOpenCodeText` normalizes providers, models, plugin names, API-key presence, and enabled providers (`opencode.ts:43-102`).
3. The server caches the scan by host, builds provider rows, selects a canonical source host, and compares model/provider state (`server.ts:665-696`, `server.ts:1059-1160`).
4. The UI displays host models and provider matrix, and offers sync, stale-provider cleanup, provider removal, and default-model selection (`app.tsx:2629-3130`).
5. Sync copies selected provider definitions, models, and enabled providers from the source to connected targets; each group can be disabled in RPC input (`server.ts:1901-1987`).
6. Writes reject absent or commented configs, apply operations to JSON, back up changed files, atomically replace them, and rescan (`host.ts:645-705`, `host.ts:228-270`).
7. Default model selection can update connected OpenCode configs and BB's `project_execution_defaults` setting (`server.ts:835-872`, `server.ts:2206-2244`).

## Modes, variants, and states

| Variant | Behavior |
|---|---|
| `opencode.json` | Scan reads the first config file found; apply reports `ok:true` after parsing and rescanning (`host.ts:581-643`, `host.ts:645-705`). |
| `opencode.jsonc` with comments (`host.ts:585`, `host.ts:651`) | Scan keeps parsed values with `hadComments` and sets `writable` false (`host.ts:593-604`); apply rejects `hadComments` before writing (`host.ts:672-678`). |
| Provider sync | Copies raw provider definitions and their enabled flags when `syncProviders` is true (`server.ts:1935-1950`). |
| Model sync | Copies default and small model IDs when `syncModels` is true (`server.ts:1948-1954`). |
| Enabled-set sync | Copies enabled provider IDs when `syncEnabled` is true (`server.ts:1956-1961`). |
| Stale cleanup | Removes explicit IDs or IDs in `STALE_OPENCODE_PROVIDERS`; supports dry run (`opencode.ts:18-25`, `server.ts:1988-2040`). |
| Drift | Reports model, small-model, stale, missing, or disabled provider difference (`contract.ts:337-345`, `opencode.ts:265-324`). |

## Failures

- No OpenCode config returns `ok:false` and no scan (`host.ts:672-675`).
- Commented JSONC returns a read-only error before writing (`host.ts:676-678`).
- Invalid JSON returns a parse error and no scan (`host.ts:680-690`).
- A host RPC rejection or failed apply is returned in the sync error list (`server.ts:1966-1987`); cleanup collects per-host errors and returns at most 100 (`server.ts:2015-2040`).
- BB model-default read/write failures are caught and represented as `null` or `false` (`server.ts:835-872`).

## Business rules

- Sync source defaults to a named Mini host when present, otherwise the first BB host; callers can pass an explicit source (`server.ts:1910-1925`).
- Sync targets must be connected and cannot be the source host (`server.ts:1926-1934`).
- Provider/model/enabled settings are independently selectable in RPC (`server.ts:393-407`).
- `dryRun` computes and returns a scan without writing the config (`host.ts:693-704`).
- BB default reads use the newest `acp-opencode` row; writes update matching rows or insert one using the first BB project or a fallback ID (`server.ts:835-872`).

## Public API or commands

See [API and commands](../api.md). OpenCode RPC methods are `opencode_sync`, `opencode_clean`, `opencode_apply`, and `opencode_set_default_model` (`server.ts:393-450`). CLI commands are `opencode`, `opencode-sync`, `opencode-clean`, and `opencode-set-default` (`server.ts:2872-2954`).

## Gotchas

- `hasApiKey` reports presence only; the raw provider config is retained for source-to-target sync (`contract.ts:181-190`, `opencode.ts:43-102`).
- The canonical host fallback is based on the BB host list and name/ID predicate in the server implementation (`server.ts:1910-1925`).
- The code catches BB database errors and reports the BB default as not updated; successful OpenCode changes can therefore coexist with a failed BB preference update (`server.ts:2206-2244`).

See [data model](../data-model.md) and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
