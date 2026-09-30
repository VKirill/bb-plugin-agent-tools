---
title: Agent Tools decisions
type: decisions
created: 2026-09-27
updated: 2026-09-30
status: active
confidence: medium
tags: [decisions, adr]
sources:
  - server.ts
  - skills.ts
  - host.ts
  - AGENTS.md
---
# Agent Tools decisions
The code and commit history establish opt-in scheduled skill rollout and ordered promotion, Git synchronization, host fan-out, then mirroring into the BB server process data directory (`server.ts:2267-2287`, `server.ts:1538-1569`, `skills.ts:267-330`, `skills.ts:582-612`).

## 001. Scheduled skills rollout is opt-in (active)

**Context:** Automatic placement of skills changes canon and CLI homes across connected hosts. The commit introducing the setting states that a fresh install moves nothing on its own (`218cd71`).

**Decision:** Keep `skillsFanOutAuto` disabled by default; the scheduled sweep only runs the full skills rollout when enabled (`server.ts:507-514`, `server.ts:2267-2287`).

**Status:** active

**Consequences:** A fresh configuration does not promote, sync, or fan out skills on the schedule. An operator can still run the manual `skills-fanout` command (`server.ts:2267-2287`, `server.ts:2421-2424`).

**Sources:** `server.ts:507-514`, `server.ts:2267-2287`, commit `218cd71`.

## 002. Promote skills before Git synchronization and host fan-out (active)

**Context:** A skills rollout has to combine local candidates, the shared Git canon, and derived host homes. The commit history records that the latest skill is promoted to canon before Git sync and fan-out (`2170e0d`, `ff8a03d`).

**Decision:** `runSkillsRollout` scans and promotes candidates first, synchronizes connected-host canons when a remote is configured, fans out to eligible host homes, then mirrors into the BB server process's `experimental_dataDir/skills` (`server.ts:1538-1569`, `server.ts:1248-1305`, `server.ts:1361-1532`).

**Status:** active

**Consequences:** The final home layout follows the post-promotion, post-sync canon; failed host syncs are excluded from later fan-out and returned in the result. The server-process mirror is a separate plan that can use a filtered host archive when no local canon copy exists (`server.ts:1538-1569`, `server.ts:1494-1502`, `skills.ts:582-612`).

**Sources:** `server.ts:1248-1305`, `server.ts:1361-1569`, `skills.ts:267-330`, `skills.ts:582-612`, commits `2170e0d`, `ff8a03d`.

## 003. MCP removal is a separate explicit operation (active)

**Context:** Catalogue state and host configuration have different effects: dropping a desired-state row must not silently rewrite user-owned CLI files. `forget` is implemented separately from host-side purge (`server.ts:2565-2597`).

**Decision:** Catalogue removal (`forget`) leaves machines untouched; `remove`/`purge` is the explicit host-config removal path with a dry-run option (`server.ts:223-237`, `server.ts:2565-2597`).

**Status:** active

**Consequences:** A forgotten server can remain present and become a pending item after a later scan; actual removal requires the separate operation (`server.ts:692-735`, `server.ts:2565-2597`).

**Sources:** `server.ts:223-237`, `server.ts:2565-2597`.

See [MCP catalogue](features/mcp-catalog.md), [skills](features/skills.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](features/skills.md)
