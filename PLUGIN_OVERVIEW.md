## Agent Tools for BB — servers and skills across every machine

Nothing on the laptop, a dozen servers on the workstation, half of them on a
second machine, and skills scattered across five folders? The plugin collects
MCP configurations from every CLI agent and skill folders on every BB machine
into one view, then brings them into line with a shared catalogue and canon.

## Included

- The **Tools** page with machines on the left and a **server × machine**
  matrix on the right; the sidebar badge counts new servers and drift.
- One-click adoption of new servers into the catalogue, either as shared
  standard or locally.
- Synchronization for the selected machine or all machines; optional hourly automatic
  sync adds missing entries and never removes anything.
- MetaMCP gateway reads through its API key, showing which servers are behind
  it.
- The **Skills** tab: the `~/.agents/skills` canon; **copies / new / divergent
  / unnecessary links / BB duplicates** views; and one-click rules; the canon
  synchronizes through its own git remote.
- The `bb tools` CLI and its agent skill.

Claude Code, Codex, OpenCode, Cursor, Antigravity, Gemini, Qwen, Kimi, Grok,
Crush, and the local MetaMCP gateway are supported. Other detected CLIs are
shown as-is and marked when BB cannot operate on them.

## Boundaries

Before writing, the plugin creates a configuration backup; writes are atomic;
JSON files with comments are not rewritten; and configurations with an unconfirmed
path can be created only manually. Servers with absolute paths, loopback
addresses, or references to local secrets are marked local and are not rolled
out. MetaMCP contents are read-only and must be changed in MetaMCP itself.
