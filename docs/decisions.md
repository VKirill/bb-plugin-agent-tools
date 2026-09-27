---
title: Agent Tools decisions
type: decisions
created: 2026-09-27
updated: 2026-09-27
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
The code and commit history establish opt-in scheduled skill rollout and ordered promotion, Git synchronization, then fan-out (`server.ts:2068-2087`, `skills.ts:267-330`).

## 001. Scheduled skills rollout is opt-in (active)

**Context:** Automatic placement of skills changes canon and CLI homes across connected hosts. The commit introducing the setting states that a fresh install moves nothing on its own (`218cd71`).

**Decision:** Keep `skillsFanOutAuto` disabled by default; the scheduled sweep only runs the full skills rollout when enabled (`server.ts:493-500`, `server.ts:2074-2087`).

**Status:** active

**Consequences:** A fresh configuration does not promote, sync, or fan out skills on the schedule. An operator can still run the manual `skills-fanout` command (`server.ts:2074-2087`, `server.ts:2221-2224`).

**Sources:** `server.ts:493-500`, `server.ts:2068-2087`, commit `218cd71`.

## 002. Promote skills before Git synchronization and host fan-out (active)

**Context:** A skills rollout has to combine local candidates, the shared Git canon, and derived host homes. The commit history records that the latest skill is promoted to canon before Git sync and fan-out (`2170e0d`, `ff8a03d`).

**Decision:** `runSkillsRollout` plans promotions first, synchronizes the canon when a remote is configured, and then applies fan-out to eligible hosts (`server.ts:1289-1364`, `skills.ts:267-330`).

**Status:** active

**Consequences:** The final home layout follows the post-promotion, post-sync canon; failed host syncs are excluded from later fan-out and returned in the result (`server.ts:1310-1364`).

**Sources:** `server.ts:1289-1364`, `skills.ts:267-330`, commits `2170e0d`, `ff8a03d`.

## 003. MCP removal is a separate explicit operation (active)

**Context:** Catalogue state and host configuration have different effects: dropping a desired-state row must not silently rewrite user-owned CLI files. `forget` is implemented separately from host-side purge (`server.ts:2365-2397`).

**Decision:** Catalogue removal (`forget`) leaves machines untouched; `remove`/`purge` is the explicit host-config removal path with a dry-run option (`server.ts:223-237`, `server.ts:2365-2397`).

**Status:** active

**Consequences:** A forgotten server can remain present and become a pending item after a later scan; actual removal requires the separate operation (`server.ts:692-735`, `server.ts:2365-2397`).

**Sources:** `server.ts:223-237`, `server.ts:2365-2397`.

See [MCP catalogue](features/mcp-catalog.md), [skills](features/skills.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](features/skills.md)
