---
title: Agent Tools for BB
type: overview
created: 2026-09-18
updated: 2026-09-30
status: active
confidence: medium
tags: [bb-plugin, mcp, agent-skills]
sources:
  - package.json
  - server.ts
  - app.tsx
  - docs/overview.md
  - docs/deployment.md
---
# Agent Tools for BB

Agent Tools is a BB plugin for viewing MCP servers, CLI plugins, and agent skills across connected BB machines (`package.json:1-3`, `server.ts:479-525`). It provides a shared MCP catalogue, a skills canon with explicit sync and fan-out actions, and OpenCode provider/model comparison (`docs/overview.md:23-29`).

## Quick start

```sh
npm ci
npm run build
bb plugin install .
```

Open the **Agent Tools** page in BB to see the machine selector and its MCP, skills, archive, plugins, and OpenCode tabs (`app.tsx:3275-3345`). See [Deployment](docs/deployment.md) for configuration and build/install steps (`docs/deployment.md:26-66`).

## Documentation

- [Overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [Features](docs/features/mcp-catalog.md): [MCP catalogue](docs/features/mcp-catalog.md), [skills](docs/features/skills.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md)
- [API and CLI commands](docs/api.md)
- [Data model](docs/data-model.md)
- [Deployment](docs/deployment.md)
- [Gotchas](docs/gotchas.md)
- [Decisions](docs/decisions.md)

## License

MIT. See [LICENSE](LICENSE).
