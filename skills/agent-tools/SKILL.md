---
name: agent-tools
description: Agent tooling across every BB machine — MCP servers (what is connected where, catalogue adoption, MetaMCP gateways, synchronization) and skills (a single ~/.agents/skills canon, copies, duplicates, git sync). Use for questions such as “which MCP servers exist on the machines?”, “why is server X absent on this machine?”, “roll out MCP everywhere”, “where are skills stored?”, or “remove duplicate skills”. Russian triggers: «какие MCP есть на машинах», «раскатай MCP везде», «где лежат скиллы», «убери дубли скиллов». Do not use to configure MCP servers themselves or invoke their tools.
---

# Agent Tools

The plugin maintains one MCP-server list (the catalogue) and one skill canon,
then brings BB machines into line with them. It reads the installed CLI-agent
configuration on every machine: Claude Code (`~/.claude.json`), Codex
(`~/.codex/config.toml`), OpenCode, Cursor, Antigravity, Gemini, Qwen, Kimi,
Grok, Crush, and the local MetaMCP gateway (`~/.agents/metamcp.mcp.json`).

## Commands

```bash
bb tools status            # machines, their CLIs, drift, new servers
bb tools scan              # rescan all machines now
bb tools pending           # servers found on machines but not in the catalogue
bb tools adopt <name>...   # adopt them into the catalogue
bb tools ignore <name>...  # stop suggesting them
bb tools plan              # what synchronization would change (writes nothing)
bb tools sync --dry-run    # run without writes
bb tools sync              # add missing servers to every machine
bb tools sync --with-different   # also overwrite differing servers
bb tools auto on|off       # hourly automatic synchronization
bb tools gateway-add <file.json> --host <id>   # add your MCP server behind the MetaMCP gateway
bb tools skills [--host <id>]                  # skills outside the canon
bb tools skills-adopt <folder> <name> --host <id> [--link|--delete|--take|--unlink]
bb tools skills-sync [--host <id>]             # sync the skill canon to the git remote in settings
```

Every command accepts `--json`; `scan`, `plan`, and `sync` also accept
`--host <id>` to operate on one machine.

## MCP rules

- Synchronization only adds entries by default; it never removes anything.
- Servers with an absolute binary path, a `127.0.0.1` address, or a
  `${SECRET}` reference are marked local and are not rolled out: that
  configuration would not run on another machine anyway.
- Before every write, the plugin creates a backup next to the configuration
  (`*.bak-bb-mcp-<time>`; it retains the latest five).
- The plugin reads files with comments (such as `opencode.jsonc`) but does not
  rewrite them; the Config column says when this applies.
- Servers behind a MetaMCP gateway are read-only: change their contents in
  MetaMCP itself or with `gateway-add`.

## Skill rules

- The canon is `~/.agents/skills`; Codex, Cursor, and OpenCode read it
  directly.
- BB sessions read skills from the server (`experimental_dataDir/skills`).
  Fan-out puts real directories there. Copies on a Mini or MacBook do not
  replace that root.
- `~/.claude/skills` is a second live home: Claude Code reads only it, so it
  contains symlinks to the canon. Qwen also uses symlinks in `~/.qwen/skills`; BB receives real mirror
  directories in `~/.bb/skills` without rewriting its own registry.
- In folders that read the canon directly, a copy is simply removed because a
  symlink is unnecessary. `~/.gemini/config/skills` remains empty: both copies
  and links are removed.
- A real skill copy in two homes creates a duplicate in the list (verified in
  Codex: one name from two roots appears twice); a symlink does not.
- Differing copies are resolved by the modification dates of all files in the
  skill folder; the losing copy goes to `~/.agents/skills-backups`. Equal dates
  require a manual decision.
- A link in `~/.bb/skills` is marked “BB registry duplicate”: BB injects that
  skill into its own sessions, so it appears twice within BB. Whether to remove
  it depends on whether that CLI is run outside BB; the plugin does not decide
  automatically.
