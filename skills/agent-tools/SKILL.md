---
name: agent-tools
description: "Agent tooling across every BB machine. MCP servers: what is connected where, catalogue adoption, MetaMCP gateways, synchronization. Skills: the canon on the BB hub, publishing and taking skills out for editing, the category tree, skill copies left on machines. Use for questions such as which MCP servers are on the machines, why server X is missing on a machine, roll out MCP everywhere, where skills live, publish or edit a skill, which category a skill is in, remove duplicate skills. Russian triggers: какие MCP есть на машинах, раскатай MCP везде, где лежат скиллы, опубликуй навык, категории навыков, убери дубли скиллов. Not for configuring an MCP server itself or calling its tools."
---

# Agent Tools

The plugin keeps one MCP-server list (the catalogue) and brings BB machines
into line with it, and it manages the skills canon on the BB hub. It reads the
CLI-agent configuration on every machine: Claude Code (`~/.claude.json`),
Codex (`~/.codex/config.toml`), OpenCode, Cursor, Antigravity, Gemini, Qwen,
Kimi, Grok, Crush, and the local MetaMCP gateway (`~/.agents/metamcp.mcp.json`).

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

bb tools skills-hub                       # skills on the hub: git, problems, copies left on machines
bb tools skills-tree [--skills]           # the category tree (with skill names)
bb tools skills-publish <folder> [--dry-run]    # publish a skill folder to the hub (checks, commits, pushes)
bb tools skills-pull <skill> [--to <folder>]    # copy a hub skill into ~/skill-drafts for editing
bb tools skills-move <skill> "Section/Subsection"   # place a skill by hand
bb tools skills-classify [--wait]         # sort skills that have no category
bb tools skills-remove <skill>            # move a skill from the hub to the archive
bb tools skills-machines                  # skill copies still on machines, and which are missing on the hub
bb tools skills-import --host <machine> [--dry-run]   # publish a machine's skills the hub lacks
bb tools skills-cleanup --host <machine> [--dry-run]   # move them into a dated backup
```

Every command accepts `--json`; `scan`, `plan`, and `sync` also accept
`--host <id>` to operate on one machine. Skill commands run on the machine of
the calling thread unless `--host` names another one.

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

- The canon is the hub's BB data dir, `~/.bb/skills` on the BB server. BB
  registers user skills from there and copies them into every session of every
  provider on every machine. Create and change skills through the hub (below),
  not by writing into `~/.agents/skills`, `~/.claude/skills` or a machine's
  `~/.bb/skills`: BB does not read those, and CLIs that do show the skill twice.
- The plugin leaves skill folders on machines alone. `skills-import` and «Move
  to the hub» only copy what the hub lacks; the originals stay. Removing
  machine copies (`skills-cleanup`, «Clean up…») is offered only when the
  setting «Skills: offer to remove machine copies» is on.
- To change a skill: `bb tools skills-pull <skill>`, edit the copy in
  `~/skill-drafts/<skill>`, then `bb tools skills-publish ~/skill-drafts/<skill>`.
  A new skill is written in any folder and published the same way.
- Publishing refuses what BB would skip: unparseable frontmatter (quote a
  description that contains `: `), a name that is not lowercase letters, digits
  and single hyphens, a description over 1024 characters, more than 10 MB or
  1000 files. Inside a skill, refer to its own files with relative paths: the
  session copy does not live in `~/.agents/skills`.
- After installing the plugin, copy the machines' existing skills to the hub (`skills-import` or «Move to the hub» on the Skills page).
- Every publish and removal is committed to the skills git repository on the
  hub and pushed. A replaced or removed folder also goes to
  `~/.agents/skills-backups` on the hub.
- The classifier provider and model are chosen on the plugin's Settings page (any BB provider; empty model = the provider's default).
- Categories (section → subsection) belong to the plugin, not to the skill
  files. A new skill is placed next to its siblings with the same name prefix,
  otherwise by a small model in a hidden thread; unsure answers wait in review.
  A placed skill is never moved automatically.
