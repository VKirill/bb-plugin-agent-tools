/** Narrow a spawned thread when the VK core advertises required session policy. */

export const MANDATORY_BB_PLUGINS = ["environment-project-checkout", "project-folders"] as const;
export const MANDATORY_MCP_SERVERS = ["bb-bridge"] as const;

export type VkNameFilter = { mode: "allow"; names: string[] };

export type RequiredSessionPolicyBody = {
  bbPlugins?: VkNameFilter;
  skills?: VkNameFilter;
  mcpServers?: VkNameFilter;
  nativePlugins?: VkNameFilter;
  userInstructions?: boolean;
  projectInstructions?: boolean;
  claudeAiSync?: boolean;
};

export type RequiredSessionPolicySpawn = {
  version: 1;
  policy: RequiredSessionPolicyBody;
};

export type SessionNeed = {
  /** Extra BB plugins; checkout/folders are always added when the provider can narrow bbPlugins. */
  bbPlugins?: string[];
  skills?: string[];
  /** Omit to leave MCP as BB loads it; `[]` keeps only bb-bridge. */
  mcpServers?: string[];
};

type Agents = { experimental_vkRequiredSessionPolicy?: unknown };

function unique(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name.trim() !== ""))];
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value as string[];
}

function advertisedFor(
  agents: Agents,
  providerId: string,
): { groups: string[]; switches: string[]; mandatoryBbPlugins: string[]; mandatoryMcpServers: string[] } | null {
  const advertise = agents.experimental_vkRequiredSessionPolicy;
  if (typeof advertise !== "function") return null;
  let raw: unknown;
  try {
    raw = (advertise as () => unknown)();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const groupsTable = row.providerGroups;
  const switchesTable = row.instructionSwitches;
  if (!groupsTable || typeof groupsTable !== "object" || !switchesTable || typeof switchesTable !== "object") {
    return null;
  }
  const groups = stringList((groupsTable as Record<string, unknown>)[providerId]);
  const switches = stringList((switchesTable as Record<string, unknown>)[providerId]);
  if (!groups || !switches) return null;
  const mandatoryBbPlugins = stringList(row.mandatoryBbPlugins) ?? [...MANDATORY_BB_PLUGINS];
  const mandatoryMcpServers = stringList(row.mandatoryMcpServers) ?? [...MANDATORY_MCP_SERVERS];
  return { groups, switches, mandatoryBbPlugins, mandatoryMcpServers };
}

/**
 * Spawn field for `bb.sdk.threads.spawn`. Empty object when the core has no required-policy
 * API or the provider is not in the advertised tables — same spawn as today.
 */
export function requiredSessionPolicySpawnField(
  agents: object,
  providerId: string | undefined,
  need: SessionNeed,
): { experimental_vkRequiredSessionPolicy: RequiredSessionPolicySpawn } | Record<string, never> {
  if (!providerId) return {};
  const advertised = advertisedFor(agents as Agents, providerId);
  if (!advertised) return {};
  const policy: RequiredSessionPolicyBody = {};
  if (advertised.groups.includes("bbPlugins")) {
    policy.bbPlugins = { mode: "allow", names: unique([...advertised.mandatoryBbPlugins, ...(need.bbPlugins ?? [])]) };
  }
  if (advertised.groups.includes("skills")) {
    policy.skills = { mode: "allow", names: unique(need.skills ?? []) };
  }
  if (advertised.groups.includes("mcpServers") && need.mcpServers !== undefined) {
    policy.mcpServers = { mode: "allow", names: unique([...advertised.mandatoryMcpServers, ...need.mcpServers]) };
  }
  if (advertised.groups.includes("nativePlugins")) {
    policy.nativePlugins = { mode: "allow", names: [] };
  }
  if (advertised.switches.includes("userInstructions")) {
    policy.userInstructions = false;
  }
  return { experimental_vkRequiredSessionPolicy: { version: 1, policy } };
}

/** Hidden classifier / card-writer: plugin tools only, no skill catalog, no extra MCP. */
export function oneShotPluginNeed(pluginId: string): SessionNeed {
  return { bbPlugins: [pluginId], skills: [], mcpServers: [] };
}

export const CORE_REQUIRED_SESSION_ADVERTISEMENT = {
  version: 1,
  persist: true,
  requiredMarker: true,
  snapshotDigest: true,
  parentCeiling: true,
  bridgeHandshakeVersion: 1,
  markerStorage: "thread-plugin-metadata",
  providerGroups: {
    "claude-code": ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    codex: ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    "acp-opencode": ["bbPlugins", "skills", "mcpServers"],
    "acp-cursor": ["bbPlugins", "skills", "mcpServers"],
    opencode2: ["bbPlugins", "skills", "mcpServers"],
  },
  instructionSwitches: {
    "claude-code": ["userInstructions", "projectInstructions", "claudeAiSync"],
    codex: ["userInstructions", "projectInstructions"],
    "acp-opencode": ["userInstructions", "projectInstructions"],
    "acp-cursor": ["userInstructions"],
    opencode2: ["userInstructions"],
  },
  mandatoryBbPlugins: [...MANDATORY_BB_PLUGINS],
  mandatoryMcpServers: [...MANDATORY_MCP_SERVERS],
} as const;
