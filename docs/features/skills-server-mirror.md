---
title: BB server skill mirror archive
type: component
created: 2026-10-27
updated: 2026-10-28
status: deprecated
confidence: medium
tags: [skills, archive, server-mirror]
sources:
  - skills-server.ts
  - server.ts
  - host.ts
  - contract.ts
  - skills-hub-service.ts
---
# BB server skill mirror archive
This page documents the deprecated machine-canon mirror path retained by legacy rollout code. The active hub library now lives directly at `<experimental_dataDir>/skills`; current machine import publishes into that library (`server.ts:546-548`, `skills-hub-service.ts:263-269`, `skills-hub-service.ts:593-609`).

## Purpose

The BB server process stores hub skills in `<experimental_dataDir>/skills`. The old rollout code could mirror entries there from a machine canon; it is no longer the active path (`server.ts:546-548`, `server.ts:1351-1443`, `skills-server.ts:58-64`). Current hub operations are described in [Hub skills and categories](skills-hub.md).

## How it works

1. `runServerBbSkills` reads local canon and the server-process destination, finds missing skill names and selects a connected host canon for names absent locally (`server.ts:1351-1443`).
2. For a selected host-only skill it calls `skills_archive`; the host excludes recognized junk and rejects a packed archive larger than 8 MiB (`server.ts:1402-1443`, `host.ts:1086-1115`, `contract.ts:440-448`).
3. The rollout calls `extractSkillArchive` with the destination root, skill name, base64 payload, and `dryRun` flag (`server.ts:1478-1493`, `skills-server.ts:130-146`).
4. A real extraction backs up the existing destination, removes that directory, creates the destination root, decodes the archive to a temporary `.tgz`, and runs `tar xzf` into the root with junk-directory exclusions (`skills-server.ts:133-141`).
5. The temp archive is removed in a `finally` block after `tar` runs. The rollout records archive, extraction, copy, or blocked-plan errors in per-operation results (`skills-server.ts:137-145`, `server.ts:1445-1522`).

| Mode or condition | Outcome or failure |
|---|---|
| `dryRun: true` | Extraction returns before backup, deletion, directory creation, or temporary archive creation (`skills-server.ts:130-136`). |
| Archive from host is valid and run is real | Existing destination is backed up, then removed; archive contents are unpacked in the destination root (`skills-server.ts:133-141`). |
| Host pack fails, archive is absent, or exceeds host limit | The rollout records the host archive operation as failed and does not call extraction (`server.ts:1402-1443`, `server.ts:1478-1493`, `host.ts:1086-1115`). |
| Backup/removal/root creation/archive write fails | The exception propagates to the rollout operation. These steps precede the `try/finally` around `tar` (`skills-server.ts:133-143`, `server.ts:1478-1493`). |
| `tar` fails | Extraction rejects and the temporary archive is removed by `finally`; the previous destination is not restored after its earlier removal (`skills-server.ts:133-145`). |

## Business rules

- Dry run performs no archive extraction writes (`skills-server.ts:130-136`).
- The archive is extracted under the destination root and excludes recognized skill junk directories (`skills-server.ts:139-141`).
- The host-side archive has an 8 MiB maximum; it is base64 RPC content and excludes recognized junk (`host.ts:1086-1115`, `contract.ts:440-448`).

## Public API

`extractSkillArchive(destRoot, name, archiveBase64, dryRun)` is called by server rollout orchestration; it is not a user-facing RPC method (`skills-server.ts:130-146`, `server.ts:1478-1493`).

## Gotchas

The destination is backed up and removed before archive decoding and extraction. A later write or `tar` error leaves the prior content only in its backup; this function does not restore it (`skills-server.ts:133-145`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](skills.md)
