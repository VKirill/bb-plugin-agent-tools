// Pure functions and models for OpenCode configuration and provider tracking across machines.
import type {
  OpenCodeProviderConfig,
  OpenCodeScan,
  OpenCodeProviderRow,
  OpenCodeOp,
} from "./contract.js";

/** Providers that are considered standard/canonical for BB machines. */
export const CANONICAL_OPENCODE_PROVIDERS = new Set<string>([
  "router9",
  "zai-coding-plan",
  "deepseek",
  "opencode",
]);

/** Stale or legacy providers that should be cleaned up from OpenCode configs. */
export const STALE_OPENCODE_PROVIDERS = new Set<string>([
  "openai",
  "google",
  "sub2api",
  "zai",
]);

/** Mask secret tokens (e.g. sk-4c22...a901) so they never leak to UI or logs. */
export function maskApiKey(key: string | undefined | null): string {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export interface ParsedOpenCodeConfig {
  model: string | null;
  smallModel: string | null;
  enabledProviders: string[];
  providers: Record<string, OpenCodeProviderConfig>;
  plugins: string[];
  rawProviderConfigs: Record<string, Record<string, unknown>>;
}

/** Parse OpenCode JSON/JSONC text safely. */
export function parseOpenCodeText(text: string): ParsedOpenCodeConfig {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // If not strict JSON, attempt comment-stripped parse
    return {
      model: null,
      smallModel: null,
      enabledProviders: [],
      providers: {},
      plugins: [],
      rawProviderConfigs: {},
    };
  }

  const model = typeof parsed.model === "string" ? parsed.model : null;
  const smallModel = typeof parsed.small_model === "string" ? parsed.small_model : null;

  const enabledProviders = Array.isArray(parsed.enabled_providers)
    ? parsed.enabled_providers.filter((item): item is string => typeof item === "string")
    : [];

  const plugins = Array.isArray(parsed.plugin)
    ? parsed.plugin.filter((item): item is string => typeof item === "string")
    : [];

  const rawProviders =
    parsed.provider && typeof parsed.provider === "object" && !Array.isArray(parsed.provider)
      ? (parsed.provider as Record<string, Record<string, unknown>>)
      : {};

  const providers: Record<string, OpenCodeProviderConfig> = {};
  for (const [id, rawCfg] of Object.entries(rawProviders)) {
    if (!rawCfg || typeof rawCfg !== "object") continue;

    const name = typeof rawCfg.name === "string" ? rawCfg.name : undefined;
    const npm = typeof rawCfg.npm === "string" ? rawCfg.npm : undefined;

    let baseURL: string | undefined = undefined;
    let hasApiKey = false;
    if (rawCfg.options && typeof rawCfg.options === "object") {
      const opts = rawCfg.options as Record<string, unknown>;
      if (typeof opts.baseURL === "string") baseURL = opts.baseURL;
      if (typeof opts.apiKey === "string" && opts.apiKey.trim().length > 0) hasApiKey = true;
    }

    const whitelist = Array.isArray(rawCfg.whitelist)
      ? rawCfg.whitelist.filter((w): w is string => typeof w === "string")
      : undefined;

    const models: Record<string, { name?: string; tool_call?: boolean; attachment?: boolean; temperature?: boolean }> = {};
    if (rawCfg.models && typeof rawCfg.models === "object" && !Array.isArray(rawCfg.models)) {
      for (const [modelId, mVal] of Object.entries(rawCfg.models as Record<string, unknown>)) {
        if (mVal && typeof mVal === "object") {
          const mObj = mVal as Record<string, unknown>;
          models[modelId] = {
            name: typeof mObj.name === "string" ? mObj.name : undefined,
            tool_call: typeof mObj.tool_call === "boolean" ? mObj.tool_call : undefined,
            attachment: typeof mObj.attachment === "boolean" ? mObj.attachment : undefined,
            temperature: typeof mObj.temperature === "boolean" ? mObj.temperature : undefined,
          };
        }
      }
    }

    providers[id] = {
      id,
      name,
      npm,
      baseURL,
      hasApiKey,
      models: Object.keys(models).length > 0 ? models : undefined,
      whitelist,
      raw: rawCfg,
    };
  }

  return {
    model,
    smallModel,
    enabledProviders,
    providers,
    plugins,
    rawProviderConfigs: rawProviders,
  };
}

/** Apply OpenCode operations onto a parsed JSON config object. */
export function applyOpenCodeOps(
  config: Record<string, unknown>,
  ops: OpenCodeOp[],
): Record<string, unknown> {
  const updated = { ...config };

  for (const op of ops) {
    if (op.action === "upsert_provider") {
      if (!updated.provider || typeof updated.provider !== "object") {
        updated.provider = {};
      }
      const providerMap = { ...(updated.provider as Record<string, unknown>) };
      providerMap[op.providerId] = op.config;
      updated.provider = providerMap;

      if (op.enable) {
        const enabledList = Array.isArray(updated.enabled_providers)
          ? [...(updated.enabled_providers as string[])]
          : [];
        if (!enabledList.includes(op.providerId)) {
          enabledList.push(op.providerId);
          updated.enabled_providers = enabledList;
        }
      }
    } else if (op.action === "remove_provider") {
      if (updated.provider && typeof updated.provider === "object") {
        const providerMap = { ...(updated.provider as Record<string, unknown>) };
        delete providerMap[op.providerId];
        updated.provider = providerMap;
      }
      if (Array.isArray(updated.enabled_providers)) {
        updated.enabled_providers = (updated.enabled_providers as string[]).filter(
          (item) => item !== op.providerId,
        );
      }
    } else if (op.action === "set_models") {
      if (op.model !== undefined) updated.model = op.model;
      if (op.smallModel !== undefined) updated.small_model = op.smallModel;
    } else if (op.action === "set_enabled") {
      updated.enabled_providers = [...op.enabledProviders];
    }
  }

  return updated;
}

