---
title: Agent Tools gotchas
type: gotchas
created: 2026-09-27
updated: 2026-11-14
status: active
confidence: medium
tags: [gotchas, safety, operations]
sources:
  - host.ts
  - server.ts
  - skills.ts
  - normalize.ts
  - agents.ts
  - contract.ts
  - skill-tree.ts
  - skills-server.ts
  - skills-sync.ts
  - platform.ts
  - host-skills.ts
  - skills-hub-service.ts
  - hub-only.ts
  - required-session-policy.ts
  - settings-page.tsx
  - i18n.ts
---
# Agent Tools gotchas
The sharp edges are concentrated in host file safety, skill ownership and hub-only rules, and the difference between catalogue changes and machine writes (`host.ts:228-270`, `skills.ts:103-178`, `server.ts:2590-2623`, `hub-only.ts:63-118`).

## Critical

### Removing a catalogue row is not the same as removing a server

**Problem:** `forget` deletes only the catalogue row; `remove` calls host purge, then deletes the catalogue row and adds the name to the ignored set (`server.ts:2590-2623`, `server.ts:1643-1689`).

**Risk:** A forgotten server remains configured on hosts and can return as a pending suggestion on a later scan (`server.ts:2590-2600`, `server.ts:788-825`).

**Workaround:** Use `bb tools remove <name> --dry-run` to preview host removal; use `forget` only when host configs must stay as they are.

### Legacy fan-out can stop to protect files

**Problem:** A direct call to the retained `skills_fanout` RPC can abort replacement if the losing skill tree has files absent from the winning tree (`server.ts:2163-2166`, `host.ts:447-481`, `host.ts:929-955`).

**Risk:** A newer timestamp does not authorize dropping extra files; the operation fails and requires a person to reconcile branches.

**Workaround:** Compare both directories and reconcile the missing files before invoking the legacy rollout again.

## High

### Unconfirmed paths are never created

**Problem:** A config is manageable only when its file exists or its `AgentDef.confirmedPath` is true (`agents.ts:40-46`, `server.ts:755-762`).

**Risk:** A CLI may appear installed but its guessed config path remains read-only for writes.

**Workaround:** Create the CLI config through that CLI first, then rescan; do not infer a config path and mark it confirmed.

### Commented JSONC is read-only

**Problem:** `loadConfig` marks JSONC with comments non-writable (`host.ts:158-214`); OpenCode `scanOpenCode` and `applyOpenCode` apply the same rule (`host.ts:581-705`).

**Risk:** The UI can show a complete scan while a write action returns an error.

**Workaround:** Remove comments with the config owner, or make the requested edit manually and rescan.

### BB skill registry paths are owned by BB

**Problem:** The retained machine-home policy `own` suppresses legacy fan-out handling of the BB skill home; replacing a real directory with a symlink removes it from BB's registry (`skills.ts:103-117`, `host.ts:540-577`).

**Risk:** An action that treats `~/.bb/skills` like a normal CLI home can hide a skill from BB sessions.

**Workaround:** Keep real folders in `~/.bb/skills`; the legacy fan-out planner mirrors eligible canon entries beside that home (`skills.ts:458-499`).

### Hub canon protection requires the `.agent-tools-canon` token

**Problem:** Protecting `~/.bb/skills` by path alone would accidentally skip `~/.bb/skills` on other machines with the same home layout. `stampCanon` writes KV `skillCanonToken` into `<root>/.agent-tools-canon` (ignored via `.git/info/exclude`), and `host-skills.ts` protects a directory only when `.agent-tools-canon` matches that token (`skills-hub-service.ts:927-959`, `host-skills.ts:113-145`).

**Risk:** Missing or mismatched `.agent-tools-canon` causes the hub's own library folder to be scanned or cleaned if a host points at it.

**Workaround:** Keep `protectPaths()` stamped before `skill_homes_count` / `skill_homes_cleanup` calls (`skills-hub-service.ts:955-959`, `skills-hub-service.ts:1586-1588`).

## Medium

### Hub-only cleanup aborts per host on any blocking rejection or transient error

**Problem:** `enforceHubOnly` imports skills from `machineNotOnHub` (built against `loadableHubNames(hub)` so hub skills with `blocking: true` problems remain eligible), and skips cleanup on a host whenever any skill hits a blocking rejection or transient import error (`hub-only.ts:46-120`).

**Risk:** Machine folders remain unarchived on that host until all missing skills load without validation rejections or transport errors.

**Workaround:** Inspect `hubOnlyLast.skipped` on the Settings page or run `bb tools skills-hub-only --dry-run` to see which skill blocked cleanup (`settings-page.tsx:268-289`, `skills-hub-service.ts:1485-1511`).

### Narrow session policy is skipped if core does not advertise it

**Problem:** `requiredSessionPolicySpawnField` emits `experimental_vkRequiredSessionPolicy` for hidden classifier and card-writer threads only when `bb.agents.experimental_vkRequiredSessionPolicy()` returns an advertisement covering the chosen provider and instruction switches (`required-session-policy.ts:46-98`, `skills-hub-service.ts:404-408`).

**Risk:** On older BB cores or unadvertised providers, hidden threads run without the narrowed plugin/MCP/instruction policy (`required-session-policy.ts:73-98`).

