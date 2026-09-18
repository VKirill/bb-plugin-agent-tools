// Catalogue of CLI agents this plugin knows about, and where each one keeps
// its MCP servers. Shared by the server (labels, planning) and the host entry
// (actual reading and writing) — so it must stay free of Node imports.

/** Config dialects. Each one stores the same idea in a different shape. */
export type McpStyle =
  | "claude" // { command, args, env } | { type: "http"|"sse", url, headers }
  | "codex-toml" // [mcp_servers.<name>] command/args/env or url/http_headers
  | "opencode" // { type: "local", command: [bin, ...args], environment }
  //           | { type: "remote", url, headers }
  | "antigravity" // { command, args, env } | { serverUrl, headers }
  | "grok-toml" // [mcp_servers.<name>] command/args/env or url/headers
  | "gemini" // { command, args, env } | { httpUrl, headers } (http) | { url, headers } (sse)
  | "metamcp"; // { command, args, env } | { url, transportType: "http"|"sse", headers }

export type ConfigFormat = "json" | "jsonc" | "toml";

export interface AgentConfigFile {
  /** Path relative to the home directory. */
  readonly path: string;
  readonly format: ConfigFormat;
  /** Top-level key holding the server map. */
  readonly pointer: string;
  readonly style: McpStyle;
}

export interface AgentDef {
  readonly kind: string;
  readonly label: string;
  /** Executables that prove the CLI is installed on a machine. */
  readonly bins: readonly string[];
  /** Candidate config files, most canonical first. */
  readonly configs: readonly AgentConfigFile[];
  /**
   * BB provider ids that expose this CLI as a thread provider. Empty means BB
   * cannot drive this CLI, so the machine can hold MCP servers BB never sees.
   */
  readonly bbProviders: readonly string[];
  /** A gateway aggregates other MCP servers instead of being one itself. */
  readonly gateway?: boolean;
  /**
   * False when the config path is a best guess. Such an agent is only written
   * to when the file already exists, so the plugin never scatters config files
   * a CLI may not even read.
   */
  readonly confirmedPath?: boolean;
}

const claudeFile = (path: string): AgentConfigFile => ({
  path,
  format: "json",
  pointer: "mcpServers",
  style: "claude",
});

export const AGENTS: readonly AgentDef[] = [
  {
    kind: "claude-code",
    confirmedPath: true,
    label: "Claude Code",
    bins: ["claude"],
    configs: [claudeFile(".claude.json")],
    bbProviders: ["claude-code"],
  },
  {
    kind: "codex",
    confirmedPath: true,
    label: "Codex",
    bins: ["codex"],
    configs: [
      {
        path: ".codex/config.toml",
        format: "toml",
        pointer: "mcp_servers",
        style: "codex-toml",
      },
    ],
    bbProviders: ["codex"],
  },
  {
    kind: "opencode",
    confirmedPath: true,
    label: "OpenCode",
    bins: ["opencode"],
    configs: [
      {
        path: ".config/opencode/opencode.json",
        format: "json",
        pointer: "mcp",
        style: "opencode",
      },
      {
        path: ".config/opencode/opencode.jsonc",
        format: "jsonc",
        pointer: "mcp",
        style: "opencode",
      },
    ],
    bbProviders: ["acp-opencode", "opencode"],
  },
  {
    kind: "cursor",
    confirmedPath: true,
    label: "Cursor",
    bins: ["cursor-agent", "cursor"],
    configs: [claudeFile(".cursor/mcp.json")],
    bbProviders: ["acp-cursor", "cursor-agent"],
  },
  {
    kind: "antigravity",
    confirmedPath: true,
    label: "Antigravity (agy)",
    bins: ["agy", "antigravity"],
    configs: [
      {
        path: ".agents/mcp_config.json",
        format: "json",
        pointer: "mcpServers",
        style: "antigravity",
      },
      {
        path: ".antigravity/mcp_config.json",
        format: "json",
        pointer: "mcpServers",
        style: "antigravity",
      },
    ],
    bbProviders: ["acp-antigravity", "antigravity"],
  },
  {
    kind: "gemini",
    confirmedPath: true,
    label: "Gemini CLI",
    bins: ["gemini"],
    configs: [
      {
        path: ".gemini/settings.json",
        format: "json",
        pointer: "mcpServers",
        style: "gemini",
      },
    ],
    bbProviders: ["acp-gemini", "gemini"],
  },
  {
    kind: "qwen",
    confirmedPath: true,
    label: "Qwen Code",
    bins: ["qwen"],
    configs: [claudeFile(".qwen/settings.json")],
    bbProviders: ["acp-qwen", "qwen"],
  },
  {
    kind: "kimi",
    label: "Kimi CLI",
    bins: ["kimi"],
    configs: [claudeFile(".kimi-code/mcp.json")],
    bbProviders: ["acp-kimi", "kimi"],
  },
  {
    kind: "grok",
    confirmedPath: true,
    label: "Grok CLI",
    bins: ["grok"],
    configs: [
      {
        path: ".grok/config.toml",
        format: "toml",
        pointer: "mcp_servers",
        style: "grok-toml",
      },
    ],
    bbProviders: ["acp-grok", "grok"],
  },
  {
    kind: "crush",
    label: "Crush",
    bins: ["crush"],
    configs: [
      {
        path: ".config/crush/crush.json",
        format: "json",
        pointer: "mcp",
        style: "claude",
      },
    ],
    bbProviders: ["acp-crush", "crush"],
  },
  {
    kind: "mimocode",
    confirmedPath: true,
    label: "MimoCode",
    bins: ["mimo"],
    configs: [
      {
        path: ".config/mimocode/mimocode.json",
        format: "json",
        pointer: "mcp",
        style: "opencode",
      },
    ],
    bbProviders: [],
  },
  {
    kind: "metamcp-stdio",
    label: "MetaMCP",
    bins: [],
    configs: [
      {
        path: ".agents/metamcp.mcp.json",
        format: "json",
        pointer: "mcpServers",
        style: "metamcp",
      },
    ],
    bbProviders: [],
    gateway: true,
  },
];

/**
 * CLIs with no MCP adapter yet. They are still reported per machine so the
 * catalogue shows every agent that is installed, not only the managed ones.
 */
export const EXTRA_CLI_BINS: readonly string[] = [
  "aider",
  "amp",
  "copilot",
  "droid",
  "goose",
];

export const AGENT_BY_KIND = new Map(AGENTS.map((agent) => [agent.kind, agent]));

/**
 * Диалекты, у которых выключение сервера — часть формата. Codex показывает
 * это в `codex mcp list --json` как `enabled`; у Claude Code такого поля нет,
 * там сервер можно только удалить.
 */
const DISABLE_AWARE_STYLES = new Set<McpStyle>(["codex-toml", "grok-toml", "opencode"]);

export function supportsDisable(kind: string): boolean {
  const agent = AGENT_BY_KIND.get(kind);
  if (agent === undefined) return false;
  return agent.configs.some((file) => DISABLE_AWARE_STYLES.has(file.style));
}

export function agentLabel(kind: string): string {
  return AGENT_BY_KIND.get(kind)?.label ?? kind;
}
