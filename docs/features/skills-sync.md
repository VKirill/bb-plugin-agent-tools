---
title: Git process and binary resolution
type: component
created: 2026-10-28
updated: 2026-11-14
status: active
confidence: medium
tags: [skills, git, platform]
sources:
  - skills-sync.ts
  - platform.ts
  - hub-skills.ts
  - host.ts
  - host-skills.ts
  - contract.ts
  - server.ts
---
# Git process and binary resolution
`skills-sync.ts` provides `execFileOutput`, `runGit`, and `resolveGitBin` for Git and subprocess invocations across host and hub code; the legacy `syncSkillsCanon` machine-canon Git sync and `skills_sync` RPC have been removed (`skills-sync.ts:14-69`, `contract.ts:465-497`).

## Purpose

Hub Git history, commits, and archive subprocesses use `execFileOutput` directly, while host archive/Git callers use `runGit` and `resolveGitBin` so Windows PATHEXT lookup, Unix/Windows Git settings, and non-localized Git error messages behave uniformly (`skills-sync.ts:14-69`, `hub-skills.ts:5`, `host.ts:18`, `host-skills.ts:5`). Active hub Git operations live in `hub-skills.ts` (`hub-skills.ts:179-234`).

## How it works

1. `execFileOutput(bin, args, opts)` executes a binary via `node:child_process.execFile` without a shell, passing `cwd`, optional `env`, a 15 MiB buffer cap, and an optional timeout (`skills-sync.ts:14-35`).
2. `runGit(cwd, args, opts)` prepends `-c core.autocrlf=false` before the caller's Git arguments, sets `GIT_TERMINAL_PROMPT: "0"`, and forces `LC_ALL`, `LC_MESSAGES`, `LANG`, and `LANGUAGE` to `"C"` (`skills-sync.ts:37-53`).
3. `resolveGitBin()` probes `PATH` directories (plus standard Windows Git install locations via `gitBinSearchDirs`) for executable candidates in order (`git.com`, `git.exe`, `git.bat`, `git.cmd`, `git` on Windows; `git` on POSIX), falling back to `"git"` when none matches (`skills-sync.ts:56-69`).
4. Machine-canon Git synchronization (the former sync handler, host/RPC methods, and sync-remote setting) is removed; `bb tools skills-sync` hits `case "skills-sync"` and returns the legacy migration message (`server.ts:2707-2716`).

| Branch or input | Behavior |
|---|---|
| Subprocess succeeds | Resolves `{ stdout, stderr }` (`skills-sync.ts:24-34`). |
| Subprocess errors without timeout | Re-throws using captured `stderr` (or `stdout` / error message) as the `Error` message (`skills-sync.ts:25-33`). |
| Windows `git` lookup | Searches `PATH` plus standard Windows install directories for PATHEXT candidates before falling back to `"git"` (`skills-sync.ts:56-69`). |
| `runGit` locale & CRLF | Forces `C` locale variables so Git diagnostics match English substrings across locales, and forces `core.autocrlf=false` so Windows CRLF conversion does not skew skill sizes (`skills-sync.ts:37-52`). |

## Business rules

- Interactive Git credential prompts are suppressed with `GIT_TERMINAL_PROMPT="0"` (`skills-sync.ts:46`).
- `runGit` pins `LC_ALL`, `LC_MESSAGES`, `LANG`, and `LANGUAGE` to `"C"` (`skills-sync.ts:47-50`).
- Legacy machine-canon rollout no longer runs any Git sync stage; see [Agent skill canon and rollout](skills.md) (`server.ts:1540-1558`).

## Public API

`skills-sync.ts` exports `execFileOutput`, `runGit`, and `resolveGitBin` (`skills-sync.ts:14-69`).

## Gotchas

- `resolveGitBin` swallows per-path `statSync` errors and returns `"git"` if no candidate is found; if Git is absent from both `PATH` and fallback directories, the failure happens when `runGit` spawns the binary (`skills-sync.ts:56-69`).

See [Agent skill canon and rollout](skills.md) and [Hub skills and categories](skills-hub.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](skills.md)
