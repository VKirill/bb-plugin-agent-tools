---
title: Agent Tools deployment
type: deployment
created: 2026-09-27
updated: 2026-10-28
status: active
confidence: medium
tags: [deployment, build, install]
sources:
  - package.json
  - AGENTS.md
  - server.ts
  - contract.ts
  - host.ts
  - package-lock.json
  - settings-page.tsx
---
# Agent Tools deployment
The package manifest declares the BB server, host, and app entry points; its build script invokes the BB plugin CLI (`package.json:25-37`, `package.json:74-76`).

## Prerequisites

- Node.js with npm for the lockfile install and scripts (`package.json:74-78`).
- BB `>=0.43` and plugin SDK `>=0.4.87` (`package.json:21-24`).
- BB CLI available for plugin build and runtime commands (`package.json:74-76`, `server.ts:2143-2255`).

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

   ```sh
   bb plugin install .
   bb plugin reload agent-tools
   ```

5. Verify the live behavior changed by the build. Use `bb tools status`, `bb tools plan`, or `bb tools scan --json`; the plugin registers these commands and their handlers (`server.ts:2393-2408`, `server.ts:2535-2543`, `server.ts:2594-2603`).

## Managed hub installation

The canonical development checkout is separate from the hub’s managed Git installation. Confirm its source with `bb plugin list --json`: `git:https://github.com/VKirill/bb-plugin-agent-tools.git@semver:^0.2.0`. After typecheck, tests, and `bb plugin build .`, commit and push `origin main`, publish a new `vX.Y.Z` tag and GitHub Release, then run `bb plugin update agent-tools --yes` and `bb plugin reload agent-tools`. Confirm the version and status, then check the affected UI and CLI scenarios. Do not replace this source with a local path installation or use the path-plugin rsync helper.

A failed managed activation rolls back automatically. For a functional rollback, restore the previous release’s affected files in a new fix commit on main, build and publish it, then update the same managed source. Keep configuration and skill data intact; this release adds no data migration.

## Configure

Open `bb plugin config agent-tools` for MetaMCP URL, secret API key, namespace list, and the skills classifier provider/model/project and schedule settings (`server.ts:492-542`). The Settings page controls classifier provider, model, project, automatic classification, and whether machine-copy cleanup is offered (`settings-page.tsx:100-199`). Scheduled MCP sync is stored separately in BB KV and defaults to off; its sweep branch runs only when enabled (`server.ts:576-578`, `server.ts:2292-2312`). The hourly sweep refreshes machine skill counts and starts classification when enabled; it does not fan out skills to machine folders (`server.ts:2302-2312`).

## Rollback

The repository does not define a rollback script or plugin data migration (`package.json:74-78`, `server.ts:465-525`). To restore a prior source revision, use a clean worktree or checkout at the known-good revision, build it, and reload the plugin using the install lifecycle above. Do not discard uncommitted work in the working checkout.

## Troubleshooting

- If `npm ci` fails, confirm that the repository lockfile is present (`package-lock.json:1`) and inspect the declared dependency scripts (`package.json:38-78`).
- If BB refuses the build, check the declared BB and SDK minimums (`package.json:21-24`).
- If a host does not appear in scan results, the scan targets only hosts BB marks connected (`server.ts:603-612`).
- Classifier and cleanup settings are read when the skills service uses them; Settings page edits persist through `settings.experimental_set` (`server.ts:543-560`).
- If a CLI config is not editable, inspect its detected `writable` and warning fields; JSONC comments make a config read-only (`contract.ts:21-33`, `host.ts:802-813`).

See [architecture](architecture.md), [API](api.md), and [gotchas](gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [MCP server catalogue](features/mcp-catalog.md)
- [Agent Tools overview](overview.md)
