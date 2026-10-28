---
title: Agent Tools decisions
type: decisions
created: 2026-09-27
updated: 2026-10-28
status: active
confidence: medium
tags: [decisions, adr]
sources:
  - server.ts
  - skills.ts
  - host.ts
  - skills-hub-service.ts
  - settings-page.tsx
  - host-skills.ts
  - AGENTS.md
---
# Agent Tools decisions
The active skills flow uses the BB server hub; machine skills are copied into it on import, while cleanup is a separate offered action (`skills-hub-service.ts:593-609`, `skills-hub-service.ts:728-735`). Earlier per-machine fan-out decisions below are superseded.

## 004. The hub owns current skill management (active)

**Context:** Machine skill folders duplicated skills already supplied by BB sessions, while deleting or replacing those folders without an explicit choice could remove user data (`server.ts:530-540`, `host-skills.ts:167-223`).

**Decision:** Use the BB server's skill directory as the active library. Import copies only machine skills the hub lacks; machine cleanup is a separate action exposed when `skillsOfferCleanup` is enabled (`skills-hub-service.ts:593-609`, `skills-hub-service.ts:724-735`, `settings-page.tsx:180-199`).

**Status:** active

**Consequences:** Import leaves source folders in place. The hourly sweep refreshes machine summaries and optionally classifies hub skills without running machine fan-out. The retained `skills_fanout` RPC still reaches the legacy rollout path for callers that invoke it directly (`host-skills.ts:167-223`, `server.ts:2203-2206`, `server.ts:2302-2312`).

**Sources:** `server.ts:530-540`, `server.ts:2203-2206`, `server.ts:2302-2312`, `skills-hub-service.ts:593-609`, `skills-hub-service.ts:724-735`, `host-skills.ts:167-223`, `settings-page.tsx:180-199`.

## 001. Scheduled skills rollout is opt-in (superseded)

**Context:** The legacy machine-canon path is retained for older callers, but initialization hard-codes scheduled rollout off and the CLI entry returns a migration message (`server.ts:546-548`, `server.ts:2730-2739`).

**Decision:** Keep machine-canon rollout inactive. The retained schedule setter ignores its input, and the current hourly sweep refreshes hub machine summaries and optionally classifies hub skills (`server.ts:2296-2299`, `server.ts:2302-2312`).

**Status:** superseded by #004

**Consequences:** This schedule no longer controls the active hub skill flow. The CLI returns a migration message, while the retained `skills_fanout` RPC still invokes the legacy rollout path; the current sweep refreshes machine counts and optionally starts classification (`server.ts:2203-2206`, `server.ts:2730-2739`, `server.ts:2302-2312`).

**Sources:** `server.ts:546-548`, `server.ts:2296-2312`, `server.ts:2730-2739`.

## 002. Promote skills before Git synchronization and host fan-out (superseded)

**Context:** The retained machine-canon implementation combines local candidates, Git synchronization and derived host homes (`server.ts:1314-1353`, `server.ts:1395-1522`).

**Decision:** The retained `skills_fanout` RPC calls `runSkillsRollout`, which promotes candidates first, synchronizes host canons only when a remote is configured, fans out, then mirrors into the BB server process's `experimental_dataDir/skills` (`server.ts:2203-2206`, `server.ts:1572-1590`).

**Status:** superseded by #004

**Consequences:** Direct legacy RPC invocation can still alter machine homes; a blank configured remote skips Git synchronization. The server-process mirror is a separate plan that can use a filtered host archive when no local canon copy exists (`server.ts:1278-1293`, `server.ts:1395-1469`, `server.ts:1522-1590`, `skills.ts:582-612`).

**Sources:** `server.ts:1195-1269`, `server.ts:1278-1293`, `server.ts:1341-1390`, `server.ts:1395-1590`, `server.ts:2203-2206`, `skills.ts:267-330`, `skills.ts:582-612`.

## 003. MCP removal is a separate explicit operation (active)

**Context:** Catalogue state and host configuration have different effects: dropping a desired-state row must not silently rewrite user-owned CLI files. The CLI's `forget` handler only changes catalogue storage, while `remove` invokes `runPurge` (`server.ts:2613-2627`, `server.ts:1688-1729`).

**Decision:** Catalogue removal (`forget`) leaves machines untouched; `remove` is the explicit host-config removal path with a dry-run option (`server.ts:241-255`, `server.ts:2613-2645`, `server.ts:1688-1729`).

**Status:** active

**Consequences:** A forgotten server can remain present and become a pending item after a later scan; actual removal requires the separate operation (`server.ts:740-779`, `server.ts:2613-2645`).

**Sources:** `server.ts:1688-1729`, `server.ts:241-255`, `server.ts:2613-2645`.

See [MCP catalogue](features/mcp-catalog.md), [hub skills](features/skills-hub.md), [legacy machine skills](features/skills.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](features/skills.md)
