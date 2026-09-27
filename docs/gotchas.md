---
title: Agent Tools gotchas
type: gotchas
created: 2026-09-27
updated: 2026-09-27
status: active
confidence: high
tags: [gotchas, safety, operations]
sources:
  - host.ts
  - server.ts
  - skills.ts
  - normalize.ts
  - agents.ts
  - contract.ts
---
# Agent Tools gotchas
The sharp edges are concentrated in host file safety, skill ownership rules, and the difference between catalogue changes and machine writes (`host.ts:435-483`, `skills.ts:103-178`, `server.ts:2365-2397`).

## Critical

### Removing a catalogue row is not the same as removing a server

**Problem:** `forget` deletes only the catalogue row; `remove` also edits machine configs and then marks the name ignored (`server.ts:2365-2397`).

**Risk:** A forgotten server remains configured on hosts and can return as a pending suggestion on a later scan (`server.ts:692-735`).

**Workaround:** Use `bb tools remove <name> --dry-run` to preview host removal; use `forget` only when host configs must stay as they are.

### Replacing a skill can stop to protect files

**Problem:** Fan-out aborts replacement if the losing skill tree has files absent from the winning tree (`host.ts:674-682`, `host.ts:1144-1164`).

**Risk:** A newer timestamp does not authorize dropping extra files; the operation fails and requires a person to reconcile branches.

**Workaround:** Compare both directories and reconcile the missing files before rerunning fan-out.

## High

### Unconfirmed paths are never created

**Problem:** A config is manageable only when its file exists or its `AgentDef.confirmedPath` is true (`agents.ts:40-46`, `server.ts:652-665`).

**Risk:** A CLI may appear installed but its guessed config path remains read-only for writes.

**Workaround:** Create the CLI config through that CLI first, then rescan; do not infer a config path and mark it confirmed.

### Commented JSONC is read-only

**Problem:** `loadConfig` marks JSONC with comments non-writable; OpenCode applies the same rule (`host.ts:373-434`, `host.ts:802-813`, `host.ts:881-887`).

**Risk:** The UI can show a complete scan while a write action returns an error.

**Workaround:** Remove comments with the config owner, or make the requested edit manually and rescan.

### BB skill registry paths are owned by BB

**Problem:** Skill policy `own` suppresses automated handling of the BB skill home; replacing a real directory with a symlink removes it from BB's registry (`skills.ts:103-117`, `host.ts:703-707`).

**Risk:** An action that treats `~/.bb/skills` like a normal CLI home can hide a skill from BB sessions.

**Workaround:** Keep real folders in `~/.bb/skills`; fan-out mirrors canon there when needed (`skills.ts:418-451`).

## Medium

### Newest mtime is not enough when top versions disagree

**Problem:** Promotion requires a unique hash among candidates sharing the maximum mtime; ambiguity produces no operation (`skills.ts:267-330`).

**Risk:** A skill can remain divergent after rollout without an automatic winner.

**Workaround:** Review the competing versions and choose an explicit adopt/take action (`host.ts:692-747`).

### A successful OpenCode update can leave BB's default unchanged

**Problem:** OpenCode host writes and BB database preference writes are separate operations; the BB write helper returns false on database errors (`server.ts:738-775`, `server.ts:2018-2055`).

**Risk:** CLI defaults and BB's new-chat default can differ.

**Workaround:** Check `bbUpdated` in the action result and set the BB default after correcting the database access issue.

### Skill archive listing is bounded, archive storage is not

**Problem:** The host lists up to 500 snapshots and the code has no cleanup job for the skill archive (`host.ts:1232-1251`).

**Risk:** Older snapshots can remain on disk but not appear in a single response; archive storage can grow.

**Workaround:** Preserve the archive directory when backing up host data; inspect older entries directly if a snapshot is absent from the UI.

See [MCP catalogue](features/mcp-catalog.md), [skills](features/skills.md), [OpenCode](features/opencode.md), and [data model](data-model.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools decisions](decisions.md)
- [Agent Tools deployment](deployment.md)
- [MCP server catalogue](features/mcp-catalog.md)
- [OpenCode provider and model management](features/opencode.md)
- [Agent skill canon and rollout](features/skills.md)
- [Agent Tools overview](overview.md)