/** Build matrix of OpenCode providers across all scanned machines. */
export function buildProviderRows(
  hosts: { hostId: string; hostName: string; scan: OpenCodeScan | null }[],
): OpenCodeProviderRow[] {
  const allProviderIds = new Set<string>();

  // Ensure canonical providers are present in the list
  for (const p of CANONICAL_OPENCODE_PROVIDERS) allProviderIds.add(p);

  for (const h of hosts) {
    if (!h.scan) continue;
    for (const p of Object.keys(h.scan.providers)) allProviderIds.add(p);
    for (const p of h.scan.enabledProviders) allProviderIds.add(p);
  }

  const rows: OpenCodeProviderRow[] = [];

  for (const id of allProviderIds) {
    let bestName: string = id;
    let bestNpm: string | null = null;
    let bestBaseURL: string | null = null;

    const hostPresence: OpenCodeProviderRow["hosts"] = {};

    for (const h of hosts) {
      const scan = h.scan;
      if (!scan) {
        hostPresence[h.hostId] = {
          configured: false,
          enabled: false,
          models: [],
          hasApiKey: false,
        };
        continue;
      }

      const pCfg = scan.providers[id];
      const isEnabled = scan.enabledProviders.includes(id);

      if (pCfg) {
        if (pCfg.name) bestName = pCfg.name;
        if (pCfg.npm) bestNpm = pCfg.npm;
        if (pCfg.baseURL) bestBaseURL = pCfg.baseURL;
      }

      const models: string[] = [];
      if (pCfg?.models) {
        models.push(...Object.keys(pCfg.models));
      } else if (pCfg?.whitelist) {
        models.push(...pCfg.whitelist);
      }

      hostPresence[h.hostId] = {
        configured: Boolean(pCfg),
        enabled: isEnabled,
        models,
        hasApiKey: pCfg?.hasApiKey ?? false,
      };
    }

    if (id === "router9" && bestName === "router9") bestName = "Antigravity (9router)";
    if (id === "zai-coding-plan" && bestName === "zai-coding-plan") bestName = "Z.AI Coding Plan";
    if (id === "deepseek" && bestName === "deepseek") bestName = "DeepSeek (встроенный)";
    if (id === "opencode" && bestName === "opencode") bestName = "OpenCode Zen";

    rows.push({
      id,
      name: bestName,
      npm: bestNpm,
      baseURL: bestBaseURL,
      isCanonical: CANONICAL_OPENCODE_PROVIDERS.has(id),
      isStale: STALE_OPENCODE_PROVIDERS.has(id),
      hosts: hostPresence,
    });
  }

  // Sort: canonical first, then active/other, stale at the end
  return rows.sort((a, b) => {
    if (a.isCanonical && !b.isCanonical) return -1;
    if (!a.isCanonical && b.isCanonical) return 1;
    if (a.isStale && !b.isStale) return 1;
    if (!a.isStale && b.isStale) return -1;
    return a.id.localeCompare(b.id);
  });
}

/** Detect drift between hosts and canonical reference. */
export function detectOpenCodeDrift(
  hosts: { hostId: string; hostName: string; scan: OpenCodeScan | null }[],
  canonicalHostId: string | null,
): { hostId: string; type: "model" | "small_model" | "stale_provider" | "missing_provider" | "disabled_provider"; description: string }[] {
  const drift: {
    hostId: string;
    type: "model" | "small_model" | "stale_provider" | "missing_provider" | "disabled_provider";
    description: string;
  }[] = [];

  const canon = hosts.find((h) => h.hostId === canonicalHostId)?.scan ?? hosts[0]?.scan ?? null;

  for (const h of hosts) {
    const scan = h.scan;
    if (!scan || !scan.installed) continue;

    // Check models vs canonical
    if (canon && canon.model && scan.model && scan.model !== canon.model) {
      drift.push({
        hostId: h.hostId,
        type: "model",
        description: `Основная модель (${scan.model}) отличается от эталона (${canon.model})`,
      });
    }

    if (canon && canon.smallModel && scan.smallModel && scan.smallModel !== canon.smallModel) {
      drift.push({
        hostId: h.hostId,
        type: "small_model",
        description: `Быстрая модель (${scan.smallModel}) отличается от эталона (${canon.smallModel})`,
      });
    }

    // Check for stale providers
    for (const pId of Object.keys(scan.providers)) {
      if (STALE_OPENCODE_PROVIDERS.has(pId)) {
        drift.push({
          hostId: h.hostId,
          type: "stale_provider",
          description: `Устаревший провайдер «${pId}» в конфигурации`,
        });
      }
    }

    // Check missing canonical providers
    if (canon) {
      for (const [canonId] of Object.entries(canon.providers)) {
        if (CANONICAL_OPENCODE_PROVIDERS.has(canonId) && !scan.providers[canonId]) {
          drift.push({
            hostId: h.hostId,
            type: "missing_provider",
            description: `Отсутствует канонический провайдер «${canonId}»`,
          });
        }
      }
    }
  }

  return drift;
}
