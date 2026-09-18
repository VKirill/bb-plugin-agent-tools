# Changelog

## 0.1.0

First public release.

- MCP catalogue across every BB machine: server × machine matrix, adopting new servers, sync that only adds, confirmed removal, hourly sweep.
- Adapters for Claude Code, Codex, OpenCode, Cursor, Antigravity, Gemini CLI, Qwen Code, Kimi CLI, Grok CLI, MimoCode, Crush and read-only MetaMCP gateways.
- Skills: one canon in `~/.agents/skills` synced over your own git remote, fan-out into the CLI homes (symlinks for Claude Code and Qwen, a mirror copy for BB, nothing for the CLIs that read the canon themselves), and a per-folder policy so BB's own registry is never rewritten.
- Version archive with restore: every replaced or deleted skill is snapshotted with date, machine and reason; a replacement is cancelled when it would drop files that exist only in the older version.
- OpenCode tab: provider and model hygiene, preselected model for new chats, one-click sync from a reference machine.