**Workaround:** Run on a BB core that advertises `experimental_vkRequiredSessionPolicy` for the selected classifier provider.

### Newest mtime is not enough when top versions disagree

**Problem:** The retained machine-canon promotion planner requires a unique hash among candidates sharing the maximum mtime; ambiguity produces no operation (`skills.ts:267-330`).

**Risk:** A skill can remain divergent after rollout without an automatic winner.

**Workaround:** Review the competing versions and use the legacy adopt/take host operation only when that workflow is intentionally invoked (`host.ts:483-539`).

### A successful OpenCode update can leave BB's default unchanged

**Problem:** OpenCode host writes and BB database preference writes are separate operations; the BB write helper returns false on database errors (`host.ts:645-705`, `server.ts:2206-2244`).

**Risk:** CLI defaults and BB's new-chat default can differ.

**Workaround:** Check `bbUpdated` in the action result. It is also false when no BB project has chosen OpenCode yet (the plugin never inserts rows) or when the runtime has no `node:sqlite`; pick OpenCode in a project's BB settings once, then repeat.

### Skill archive listing is bounded, archive storage is not

**Problem:** The host lists up to 500 snapshots and the code has no cleanup job for the skill archive (`host.ts:989-1050`).

**Risk:** Older snapshots can remain on disk but not appear in a single response; archive storage can grow.

**Workaround:** Preserve the archive directory when backing up host data; inspect older entries directly if a snapshot is absent from the UI.

### BB rejects oversized skill trees; the planner checks bytes only

**Problem:** `bbTreeProblem` can report both the 10 MiB and 1,000-file limits, but both retained planners pass only `bytes`, leaving its `files` parameter at zero. The planner branches therefore block over-size trees but do not enforce the file-count limit (`skills.ts:145-162`, `skills.ts:473-477`, `skills.ts:590-597`).

**Risk:** A skill under the byte limit but over 1,000 files can pass the planner while BB rejects the injected tree.

**Workaround:** Keep skill trees below both BB limits (`BB_INJECT_MAX_BYTES` and `BB_INJECT_MAX_FILES` in `skills.ts:148-160`); review `bbFiles` in the skills scan when the file count may exceed 1,000 (`contract.ts:99-108`).

### Dependency and cache files are removed from skill copies

**Problem:** Skill copies and server-transfer archives omit dependency folders, build caches, and selected temporary files (`skill-tree.ts:12-29`, `host.ts:1070-1100`, `skills-server.ts:130-145`).

**Risk:** A skill that relies on files inside those excluded paths will be copied without them.

**Workaround:** Store required skill content outside the excluded paths and rescan after rollout.

## Windows hosts

### Shims, junctions, line endings and PATHEXT

**Problem:** A Windows host differs from macOS and Linux in four ways that the host entry has to absorb (`platform.ts`, `host.ts`, `skills-sync.ts`, `normalize.ts`).

- **`cmd /c` wrapper.** Native Windows Claude Code and Codex cannot spawn `.cmd` shims (`npx`, `gitnexus`) directly. When the host entry writes a stdio server on `win32`, `wrapForWindows` rewrites a bare or `.cmd`/`.bat` command into `{"command":"cmd","args":["/c","npx","-y","pkg"]}` (`platform.ts`, `host.ts:1102-1178`). `signature` unwraps `cmd /c` and drops `.exe`/`.cmd`/`.bat`, so the wrapped and plain forms count as the same server and do not show up as drift (`normalize.ts:227-283`).
- **Junctions.** `linkDir` creates skill links as junctions on Windows because a directory symlink needs Developer Mode or admin rights. Targets are absolute paths (`host.ts`).
- **`autocrlf=false` and `C` locale for Git.** `runGit` prepends `-c core.autocrlf=false` and pins `LC_ALL`, `LC_MESSAGES`, `LANG`, and `LANGUAGE` to `"C"` (`skills-sync.ts:37-53`). Windows git defaults with `core.autocrlf=true` would alter file sizes and fingerprints, and localized Git diagnostics would break English error-matching.
- **PATHEXT.** `findBin` and `resolveGitBin` try the `binCandidates` names (`git.com`, `git.exe`, `git.bat`, `git.cmd`, `git`) in every search directory; `gitBinSearchDirs` adds standard Windows install directories when called with the `;` delimiter (`host.ts:87-105`, `skills-sync.ts:56-69`, `i18n.ts:309`).

**Risk:** Forgetting any of these makes a CLI look "not installed", Git output fail parser checks, or a link fail with `EPERM`. Windows paths (`C:\…`) in a command or argument mark a server as machine-bound.

**Workaround:** Keep platform checks in `platform.ts`, `skills-sync.ts`, and `process.platform` guards at the write sites; `tests/windows.test.ts` covers the Windows rules.

See [MCP catalogue](features/mcp-catalog.md), [skills](features/skills.md), [OpenCode](features/opencode.md), and [data model](data-model.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools decisions](decisions.md)
- [Agent Tools deployment](deployment.md)
- [MCP server catalogue](features/mcp-catalog.md)
- [OpenCode provider and model management](features/opencode.md)
- [Agent skill canon and rollout](features/skills.md)
- [Agent Tools overview](overview.md)
