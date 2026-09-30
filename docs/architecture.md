---
title: Agent Tools architecture
type: architecture
created: 2026-09-27
updated: 2026-09-30
status: active
confidence: medium
tags: [architecture, bb-plugin, rpc]
sources:
  - package.json
  - server.ts
  - host.ts
  - contract.ts
  - app.tsx
  - agents.ts
  - skills.ts
  - skills-sync.ts
  - skills-server.ts
  - skill-tree.ts
  - normalize.ts
  - i18n.ts
---
# Agent Tools architecture
The server coordinates BB UI/CLI requests, host RPC calls, local configuration changes, and stored scan snapshots (`server.ts:479-525`, `host.ts:783-785`).

## System context

A BB operator uses the plugin through the BB plugin UI or `bb tools`; the plugin calls BB host RPC on connected machines, reads BB provider/model metadata, and optionally calls a configured MetaMCP gateway (`server.ts:520-521`, `server.ts:635-649`, `server.ts:995-1023`).

```mermaid
C4Context
  Person(operator, "BB operator", "Reviews inventories and starts explicit changes")
  System_Boundary(bb, "BB runtime") {
    System(plugin, "Agent Tools", "BB plugin")
  }
  System_Ext(hosts, "Enrolled machines", "Host RPC reads CLI configs and skill homes")
  System_Ext(metamcp, "MetaMCP", "Configured gateway API")
  System_Ext(git, "Skills Git remote", "Optional canon synchronization")
  Rel(operator, plugin, "Uses UI, RPC, and bb tools CLI")
  Rel(plugin, hosts, "Calls host RPC over BB")
  Rel(plugin, metamcp, "Fetches namespaces and server lists")
  Rel(hosts, git, "Git sync of ~/.agents/skills")
```

Diagram evidence: plugin entry points and host client (`server.ts:465-521`); host entry (`host.ts:783-785`); optional MetaMCP settings and fetch flow (`server.ts:487-525`, `server.ts:635-649`); canon Git operations (`skills-sync.ts:87-236`); server-process skill directory (`server.ts:1361-1383`, `skills-server.ts:58-64`).

## Containers

```mermaid
C4Container
  Person(operator, "Operator", "Uses BB")
  System_Boundary(plugin, "Agent Tools plugin") {
    Container(ui, "Plugin page", "React / app.tsx", "Shows machine inventory and starts RPC actions")
    Container(server, "Plugin server", "BB Plugin SDK / server.ts", "Computes views, stores snapshots, serves RPC and CLI")
    Container(host, "Host entry", "Node.js / host.ts", "Scans and edits machine-local configuration")
    Container(kv, "BB key-value storage", "BB storage API", "Holds catalogue, settings, and scan snapshots")
  }
  System_Ext(cli, "Agent CLIs", "MCP config, OpenCode config, skills homes")
  System_Ext(meta, "MetaMCP", "Optional gateway")
  Rel(operator, ui, "Uses")
  Rel(ui, server, "BB RPC")
  Rel(server, host, "Host RPC")
  Rel(server, kv, "Reads and writes keys")
  Rel(host, cli, "Scans / edits files")
  Rel(server, meta, "HTTPS API")
```

The manifest points BB to `app.tsx`, `server.ts`, and `host.ts` (`package.json:28-38`). The UI calls RPC methods through the server (`app.tsx:114-138`); the server creates a host client and uses BB KV (`server.ts:520-525`); the host entry performs file operations (`host.ts:783-785`, `host.ts:213-241`, `host.ts:1118-1189`).

## Building blocks

- `agents.ts` defines CLI config paths, dialects, providers, and path confirmation (`agents.ts:5-47`, `agents.ts:56-219`).
- `normalize.ts`, `toml-mcp.ts`, `opencode.ts`, and `probe.ts` translate, compare, edit, and check agent configuration (`server.ts:8-19`, `host.ts:14-19`).
- `contract.ts` defines validated server RPC and host RPC methods and data shapes (`contract.ts:355-452`, `server.ts:201-448`).
- `skills.ts` computes skill states and deterministic promotion/fan-out plans (`skills.ts:103-190`, `skills.ts:267-330`, `skills.ts:409-525`).
- `skills-sync.ts` reconciles the canon with its Git remote, adds ignore patterns for link names and dependency/cache directories, and preserves colliding local skill folders during an untracked-file overwrite recovery (`skills-sync.ts:87-232`).
- `skills-server.ts` scans, backs up, copies, and extracts filtered skill trees in the BB server process's `dataDir/skills` (`skills-server.ts:58-64`, `skills-server.ts:66-100`, `skills-server.ts:102-145`); `skill-tree.ts` defines excluded junk and BB tree measurement (`skill-tree.ts:12-29`, `skill-tree.ts:32-70`).
- `server.ts` owns cross-machine orchestration, state, CLI registration, and hourly sweep (`server.ts:479-525`, `server.ts:2055-2288`, `server.ts:2290-2373`).
- `host.ts` owns machine-local scans, backups, and writes (`host.ts:151-241`, `host.ts:374-435`, `host.ts:783-818`, `host.ts:1118-1189`).
- `app.tsx` renders the machine selector and MCP, skills, archive, plugins, and OpenCode tabs (`app.tsx:3266-3337`).

