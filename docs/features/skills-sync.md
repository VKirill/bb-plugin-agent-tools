---
title: Machine canon Git synchronization
type: component
created: 2026-10-28
updated: 2026-10-28
status: deprecated
confidence: high
tags: [skills, git, legacy]
sources:
  - skills-sync.ts
  - server.ts
  - host.ts
  - hub-skills.ts
  - contract.ts
---
# Machine canon Git synchronization
`syncSkillsCanon` merges the retained per-machine skill canon with a remote Git repository; the current legacy caller exits before calling it because its configured remote is empty.

## Purpose

This is the Git stage of the deprecated machine-canon rollout. `runSkillsCanonSync` reads `LEGACY_SKILLS.syncRemote`, returns `remoteConfigured:false` when it is empty, and otherwise sends `skills_sync` to selected hosts (`server.ts:1278-1293`). The active Skills hub uses its own Git operations (`hub-skills.ts:179-234`).

## How it works

`syncSkillsCanon(dir, remote, deps)` uses the injected Git runner and optional hostname/path/stamp/fingerprint functions, with host defaults where omitted (`skills-sync.ts:21-49`, `skills-sync.ts:115-126`).

1. **No local `.git`:** create the canon directory, copy it to a dated migration snapshot, clone the remote to a temporary path, and enumerate clone top-level entries except `.git`. Move only names absent locally; preserve local collisions and, when the fingerprint callback exists, record differing hashes. Move cloned `.git` into canon and remove the temporary clone (`skills-sync.ts:127-158`).
2. **Existing repository:** read `origin`; add it if absent or change its URL when it differs, then run `git pull --rebase --autostash` and record the fetched ref (`skills-sync.ts:159-176`).
3. **Pull conflict:** abort the rebase. For errors other than parsed untracked-file overwrite, return a formatted error. For that specific conflict, fetch `origin`, enumerate non-hidden top-level remote names, check out only names absent locally, and report collisions without replacing local content (`skills-sync.ts:177-212`).
4. **Local reconciliation:** add root symlink names and dependency/cache folders to `.gitignore`, stage all files, and commit only when status is dirty (`skills-sync.ts:214-244`). Require a fetched ref; if it is not an ancestor of HEAD, record it through an `ours` merge and verify ancestry again (`skills-sync.ts:245-256`).
5. **Push:** push the reconciled repository. Success returns `ok:true` and a message; push failure returns `ok:false`, a clipped first-line error and any migration/collision message (`skills-sync.ts:257-267`).

| Mode or branch | Result and failure behavior |
|---|---|
| First synchronization | Preserve existing names, install Git metadata, then continue through ignore, stage, commit, ref verification and push (`skills-sync.ts:127-158`, `skills-sync.ts:214-267`). |
| Repository origin matches remote | Pull with rebase and autostash (`skills-sync.ts:159-176`). |
| Origin is absent or differs | Add or set `origin`; an “already exists” add error falls back to `set-url` (`skills-sync.ts:160-173`). |
| Pull reports untracked overwrite names | Fetch and check out only remote names missing locally. Fetch/checkout failure returns `ok:false`; same-name local entries are kept (`skills-sync.ts:177-212`). |
| Other pull failure | Abort rebase and return `ok:false` without the untracked-file recovery (`skills-sync.ts:177-183`). |
| Clean worktree | Skip commit but still reconcile the fetched ref and push (`skills-sync.ts:238-267`). |
| Missing fetched ref or failed ancestry merge/check | Throw into the outer failure path and return `ok:false` (`skills-sync.ts:245-256`, `skills-sync.ts:268-271`). |
| Clone, file, commit or other Git failure | Outer catch attempts to abort rebase and returns a formatted `ok:false` result (`skills-sync.ts:268-271`). A failed first clone can leave its temporary directory because cleanup follows the successful metadata move (`skills-sync.ts:132-153`). |

## Business rules

- The function does not replace same-name local folders with remote contents during initial migration or untracked-overwrite recovery (`skills-sync.ts:137-158`, `skills-sync.ts:184-207`).
- Git ignores are added for root symlinks and configured junk directories; `.git` itself is excluded from that list (`skills-sync.ts:214-237`).
- It stages local changes and pushes only after verifying that the fetched remote ref is included in local history (`skills-sync.ts:238-267`).
- Current plugin configuration disables this legacy call path by fixing its remote to an empty string (`server.ts:546-548`, `server.ts:1282-1293`).

## Public API

Host RPC: `skills_sync` accepts a remote and returns sync outcome (`contract.ts:432-439`). The current server wrapper is gated by the legacy remote setting (`server.ts:2214-2219`).

## Gotchas

- A push failure happens after local changes may have been committed; the function returns `ok:false` with the push error and does not roll back the local commit (`skills-sync.ts:238-267`).
- Some failure paths return before removing the first-sync temporary clone (`skills-sync.ts:132-153`, `skills-sync.ts:177-212`).

See [legacy machine skills](skills.md) for where this routine fits in the old rollout.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](skills.md)
