# Agent Tools for BB

Agent Tools is a BB plugin for viewing MCP servers, CLI plugins, and agent skills across connected BB machines. It provides a shared MCP catalogue, a skills canon with explicit sync and fan-out actions, and OpenCode provider/model comparison.

## Quick start

```sh
npm ci
npm run build
bb plugin install .
```

Open the **Agent Tools** page in BB to review machine inventories and choose actions. See [Deployment](docs/deployment.md) for configuration and development steps.

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