## Key flows

### Scan and catalogue view

```mermaid
sequenceDiagram
  participant UI as Plugin UI
  participant S as server.ts
  participant H as host.ts
  participant K as BB KV
  UI->>S: overview / rescan
  S->>H: scan, skills_scan, opencode_scan, plugins_scan
  H-->>S: machine snapshots
  S->>K: persist snapshots and lastScanAt
  S-->>UI: overview with drift and pending entries
```

The scan sequence calls `scan`, `skills_scan`, `opencode_scan`, and `plugins_scan` for each connected target and persists each successful result in its host-keyed snapshot; the main MCP scan also stores a failure string when the host call rejects (`server.ts:558-567`, `server.ts:569-612`).

### Apply MCP sync

```mermaid
sequenceDiagram
  participant UI as Plugin UI or CLI
  participant S as server.ts
  participant H as host.ts
  participant F as Agent config file
  UI->>S: plan or sync
  S->>S: derive operations from catalogue and scans
  S->>H: apply(ops, dryRun)
  H->>F: backup, merge, atomic write
  H-->>S: per-operation results
  S-->>UI: counts, errors, refreshed overview
```

The server plans and dispatches changes (`server.ts:1120-1154`, `server.ts:1606-1651`); the host backs up and writes files atomically (`host.ts:213-241`, `host.ts:1118-1189`).

### Skills rollout

```mermaid
sequenceDiagram
  participant UI as Plugin UI or CLI
  participant S as server.ts
  participant H as host.ts
  participant G as Git remote
  participant D as Skill homes
  participant B as BB server dataDir/skills
  UI->>S: skills_fanout
  S->>H: promote newer skills into canon
  S->>H: sync canon with Git when configured
  S->>H: fan out to skill homes
  H->>D: link, mirror, pull, drop, or retire
  H-->>S: operation results and errors
  S->>B: mirror canon folders or extract filtered host archive
  B-->>S: applied/failed counts and operation errors
```

The rollout sequence scans, promotes candidates, synchronizes Git when configured, fans out to connected host homes, then plans and writes mirrors in the BB server process's data directory (`server.ts:1538-1569`, `server.ts:1361-1532`, `skills.ts:267-330`, `skills.ts:409-525`, `skills.ts:582-612`). When a planned server-process mirror is missing from the local canon, the rollout selects a connected host canon and requests a packed skill archive from that host (`server.ts:1412-1453`, `server.ts:1488-1503`, `host.ts:1086-1115`).

## Invariants

- A machine appears in the scan target set only when BB reports it connected (`server.ts:569-578`).
- MCP write eligibility requires an installed, non-gateway, writable agent with an existing config or confirmed path (`server.ts:673-680`).
- A catalogue entry is rolled out only when its scope is `global` and its target list is empty or includes that agent kind (`server.ts:682-685`).
- Failed host scans are retained as error snapshots; skill/OpenCode/plugin scan failures are logged and surfaced through their area state (`server.ts:543-553`, `server.ts:565-598`).
- Config writes take a backup and use a temporary file followed by rename (`host.ts:213-241`).
- The skills fan-out schedule is controlled by user settings; canon fan-out defaults to disabled (`server.ts:507-514`, `server.ts:2267-2287`).

## Cross-cutting concerns

**Validation.** Zod schemas bound RPC inputs and output shapes; `rpcContract` and `hostContract` define the server/host interfaces (`contract.ts:355-452`, `server.ts:201-448`).

**Errors.** Host RPC rejections are recorded on MCP scan snapshots, while writes return per-operation errors; skill bulk actions preserve failures in their response (`server.ts:558-567`, `host.ts:1118-1189`, `server.ts:2130-2160`).

**Language.** UI and CLI strings pass through the shared language functions; the selected language is persisted in BB KV (`i18n.ts:8-69`, `server.ts:483-485`, `server.ts:2162-2167`).

See [API](api.md), [data model](data-model.md), and the [feature pages](features/mcp-catalog.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools deployment](deployment.md)
- [CLI plugin inventory](features/cli-plugins.md)
- [Agent Tools overview](overview.md)
