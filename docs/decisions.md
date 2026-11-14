---
title: Agent Tools decisions
type: decisions
created: 2026-09-27
updated: 2026-11-14
status: active
confidence: medium
tags: [decisions, adr]
sources:
  - server.ts
  - skills.ts
  - host.ts
  - skills-hub-service.ts
  - hub-only.ts
  - settings-page.tsx
  - host-skills.ts
  - AGENTS.md
---
# Agent Tools decisions
The active skills flow uses the BB server hub; machine skills are copied into it by `importFromMachine` (`skills-hub-service.ts:1163-1179`), while machine cleanup runs explicitly via `skills_machines_cleanup` (`skills-hub-service.ts:1317-1325`) or via `enforceHubOnlyMode` (`skills-hub-service.ts:1006-1041`) when experimental `skillsHubOnly` (`server.ts:523-528`) is enabled. Earlier per-machine fan-out decisions below are superseded.

## 004. The hub owns current skill management (active)

**Context:** Machine skill folders duplicated skills already supplied by BB sessions, while deleting or replacing those folders without validation or explicit opt-in could remove user data (`server.ts:523-528`, `host-skills.ts:216-259`, `hub-only.ts:63-118`).

**Decision:** Use the BB server's skill directory as the active library and protect it with a persistent KV token `"skillCanonToken"` (`KV.canonToken`, `skills-hub-service.ts:313`) that `canonToken` and `stampCanon` write to `<root>/.agent-tools-canon` (`skills-hub-service.ts:927-959`) for `CANON_MARKER` checks in `host-skills.ts` (`host-skills.ts:113-145`). Import copies only machine skills absent from `loadableHubNames(hub)`; machine cleanup runs explicitly via `skills_machines_cleanup`, or automatically via `enforceHubOnlyMode`, `enforceHubOnly`, and the `hubOnly` setting when experimental `skillsHubOnly` is enabled (`skills-hub-service.ts:1006-1041`, `skills-hub-service.ts:1163-1179`, `settings-page.tsx:243-289`, `hub-only.ts:46-126`).

**Status:** active

**Consequences:** Explicit import leaves source folders in place. Toggling `skillsHubOnly` (`hubOnly`) on runs `enforceHubOnly` once immediately and enables cleanup during the hourly sweep whenever every missing skill loads without blocking or transient errors (`skills-hub-service.ts:1256-1258`, `server.ts:2256-2270`, `hub-only.ts:63-120`). The retained `skills_fanout` RPC still reaches the legacy rollout path for callers that invoke it directly (`server.ts:2163-2166`).

**Sources:** `server.ts:523-528`, `server.ts:2163-2166`, `server.ts:2256-2270`, `skills-hub-service.ts:927-1041`, `skills-hub-service.ts:1163-1179`, `skills-hub-service.ts:1256-1258`, `host-skills.ts:113-145`, `host-skills.ts:216-259`, `hub-only.ts:46-126`, `settings-page.tsx:243-289`.

## 001. Scheduled skills rollout is opt-in (superseded)

**Context:** The legacy machine-canon path is retained for older callers, but initialization hard-codes scheduled rollout off and the CLI entry returns a migration message (`server.ts:589`, `server.ts:2707-2716`).

**Decision:** Keep machine-canon rollout inactive. The retained schedule setter ignores its input, and the current hourly sweep refreshes hub machine summaries, runs `enforceHubOnly` when `skillsHubOnly` is on, and optionally classifies hub skills (`server.ts:2249-2270`).

**Status:** superseded by #004

**Consequences:** This schedule no longer controls the active hub skill flow. The CLI returns a migration message, while the retained `skills_fanout` RPC still invokes the legacy rollout path (`server.ts:2163-2166`, `server.ts:2707-2716`, `server.ts:2256-2270`).

**Sources:** `server.ts:589`, `server.ts:2163-2166`, `server.ts:2249-2270`, `server.ts:2707-2716`.

## 002. Promote skills before host fan-out (superseded)

**Context:** The retained machine-canon implementation combines local candidates, derived host homes, and the BB server mirror (`server.ts:1243-1558`). Remote Git synchronization (`syncSkillsCanon` and `skills_sync`) was removed.

**Decision:** The retained `skills_fanout` RPC calls `runSkillsRollout`, which promotes candidates first, fans out to machine homes, then mirrors into the BB server process's `experimental_dataDir/skills` without Git synchronization (`server.ts:2163-2166`, `server.ts:1540-1558`).

**Status:** superseded by #004

**Consequences:** Direct legacy RPC invocation can still alter machine homes. The server-process mirror is a separate plan that can use a filtered host archive when no local canon copy exists (`server.ts:1380-1558`, `skills.ts:575-612`).

**Sources:** `server.ts:1243-1558`, `server.ts:2163-2166`, `skills.ts:267-330`, `skills.ts:575-612`.

## 003. MCP removal is a separate explicit operation (active)

**Context:** Catalogue state and host configuration have different effects: dropping a desired-state row must not silently rewrite user-owned CLI files. The CLI's `forget` handler only changes catalogue storage, while `remove` invokes `runPurge` (`server.ts:2590-2623`, `server.ts:1643-1689`).

**Decision:** Catalogue removal (`forget`) leaves machines untouched; `remove` is the explicit host-config removal path with a dry-run option (`server.ts:242-256`, `server.ts:2590-2623`, `server.ts:1643-1689`).

**Status:** active

**Consequences:** A forgotten server can remain present and become a pending item after a later scan; actual removal requires the separate operation (`server.ts:788-825`, `server.ts:2590-2600`).

**Sources:** `server.ts:1643-1689`, `server.ts:242-256`, `server.ts:2590-2623`.

See [MCP catalogue](features/mcp-catalog.md), [hub skills](features/skills-hub.md), [legacy machine skills](features/skills.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](features/skills.md)
