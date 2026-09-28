---
title: Agent Tools deployment
type: deployment
created: 2026-09-27
updated: 2026-09-28
status: active
confidence: high
tags: [deployment, build, install]
sources:
  - package.json
  - AGENTS.md
  - server.ts
  - contract.ts
  - host.ts
  - package-lock.json
---
# Agent Tools deployment
The project installs as a BB path plugin; build it with the BB plugin CLI, then reload `agent-tools` in the live BB runtime (`AGENTS.md:10`, `package.json:74-78`).

## Prerequisites

- Node.js with npm for the lockfile install and scripts (`package.json:74-78`).
- BB `>=0.43` and plugin SDK `>=0.4.87` (`package.json:21-24`).
- BB CLI available for plugin build, install, reload, and runtime commands (`AGENTS.md:10`, `AGENTS.md:26-28`).

## Install and build

1. From the plugin root, install the lockfile dependencies:

   The manifest dependencies are listed in `package.json:38-72` and the lockfile is present at `package-lock.json:1`.

   ```sh
   npm ci
   ```

2. Run type checking and tests when preparing a code release:

   The scripts map to `tsc --noEmit` and Node's test runner (`package.json:74-78`).

   ```sh
   npm run typecheck
   npm test
   ```

3. Build the BB plugin:

   The manifest build script invokes `bb plugin build` (`package.json:74-76`).

   ```sh
   bb plugin build .
   ```

4. Install the path plugin and reload the registered plugin:

   The path-plugin lifecycle is recorded in `AGENTS.md:10`.

   ```sh
   bb plugin install .
   bb plugin reload agent-tools
   ```

5. Verify the live behavior changed by the build. Use `bb tools status`, `bb tools plan`, or `bb tools scan --json`, then inspect the catalogue page in the live BB runtime (`AGENTS.md:28-30`).

## Configure

Open `bb plugin config agent-tools`. Configure MetaMCP URL, secret API key, namespace list, optional skills Git remote, and the scheduled skills fan-out setting (`server.ts:473-515`). The catalog's hourly sync toggle stores `autoSync` in BB key-value storage and defaults to off when no value exists; scheduled skills fan-out uses the `skillsFanOutAuto` setting, which also defaults to off (`server.ts:493-500`, `server.ts:528-529`, `server.ts:2057-2064`). The scheduled sweep runs catalog sync and skills rollout in separate branches according to those values (`server.ts:2067-2087`).

## Rollback

The repository does not define a rollback script or plugin data migration (`package.json:74-78`, `server.ts:465-525`). To restore a prior source revision, use a clean worktree or checkout at the known-good revision, build it, and reload the plugin using the install lifecycle above. Do not discard uncommitted work in the working checkout.

## Troubleshooting

- If `npm ci` fails, confirm that the repository lockfile is present (`package-lock.json:1`) and inspect the declared dependency scripts (`package.json:38-78`).
- If BB refuses the build, check the declared BB and SDK minimums (`package.json:21-24`).
- If a host does not appear in scan results, the scan targets only hosts BB marks connected (`server.ts:555-564`).
- If settings appear stale after a change, server reads settings at the point of use (`server.ts:517-520`).
- If a CLI config is not editable, inspect its detected `writable` and warning fields; JSONC comments make a config read-only (`contract.ts:21-33`, `host.ts:802-813`).

See [architecture](architecture.md), [API](api.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [MCP server catalogue](features/mcp-catalog.md)
- [Agent skill canon and rollout](features/skills.md)
- [Agent Tools overview](overview.md)
