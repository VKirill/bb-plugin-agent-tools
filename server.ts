// bb-plugin-agent-tools — MCP servers and skills of every BB machine in one place.
//
// The plugin scans each enrolled machine over host RPC, normalizes what every
// installed CLI agent has configured, compares it against the catalogue (the
// desired state kept here), and can roll the difference back out.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AGENTS, AGENT_BY_KIND, EXTRA_CLI_BINS, supportsDisable } from "./agents";
import {
  hostContract,
  probeResultSchema,
  catalogEntrySchema,
  mcpServerSchema,
  pendingSchema,
  detectedAgentSchema,
  skillsScanSchema,
  cliPluginItemSchema,
  openCodeOverviewSchema,
  openCodeOpSchema,
  openCodeModelItemSchema,
  type ApplyOp,
  type CatalogEntry,
  type DetectedAgent,
  type HostScan,
  type McpServer,
  type Pending,
  type SkillsScan,
  type OpenCodeScan,
  type HostCliPluginsScan,
  type CliPluginItem,
  type OpenCodeOverview,
  type OpenCodeOp,
  type OpenCodeModelItem,
  skillBackupSchema,
} from "./contract";
import { classifyLocal, classifyRole, fromDialect, sameServer } from "./normalize";
import { computeSkillRows, locationPath } from "./skills";
import { setLang, setDictionary, t, tp, plural, isLang, type Lang } from "./i18n";
import { EN } from "./i18n.en";

setDictionary(EN);
import {
  buildProviderRows,
  detectOpenCodeDrift,
  CANONICAL_OPENCODE_PROVIDERS,
  STALE_OPENCODE_PROVIDERS,
} from "./opencode";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/** Поддержка ~ в путях CLI-команды. */
function expandHome(value: string): string {
  return value.startsWith("~/") ? homedir() + value.slice(1) : value;
}
import { fetchGateway, type MetaMcpNamespace } from "./metamcp";

const CHANGED = "mcp-changed";
const SWEEP_CRON = "13 * * * *";

const hostViewSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.string(),
  hostname: z.string(),
  platform: z.string(),
  scannedAt: z.number().nullable(),
  error: z.string().nullable(),
  agents: z.array(
    detectedAgentSchema.extend({
      /** Whether BB itself can run threads on this CLI. */
      bridged: z.boolean(),
      /** Id провайдера BB для официальной иконки CLI, если такой провайдер есть. */
      providerId: z.string().nullable(),
      /** Whether the catalogue may write to this agent on this machine. */
      manageable: z.boolean(),
    }),
  ),
  otherClis: z.array(z.object({ bin: z.string(), path: z.string() })),
});
export type HostView = z.infer<typeof hostViewSchema>;

const driftSchema = z.object({
  hostId: z.string(),
  kind: z.string(),
  name: z.string(),
  state: z.enum(["missing", "different"]),
});
export type Drift = z.infer<typeof driftSchema>;

const metamcpSchema = z.object({
  namespace: z.string(),
  url: z.string(),
  error: z.string().nullable(),
  fetchedAt: z.number(),
  servers: z.array(z.object({ name: z.string(), tools: z.number() })),
});

const probeViewSchema = probeResultSchema.extend({ hostId: z.string() });
export type ProbeView = z.infer<typeof probeViewSchema>;

const overviewSchema = z.object({
  /** Последняя живая проверка: заполняется только по явной команде. */
  probes: z.array(probeViewSchema).max(400),
  hosts: z.array(hostViewSchema),
  catalog: z.array(catalogEntrySchema),
  pending: z.array(pendingSchema),
  ignored: z.array(z.string()),
  drift: z.array(driftSchema),
  metamcp: z.array(metamcpSchema),
  autoSync: z.boolean(),
  /** Язык интерфейса плагина: им же отвечает CLI. */
  lang: z.enum(["ru", "en"]),
  lastScanAt: z.number().nullable(),
  lastSyncAt: z.number().nullable(),
  skills: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      canonicalPath: z.string(),
      rows: z.array(
        z.object({
          name: z.string(),
          locationId: z.string(),
          state: z.string(),
          hash: z.string().nullable(),
          mtime: z.number().nullable(),
          canonicalMtime: z.number().nullable(),
        }),
      ),
    }),
  ),
  /** Сводка канона: строка на скилл, колонка на машину — видно паритет целиком. */
  skillCanon: z.array(
    z.object({
      name: z.string(),
      /** Скилл и так отдаёт плагин-маркетплейс хотя бы на одной машине. */
      fromPlugin: z.boolean(),
      hosts: z.array(
        z.object({
          hostId: z.string(),
          /** "same" — как у всех, "differs" — другое содержимое, "missing" — нет. */
          state: z.enum(["same", "differs", "missing"]),
          /** Где лежит копия помимо канона: дома CLI, куда раскатано. */
          homes: z.array(z.string()),
          mtime: z.number().nullable(),
        }),
      ),
    }),
  ),
  skillsPending: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      locationId: z.string(),
      name: z.string(),
    }),
  ),
  plugins: z.array(cliPluginItemSchema),
  opencode: openCodeOverviewSchema,
  badge: z.number(),
});
export type Overview = z.infer<typeof overviewSchema>;

const planSchema = z.object({
  operations: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      kind: z.string(),
      action: z.enum(["upsert", "remove"]),
      name: z.string(),
      reason: z.enum(["missing", "different", "manual"]),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: overviewSchema },
  rescan: { input: z.object({ hostId: z.string().nullable() }), output: overviewSchema },
  adopt: {
    input: z.object({
      names: z.array(z.string()).min(1).max(100),
      scope: z.enum(["global", "local-only"]).nullable(),
    }),
    output: overviewSchema,
  },
  ignore: { input: z.object({ names: z.array(z.string()).min(1).max(100) }), output: overviewSchema },
  unignore: { input: z.object({ names: z.array(z.string()).min(1).max(100) }), output: overviewSchema },
  catalog_update: {
    input: z.object({
      name: z.string(),
      scope: z.enum(["global", "local-only"]).nullable(),
      targets: z.array(z.string()).max(32).nullable(),
      spec: mcpServerSchema.nullable(),
    }),
    output: overviewSchema,
  },
  catalog_remove: { input: z.object({ name: z.string() }), output: overviewSchema },
  purge: {
    input: z.object({
      name: z.string(),
      hostId: z.string().nullable(),
      /** Also strip the server from gateway configs such as MetaMCP's own list. */
      includeGateways: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    }),
    output: z.object({
      removed: z.number(),
      failed: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  plan: { input: z.object({ hostId: z.string().nullable() }), output: planSchema },
  sync: {
    input: z.object({
      hostId: z.string().nullable(),
      dryRun: z.boolean(),
      includeDifferent: z.boolean(),
    }),
    output: z.object({
      applied: z.number(),
      failed: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  set_auto_sync: { input: z.object({ enabled: z.boolean() }), output: overviewSchema },
  probe: {
    input: z.object({ hostId: z.string().nullable(), name: z.string().nullable() }),
    output: z.object({
      checked: z.number(),
      failed: z.number(),
      overview: overviewSchema,
    }),
  },
  set_server_enabled: {
    input: z.object({
      name: z.string(),
      hostId: z.string().nullable(),
      enabled: z.boolean(),
    }),
    output: z.object({
      changed: z.number(),
      skipped: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  gateway_add: {
    input: z.object({
      hostId: z.string().min(1),
      /** JSON вида {"mcpServers": {...}} или просто карта имён → запись. */
      text: z.string().min(2).max(65_536),
    }),
    output: z.object({
      added: z.number(),
      replaced: z.array(z.string()).max(100),
      backups: z.array(z.string()).max(64),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  skill_adopt: {
    input: z.object({
      hostId: z.string().min(1),
      locationId: z.string().min(1),
      name: z.string().min(1).max(120),
      mode: z.enum(["adopt", "link", "take", "delete", "unlink"]),
    }),
    output: overviewSchema,
  },
  skill_adopt_bulk: {
    input: z.object({
      ops: z
        .array(
          z.object({
            hostId: z.string(),
            locationId: z.string(),
            name: z.string(),
            mode: z.enum(["adopt", "link", "take", "delete", "unlink"]),
          }),
        )
        .max(200),
    }),
    output: z.object({
      changed: z.number(),
      failed: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  /** Раскатка канона по домам CLI на машинах: ссылки, зеркало BB, архив. */
  /** Переключить язык интерфейса плагина и его CLI. */
  set_language: {
    input: z.object({ lang: z.enum(["ru", "en"]) }),
    output: overviewSchema,
  },
  skills_fanout: {
    input: z.object({ hostId: z.string().nullable(), dryRun: z.boolean().default(false) }),
    output: z.object({
      applied: z.number(),
      failed: z.number(),
      ops: z
        .array(
          z.object({
            hostId: z.string(),
            hostName: z.string(),
            kind: z.enum(["link", "mirror", "drop", "pull", "retire"]),
            locationId: z.string(),
            name: z.string(),
            reason: z.string(),
            ok: z.boolean(),
            error: z.string().nullable(),
          }),
        )
        .max(500),
      skippedByPlugin: z.array(z.string()).max(500),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  /** Архив снимков скиллов по машинам. */
  skills_backups: {
    input: z.object({ hostId: z.string().nullable() }),
    output: z.object({
      backups: z
        .array(skillBackupSchema.extend({ hostId: z.string(), hostName: z.string() }))
        .max(1000),
      errors: z.array(z.string()).max(100),
    }),
  },
  /** Вернуть снимок в канон на машине. */
  skills_backup_restore: {
    input: z.object({ hostId: z.string().min(1), id: z.string().min(1).max(300) }),
    output: z.object({
      ok: z.boolean(),
      message: z.string().max(600).nullable(),
      overview: overviewSchema,
    }),
  },
  skills_sync: {
    input: z.object({ hostId: z.string().nullable() }),
    output: z.object({
      synced: z.number(),
      failed: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  opencode_sync: {
    input: z.object({
      sourceHostId: z.string().nullable(),
      targetHostId: z.string().nullable(),
      syncProviders: z.boolean().default(true),
      syncModels: z.boolean().default(true),
      syncEnabled: z.boolean().default(true),
      dryRun: z.boolean().default(false),
    }),
    output: z.object({
      synced: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  opencode_clean: {
    input: z.object({
      hostId: z.string().nullable(),
      providerIds: z.array(z.string()).optional(),
      dryRun: z.boolean().default(false),
    }),
    output: z.object({
      removed: z.number(),
      errors: z.array(z.string()).max(100),
      overview: overviewSchema,
    }),
  },
  opencode_apply: {
    input: z.object({
      hostId: z.string(),
      ops: z.array(openCodeOpSchema).max(100),
      dryRun: z.boolean().default(false),
    }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      overview: overviewSchema,
    }),
  },
  opencode_set_default_model: {
    input: z.object({
      modelId: z.string(),
      smallModelId: z.string().optional(),
      setAsBbDefault: z.boolean().default(true),
      setAsOpenCodeDefault: z.boolean().default(true),
    }),
    output: z.object({
      ok: z.boolean(),
      updatedHosts: z.number(),
      bbUpdated: z.boolean(),
      overview: overviewSchema,
    }),
  },
});

interface Snapshot {
  hostId: string;
  hostName: string;
  scan: HostScan | null;
  error: string | null;
  at: number;
}

interface SkillsSnapshot {
  hostId: string;
  hostName: string;
  scan: SkillsScan;
  at: number;
}

interface OpenCodeSnapshot {
  hostId: string;
  hostName: string;
  scan: OpenCodeScan | null;
  at: number;
}

interface HostPluginsSnapshot {
  hostId: string;
  hostName: string;
  scan: HostCliPluginsScan | null;
  at: number;
}

export default async function plugin(bb: BbPluginApi) {
  // Язык интерфейса плагина. Храним в kv, а не в настройках: подписи самих
  // настроек объявляются раньше, чем их значения можно прочитать, поэтому
  // источник правды должен быть доступен до define.
  const storedLang = await bb.storage.kv.get<string>("lang");
  let currentLang: Lang = isLang(storedLang) ? storedLang : "ru";
  setLang(currentLang);

  const settings = bb.settings.define({
    metamcpUrl: {
      type: "string",
      label: t("MetaMCP: адрес"),
      description: t("Например https://metamcp.example.com — каталог покажет серверы за шлюзом."),
      default: "",
    },
    metamcpApiKey: {
      type: "string",
      label: t("MetaMCP: API-ключ"),
      description: t("Ключ вида sk_mt_… из раздела API Keys."),
      secret: true,
      default: "",
    },
    metamcpNamespaces: {
      type: "string",
      label: t("MetaMCP: namespace'ы"),
      description: t("Через запятую. По умолчанию secondary."),
      default: "secondary",
    },
    skillsFanOutPluginNames: {
      type: "boolean",
      label: t("Скиллы: раскатывать и то, что отдают плагины"),
      description:
        t("Включено — в домах CLI лежит весь канон, даже если имя уже приходит из плагина-маркетплейса: так навык виден и в CLI мимо BB. Цена — в сессиях BB такое имя показано дважды. Выключите, чтобы список навыков в BB был без двойников."),
      default: true,
    },
    skillsSyncRemote: {
      type: "string",
      label: t("Скиллы: git-remote канона"),
      description:
        t("Любой git-URL (свой GitHub/GitLab/сервер). Пусто — синк выключен. Плагин не привязан к конкретному хостингу."),
      secret: true,
      default: "",
    },
  });
  // Настройки читаем в момент использования, а не один раз при старте: иначе
  //новый ключ, вписанный в интерфейсе, начинал работать только после перезагрузки.
  const readConfig = () => settings.get();
  const host = bb.hosts.experimental_client({ contract: hostContract });

  // ---------------------------------------------------------------- storage
  const readCatalog = async (): Promise<CatalogEntry[]> =>
    (await bb.storage.kv.get<CatalogEntry[]>("catalog")) ?? [];
  const writeCatalog = (entries: CatalogEntry[]) => bb.storage.kv.set("catalog", entries);
  const readIgnored = async (): Promise<string[]> =>
    (await bb.storage.kv.get<string[]>("ignored")) ?? [];
  const readAutoSync = async (): Promise<boolean> =>
    (await bb.storage.kv.get<boolean>("autoSync")) ?? false;
  const readProbes = async (): Promise<ProbeView[]> =>
    (await bb.storage.kv.get<ProbeView[]>("probes")) ?? [];

  async function readSnapshots(): Promise<Snapshot[]> {
    const keys = await bb.storage.kv.list("snapshot:");
    const found: Snapshot[] = [];
    for (const key of keys) {
      const value = await bb.storage.kv.get<Snapshot>(key);
      if (value !== null && value !== undefined) found.push(value);
    }
    return found;
  }

  // ------------------------------------------------------------------ scan
  async function scanHost(hostId: string, hostName: string): Promise<Snapshot> {
    const snapshot: Snapshot = { hostId, hostName, scan: null, error: null, at: Date.now() };
    try {
      snapshot.scan = await host.call("scan", {}, { hostId });
    } catch (cause) {
      snapshot.error = cause instanceof Error ? cause.message : String(cause);
    }
    await bb.storage.kv.set(`snapshot:${hostId}`, snapshot);
    return snapshot;
  }

  async function scanAll(only: string | null): Promise<void> {
    const hosts = await bb.sdk.hosts.list();
    const targets = hosts.filter(
      (candidate) => (only === null || candidate.id === only) && candidate.status === "connected",
    );
    await Promise.all(targets.map((machine) => scanHost(machine.id, machine.name)));
    // Скиллы сканируются тем же обходом: это дешёвый readdir по нескольким папкам.
    await Promise.all(
      targets.map(async (machine) => {
        try {
          const scan = await host.call("skills_scan", {}, { hostId: machine.id });
          await bb.storage.kv.set(`skills:${machine.id}`, { hostId: machine.id, hostName: machine.name, scan, at: Date.now() });
        } catch (cause) {
          bb.log.info(`skills scan failed on ${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }),
    );
    // OpenCode: модели и провайдеры
    await Promise.all(
      targets.map(async (machine) => {
        try {
          const scan = await host.call("opencode_scan", {}, { hostId: machine.id });
          await bb.storage.kv.set(`opencode:${machine.id}`, { hostId: machine.id, hostName: machine.name, scan, at: Date.now() });
        } catch (cause) {
          bb.log.info(`opencode scan failed on ${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }),
    );
    // Плагины на хостах
    await Promise.all(
      targets.map(async (machine) => {
        try {
          const scan = await host.call("plugins_scan", {}, { hostId: machine.id });
          await bb.storage.kv.set(`plugins:${machine.id}`, { hostId: machine.id, hostName: machine.name, scan, at: Date.now() });
        } catch (cause) {
          bb.log.info(`plugins scan failed on ${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }),
    );
    await bb.storage.kv.set("lastScanAt", Date.now());
  }

  async function readSkillsSnapshots(): Promise<SkillsSnapshot[]> {
    const keys = await bb.storage.kv.list("skills:");
    const found: SkillsSnapshot[] = [];
    for (const key of keys) {
      const value = await bb.storage.kv.get<SkillsSnapshot>(key);
      if (value !== null && value !== undefined) found.push(value);
    }
    return found;
  }

  async function readOpenCodeSnapshots(): Promise<OpenCodeSnapshot[]> {
    const keys = await bb.storage.kv.list("opencode:");
    const found: OpenCodeSnapshot[] = [];
    for (const key of keys) {
      const value = await bb.storage.kv.get<OpenCodeSnapshot>(key);
      if (value !== null && value !== undefined) found.push(value);
    }
    return found;
  }

  async function readPluginsSnapshots(): Promise<HostPluginsSnapshot[]> {
    const keys = await bb.storage.kv.list("plugins:");
    const found: HostPluginsSnapshot[] = [];
    for (const key of keys) {
      const value = await bb.storage.kv.get<HostPluginsSnapshot>(key);
      if (value !== null && value !== undefined) found.push(value);
    }
    return found;
  }

  // ------------------------------------------------------------- metamcp
  // Cached in storage so the gateway stays on screen across plugin reloads.
  let metamcpCache: MetaMcpNamespace[] =
    (await bb.storage.kv.get<MetaMcpNamespace[]>("metamcp")) ?? [];
  async function refreshMetaMcp(): Promise<MetaMcpNamespace[]> {
    const current = await readConfig();
    const url = current.metamcpUrl.trim();
    const key = current.metamcpApiKey.trim();
    if (url === "" || key === "") {
      metamcpCache = [];
      await bb.storage.kv.set("metamcp", metamcpCache);
      return metamcpCache;
    }
    const namespaces = current.metamcpNamespaces
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    metamcpCache = await fetchGateway(url, namespaces.length > 0 ? namespaces : ["secondary"], key);
    await bb.storage.kv.set("metamcp", metamcpCache);
    return metamcpCache;
  }

  // ---------------------------------------------------------------- model
  /**
   * An agent the catalogue may manage: installed, writable, and either it
   * already has a config file or its config path is a confirmed one — the
   * plugin never creates a file at a guessed path.
   */
  function isManageable(agent: DetectedAgent): boolean {
    if (!agent.installed || agent.gateway || !agent.writable) return false;
    return agent.configExists || AGENT_BY_KIND.get(agent.kind)?.confirmedPath === true;
  }

  function managedAgents(scan: HostScan) {
    return scan.agents.filter(isManageable);
  }

  function wantsHere(entry: CatalogEntry, kind: string): boolean {
    if (entry.scope !== "global") return false;
    return entry.targets.length === 0 || entry.targets.includes(kind);
  }

  function computeDrift(snapshots: readonly Snapshot[], catalog: readonly CatalogEntry[]): Drift[] {
    const drift: Drift[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      for (const agent of managedAgents(snapshot.scan)) {
        for (const entry of catalog) {
          if (!wantsHere(entry, agent.kind)) continue;
          const present = agent.servers.find((server) => server.name === entry.name);
          if (present === undefined) {
            drift.push({ hostId: snapshot.hostId, kind: agent.kind, name: entry.name, state: "missing" });
          } else if (!sameServer(present, entry.spec)) {
            drift.push({ hostId: snapshot.hostId, kind: agent.kind, name: entry.name, state: "different" });
          }
        }
      }
    }
    return drift;
  }

  function computePending(
    snapshots: readonly Snapshot[],
    catalog: readonly CatalogEntry[],
    ignored: readonly string[],
  ): Pending[] {
    const known = new Set(catalog.map((entry) => entry.name));
    const skip = new Set(ignored);
    const seen = new Map<string, Pending>();
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      for (const agent of snapshot.scan.agents) {
        if (!agent.installed) continue;
        for (const server of agent.servers) {
          if (known.has(server.name) || skip.has(server.name)) continue;
          const occurrence = {
            hostId: snapshot.hostId,
            hostName: snapshot.hostName,
            kind: agent.kind,
            disabled: server.disabled === true,
            togglable: supportsDisable(agent.kind),
          };
          // Один сервер живёт на нескольких машинах — копим все места, а не первое.
          const existing = seen.get(server.name);
          if (existing !== undefined) {
            existing.occurrences.push(occurrence);
            continue;
          }
          const local = classifyLocal(server);
          seen.set(server.name, {
            name: server.name,
            spec: server,
            hostId: snapshot.hostId,
            hostName: snapshot.hostName,
            kind: agent.kind,
            occurrences: [occurrence],
            localOnly: local.localOnly,
            role: classifyRole(server),
            reason: local.reason,
            firstSeenAt: snapshot.at,
          });
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function getBbPreselectedModel(): string | null {
    try {
      const dbPath = path.join(homedir(), ".bb", "bb.db");
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare(
        "SELECT model FROM project_execution_defaults WHERE provider_id = 'acp-opencode' ORDER BY updated_at DESC LIMIT 1"
      ).get() as { model: string } | undefined;
      db.close();
      return row ? row.model : null;
    } catch {
      return null;
    }
  }

  function setBbPreselectedModel(modelId: string): boolean {
    try {
      const dbPath = path.join(homedir(), ".bb", "bb.db");
      const db = new Database(dbPath);
      const now = Date.now();
      const rows = db.prepare(
        "SELECT project_id FROM project_execution_defaults WHERE provider_id = 'acp-opencode'"
      ).all() as { project_id: string }[];

      if (rows.length > 0) {
        db.prepare(
          "UPDATE project_execution_defaults SET model = ?, updated_at = ? WHERE provider_id = 'acp-opencode'"
        ).run(modelId, now);
      } else {
        const pRow = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
        const projId = pRow?.id ?? "proj_ejbam66722";
        db.prepare(
          "INSERT INTO project_execution_defaults (project_id, provider_id, model, service_tier, reasoning_level, permission_mode, updated_at) VALUES (?, 'acp-opencode', ?, 'default', 'high', 'full', ?)"
        ).run(projId, modelId, now);
      }
      db.close();
      return true;
    } catch {
      return false;
    }
  }

  async function overview(): Promise<Overview> {
    const [snapshots, catalog, ignored, autoSync, hosts, providers] = await Promise.all([
      readSnapshots(),
      readCatalog(),
      readIgnored(),
      readAutoSync(),
      bb.sdk.hosts.list(),
      bb.sdk.providers.list().catch(() => []),
    ]);
    const providerIds = new Set(providers.map((provider) => provider.id));
    const byHost = new Map(snapshots.map((snapshot) => [snapshot.hostId, snapshot]));

    const views: HostView[] = hosts.map((machine) => {
      const snapshot = byHost.get(machine.id);
      const scan = snapshot?.scan ?? null;
      const agentDefs = new Map(AGENTS.map((agent) => [agent.kind, agent]));
      return {
        hostId: machine.id,
        name: machine.name,
        status: machine.status,
        hostname: scan?.hostname ?? "",
        platform: scan?.platform ?? "",
        scannedAt: scan?.scannedAt ?? null,
        error: snapshot?.error ?? null,
        agents: (scan?.agents ?? []).map((agent) => {
          const candidates = agentDefs.get(agent.kind)?.bbProviders ?? [];
          const providerId = candidates.find((id) => providerIds.has(id)) ?? null;
          return {
            ...agent,
            bridged: providerId !== null,
            providerId,
            manageable: isManageable(agent),
          };
        }),
        otherClis: scan?.otherClis ?? [],
      };
    });

    const drift = computeDrift(snapshots, catalog);
    const pending = computePending(snapshots, catalog, ignored);
    const skillsSnapshots = await readSkillsSnapshots();
    const skillsViews = skillsSnapshots.map((snapshot) => ({
      hostId: snapshot.hostId,
      hostName: snapshot.hostName,
      canonicalPath: snapshot.scan.canonicalPath,
      rows: computeSkillRows(snapshot.scan.canonicalPath, snapshot.scan.locations)
        .filter((row) => row.state !== "linked")
        // Старые снапшоты в kv не содержат mtime — undefined схемой отвергается.
        .map((row) => ({ ...row, mtime: row.mtime ?? null, canonicalMtime: row.canonicalMtime ?? null })),
    }));
    // Сводка канона по машинам: одна строка на имя, состояние в каждой машине.
    // Эталон содержимого — самый частый хеш: так одна разошедшаяся машина видна,
    // а не «все против всех».
    const canonNames = new Set<string>();
    const canonByHost = new Map<string, Map<string, { hash: string | null; mtime: number | null; homes: string[] }>>();
    const pluginNames = new Set<string>();
    for (const snapshot of skillsSnapshots) {
      const canon = snapshot.scan.locations.find((item) => item.id === "agents");
      const mine = new Map<string, { hash: string | null; mtime: number | null; homes: string[] }>();
      for (const entry of canon?.entries ?? []) {
        if (!entry.hasSkillMd) continue;
        const homes = snapshot.scan.locations
          .filter(
            (location) =>
              location.id !== "agents" &&
              location.entries.some((item) => item.name === entry.name && item.hasSkillMd),
          )
          .map((location) => location.id);
        mine.set(entry.name, { hash: entry.hash, mtime: entry.mtime, homes });
        canonNames.add(entry.name);
      }
      canonByHost.set(snapshot.hostId, mine);
      for (const name of snapshot.scan.pluginNames ?? []) pluginNames.add(name);
    }
    const skillCanon = [...canonNames].sort((a, b) => a.localeCompare(b)).map((name) => {
      const counts = new Map<string, number>();
      for (const mine of canonByHost.values()) {
        const hash = mine.get(name)?.hash;
        if (hash === undefined || hash === null) continue;
        counts.set(hash, (counts.get(hash) ?? 0) + 1);
      }
      const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        name,
        fromPlugin: pluginNames.has(name),
        hosts: skillsSnapshots.map((snapshot) => {
          const entry = canonByHost.get(snapshot.hostId)?.get(name);
          return {
            hostId: snapshot.hostId,
            state:
              entry === undefined
                ? ("missing" as const)
                : entry.hash === common || common === null
                  ? ("same" as const)
                  : ("differs" as const),
            homes: entry?.homes ?? [],
            mtime: entry?.mtime ?? null,
          };
        }),
      };
    });

    const skillsPending = skillsViews.flatMap((view) =>
      view.rows
        .filter((row) => row.state === "only-here")
        .map((row) => ({ hostId: view.hostId, hostName: view.hostName, locationId: row.locationId, name: row.name })),
    );

    // --------------------------------------------------------- cli plugins
    const pluginsSnapshots = await readPluginsSnapshots();
    const pluginsSnapByHost = new Map(pluginsSnapshots.map((s) => [s.hostId, s]));

    const pluginDefs = new Map<
      string,
      { id: string; name: string; agent: string; marketplace: string | null; version: string | null; scope: string | null }
    >();

    for (const snap of pluginsSnapshots) {
      if (!snap.scan) continue;
      for (const p of snap.scan.plugins) {
        const key = `${p.agent}:${p.id}`;
        if (!pluginDefs.has(key)) {
          pluginDefs.set(key, p);
        }
      }
    }

    const pluginViews: CliPluginItem[] = [];
    for (const [, def] of pluginDefs) {
      const hostPresence: CliPluginItem["hosts"] = {};
      for (const machine of hosts) {
        const snap = pluginsSnapByHost.get(machine.id);
        const match = snap?.scan?.plugins.find((p) => p.agent === def.agent && p.id === def.id);
        hostPresence[machine.id] = {
          hostName: machine.name,
          installed: Boolean(match),
          enabled: match?.enabled ?? false,
          version: match?.version ?? def.version ?? null,
          installPath: match?.installPath ?? null,
        };
      }

      const agentLabel =
        def.agent === "claude-code"
          ? "Claude Code"
          : def.agent === "opencode"
            ? "OpenCode"
            : def.agent === "codex"
              ? "Codex"
              : def.agent;

      pluginViews.push({
        id: def.id,
        name: def.name,
        agent: def.agent,
        agentLabel,
        marketplace: def.marketplace,
        version: def.version,
        scope: def.scope,
        hosts: hostPresence,
      });
    }

    const AGENT_ORDER: Record<string, number> = { "claude-code": 1, opencode: 2, codex: 3 };
    pluginViews.sort((a, b) => {
      const orderA = AGENT_ORDER[a.agent] ?? 99;
      const orderB = AGENT_ORDER[b.agent] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

    // ------------------------------------------------------------ opencode
    const openCodeSnapshots = await readOpenCodeSnapshots();
    const openCodeSnapByHost = new Map(openCodeSnapshots.map((s) => [s.hostId, s]));
    const openCodeHosts = hosts.map((machine) => {
      const snap = openCodeSnapByHost.get(machine.id);
      const scan = snap?.scan ?? null;
      return {
        hostId: machine.id,
        hostName: machine.name,
        installed: scan?.installed ?? false,
        binPath: scan?.binPath ?? null,
        configPath: scan?.configPath ?? null,
        configExists: scan?.configExists ?? false,
        writable: scan?.writable ?? false,
        model: scan?.model ?? null,
        smallModel: scan?.smallModel ?? null,
        enabledProviders: scan?.enabledProviders ?? [],
        plugins: scan?.plugins ?? [],
        warning: scan?.warning ?? null,
        scan,
      };
    });

    const canonicalHostId =
      hosts.find((h) => h.name.includes("Mini") || h.id === "host_7sea4qaad8")?.id ??
      hosts[0]?.id ??
      null;

    const providerRows = buildProviderRows(
      openCodeHosts.map((h) => ({ hostId: h.hostId, hostName: h.hostName, scan: h.scan })),
    );

    const openCodeDrift = detectOpenCodeDrift(
      openCodeHosts.map((h) => ({ hostId: h.hostId, hostName: h.hostName, scan: h.scan })),
      canonicalHostId,
    );

    const bbPreselected = getBbPreselectedModel();
    const canonModel = openCodeHosts.find((h) => h.model)?.model ?? null;
    const canonSmall = openCodeHosts.find((h) => h.smallModel)?.smallModel ?? null;

    const availableModels: OpenCodeModelItem[] = [];
    const modelsResult = await bb.sdk.providers.models({ providerId: "acp-opencode" }).catch(() => null);

    if (modelsResult && Array.isArray((modelsResult as { models?: Array<{ id: string; model?: string; displayName?: string }> }).models)) {
      const list = (modelsResult as { models: Array<{ id: string; model?: string; displayName?: string }> }).models;
      for (const m of list) {
        const fullId = m.model ?? m.id;
        const [pId, ...rest] = fullId.split("/");
        const pName =
          pId === "router9"
            ? "Antigravity (9router)"
            : pId === "zai-coding-plan"
              ? "Z.AI Coding Plan"
              : pId === "deepseek"
                ? "DeepSeek"
                : pId === "opencode"
                  ? "OpenCode Zen"
                  : pId;

        availableModels.push({
          id: fullId,
          name: m.displayName ?? rest.join("/"),
          providerId: pId,
          providerName: pName,
          isDefaultInOpenCode: fullId === canonModel,
          isSmallInOpenCode: fullId === canonSmall,
          isBbPreselected: fullId === bbPreselected,
        });
      }
    } else {
      for (const p of providerRows) {
        for (const h of Object.values(p.hosts)) {
          for (const m of h.models) {
            const fullId = m.includes("/") ? m : `${p.id}/${m}`;
            if (!availableModels.some((item) => item.id === fullId)) {
              availableModels.push({
                id: fullId,
                name: m.replace(/^ag\//, ""),
                providerId: p.id,
                providerName: p.name,
                isDefaultInOpenCode: fullId === canonModel,
                isSmallInOpenCode: fullId === canonSmall,
                isBbPreselected: fullId === bbPreselected,
              });
            }
          }
        }
      }
    }

    const openCodeOverview: OpenCodeOverview = {
      hosts: openCodeHosts.map(({ scan: _, ...h }) => h),
      providers: providerRows,
      availableModels,
      bbPreselectedModel: bbPreselected,
      drift: openCodeDrift,
      canonicalSourceHostId: canonicalHostId,
    };

    return {
      hosts: views,
      catalog,
      pending,
      ignored,
      drift,
      metamcp: metamcpCache,
      probes: await readProbes(),
      autoSync,
      lang: currentLang,
      lastScanAt: (await bb.storage.kv.get<number>("lastScanAt")) ?? null,
      lastSyncAt: (await bb.storage.kv.get<number>("lastSyncAt")) ?? null,
      skills: skillsViews,
      skillCanon,
      skillsPending,
      plugins: pluginViews,
      opencode: openCodeOverview,
      badge:
        pending.length +
        new Set(drift.map((item) => `${item.hostId}:${item.name}`)).size +
        skillsPending.length +
        openCodeDrift.length,
    };
  }

  async function publish(): Promise<Overview> {
    const current = await overview();
    bb.realtime.publish(CHANGED, { badge: current.badge });
    return current;
  }

  // ----------------------------------------------------------------- plan
  interface PlannedOp {
    hostId: string;
    hostName: string;
    kind: string;
    action: "upsert" | "remove";
    name: string;
    reason: "missing" | "different" | "manual";
    server: McpServer;
  }

  async function planOps(hostId: string | null, includeDifferent: boolean): Promise<PlannedOp[]> {
    const [snapshots, catalog] = await Promise.all([readSnapshots(), readCatalog()]);
    const ops: PlannedOp[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      if (hostId !== null && snapshot.hostId !== hostId) continue;
      for (const agent of managedAgents(snapshot.scan)) {
        for (const entry of catalog) {
          if (!wantsHere(entry, agent.kind)) continue;
          const present = agent.servers.find((server) => server.name === entry.name);
          if (present === undefined) {
            ops.push({
              hostId: snapshot.hostId,
              hostName: snapshot.hostName,
              kind: agent.kind,
              action: "upsert",
              name: entry.name,
              reason: "missing",
              server: entry.spec,
            });
          } else if (includeDifferent && !sameServer(present, entry.spec)) {
            ops.push({
              hostId: snapshot.hostId,
              hostName: snapshot.hostName,
              kind: agent.kind,
              action: "upsert",
              name: entry.name,
              reason: "different",
              server: entry.spec,
            });
          }
        }
      }
    }
    return ops;
  }

  /** Метки операций раскатки — одни и те же в CLI и в интерфейсе. */
  const SKILL_FANOUT_LABEL: Record<string, string> = {
    link: t("ссылок"),
    mirror: t("зеркал BB"),
    drop: t("убрано"),
    pull: t("забрано в канон"),
    retire: t("уведено в архив"),
  };

  /**
   * Раскатка канона по домам CLI на выбранных машинах. Имена, которые уже
   * отдают плагины-маркетплейсы, машина считает сама и в дома не дублирует.
   */
  async function runSkillsFanOut(hostId: string | null, dryRun: boolean, includePluginNames?: boolean) {
    const hostsList = await bb.sdk.hosts.list();
    const targets = hostsList.filter(
      (candidate) => (hostId === null || candidate.id === hostId) && candidate.status === "connected",
    );
    const ops: {
      hostId: string;
      hostName: string;
      kind: "link" | "mirror" | "drop" | "pull" | "retire";
      locationId: string;
      name: string;
      reason: string;
      ok: boolean;
      error: string | null;
    }[] = [];
    const skipped = new Set<string>();
    const errors: string[] = [];
    let applied = 0;
    let failed = 0;
    for (const machine of targets) {
      try {
        // Пустой список = машина считает плагинные имена сама. Спецзначение
        // "*" означает «исключений нет»: раскатываем канон целиком.
        const result = await host.call(
          "skills_fanout",
          { pluginNames: (includePluginNames ?? (await readConfig()).skillsFanOutPluginNames) ? ["*"] : [], dryRun },
          { hostId: machine.id },
        );
        for (const op of result.ops) {
          ops.push({ hostId: machine.id, hostName: machine.name, ...op });
          if (op.ok) applied += 1;
          else {
            failed += 1;
            errors.push(`${machine.name} · ${op.name}: ${op.error ?? t("ошибка")}`);
          }
        }
        for (const name of result.skippedByPlugin) skipped.add(name);
      } catch (cause) {
        failed += 1;
        errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (!dryRun) await scanAll(hostId);
    return {
      applied,
      failed,
      ops: ops.slice(0, 500),
      skippedByPlugin: [...skipped].sort().slice(0, 500),
      errors: errors.slice(0, 100),
    };
  }

  /** Архив снимков по машинам, новые сверху. */
  async function runSkillsBackups(hostId: string | null) {
    const hostsList = await bb.sdk.hosts.list();
    const targets = hostsList.filter(
      (candidate) => (hostId === null || candidate.id === hostId) && candidate.status === "connected",
    );
    const collected: {
      hostId: string;
      hostName: string;
      id: string;
      name: string;
      at: string;
      reason: string;
      locationId: string;
      hash: string | null;
      files: number;
      bytes: number;
      unique: boolean;
    }[] = [];
    const errors: string[] = [];
    for (const machine of targets) {
      try {
        const result = await host.call("skills_backups_list", {}, { hostId: machine.id });
        for (const item of result.backups) {
          collected.push({ hostId: machine.id, hostName: machine.name, ...item });
        }
      } catch (cause) {
        errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    collected.sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
    return { backups: collected.slice(0, 1000), errors: errors.slice(0, 100) };
  }

  async function runSync(
    hostId: string | null,
    dryRun: boolean,
    includeDifferent: boolean,
  ): Promise<{ applied: number; failed: number; errors: string[] }> {
    const ops = await planOps(hostId, includeDifferent);
    const grouped = new Map<string, PlannedOp[]>();
    for (const op of ops) {
      const list = grouped.get(op.hostId) ?? [];
      list.push(op);
      grouped.set(op.hostId, list);
    }
    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const [targetHost, hostOps] of grouped) {
      const payload: ApplyOp[] = hostOps.map((op) => ({
        kind: op.kind,
        action: op.action,
        server: op.server,
      }));
      try {
        const result = await host.call(
          "apply",
          { ops: payload, dryRun },
          { hostId: targetHost },
        );
        for (const item of result.results) {
          if (item.ok) applied += 1;
          else {
            failed += 1;
            errors.push(`${hostOps[0]?.hostName ?? targetHost} / ${item.kind} / ${item.name}: ${item.error ?? t("ошибка")}`);
          }
        }
      } catch (cause) {
        failed += payload.length;
        errors.push(
          `${hostOps[0]?.hostName ?? targetHost}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (!dryRun && applied > 0) {
      await bb.storage.kv.set("lastSyncAt", Date.now());
      await scanAll(hostId);
    }
    return { applied, failed, errors: errors.slice(0, 100) };
  }

  /** Manual-only: take one server off every managed agent it is present on. */
  async function runPurge(
    name: string,
    hostId: string | null,
    includeGateways: boolean,
    dryRun: boolean,
  ): Promise<{ removed: number; failed: number; errors: string[] }> {
    const snapshots = await readSnapshots();
    let removed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      if (hostId !== null && snapshot.hostId !== hostId) continue;
      const ops: ApplyOp[] = [];
      const targets = includeGateways
        ? snapshot.scan.agents.filter(
            (agent) => isManageable(agent) || (agent.gateway && agent.configExists && agent.writable),
          )
        : managedAgents(snapshot.scan);
      for (const agent of targets) {
        const found = agent.servers.find((server) => server.name === name);
        if (found !== undefined) ops.push({ kind: agent.kind, action: "remove", server: found });
      }
      if (ops.length === 0) continue;
      try {
        const result = await host.call("apply", { ops, dryRun }, { hostId: snapshot.hostId });
        for (const item of result.results) {
          if (item.ok) removed += 1;
          else {
            failed += 1;
            errors.push(`${snapshot.hostName} / ${item.kind} / ${item.name}: ${item.error ?? t("ошибка")}`);
          }
        }
      } catch (cause) {
        failed += ops.length;
        errors.push(`${snapshot.hostName}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (removed > 0 && !dryRun) await scanAll(hostId);
    return { removed, failed, errors: errors.slice(0, 100) };
  }

  /**
   * Включает или выключает сервер там, где формат конфига это понимает
   * (Codex, OpenCode, Grok). Остальные конфиги считаются пропущенными: у
   * Claude Code, например, флага выключения нет — там сервер только удаляют.
   */
  async function runSetEnabled(
    name: string,
    hostId: string | null,
    enabled: boolean,
  ): Promise<{ changed: number; skipped: number; errors: string[] }> {
    const snapshots = await readSnapshots();
    let changed = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      if (hostId !== null && snapshot.hostId !== hostId) continue;
      const ops: ApplyOp[] = [];
      for (const agent of snapshot.scan.agents) {
        if (!agent.installed) continue;
        const found = agent.servers.find((server) => server.name === name);
        if (found === undefined) continue;
        if (!agent.writable || !supportsDisable(agent.kind)) {
          skipped += 1;
          continue;
        }
        if ((found.disabled === true) === !enabled) continue;
        ops.push({
          kind: agent.kind,
          action: "upsert",
          server: { ...found, disabled: enabled ? undefined : true },
        });
      }
      if (ops.length === 0) continue;
      try {
        const result = await host.call("apply", { ops, dryRun: false }, { hostId: snapshot.hostId });
        for (const item of result.results) {
          if (item.ok) changed += 1;
          else {
            errors.push(`${snapshot.hostName} / ${item.kind} / ${item.name}: ${item.error ?? t("ошибка")}`);
          }
        }
      } catch (cause) {
        errors.push(`${snapshot.hostName}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (changed > 0) await scanAll(hostId);
    return { changed, skipped, errors: errors.slice(0, 100) };
  }

  /**
   * Разбирает вставленный пользователем JSON с серверами для шлюза. Понимает
   * и обёртку {"mcpServers": {...}}, и голую карту имя → запись.
   */
  function parseGatewayServers(
    text: string,
  ): { servers: McpServer[]; errors: string[] } {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        tp("JSON не разобран: {0}", cause instanceof Error ? cause.message : String(cause)),
      );
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error(t("Ожидается JSON-объект с картой серверов"));
    }
    const doc = document as Record<string, unknown>;
    const inner = doc.mcpServers;
    const bucket =
      inner !== null && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : doc;
    if (Object.keys(bucket).length === 0) {
      throw new Error(t("В тексте нет ни одного сервера"));
    }
    const servers: McpServer[] = [];
    const errors: string[] = [];
    for (const [name, raw] of Object.entries(bucket)) {
      const server = fromDialect("metamcp", name, raw);
      if (server === null) {
        errors.push(tp("{0}: в записи нет ни command, ни url", name));
        continue;
      }
      servers.push(server);
    }
    return { servers, errors };
  }

  /**
   * Добавляет серверы за шлюз MetaMCP на одной машине: дописывает детей в
   * ~/.agents/metamcp.mcp.json (бэкап + атомарная запись на стороне хоста —
   * это обычный apply к агенту metamcp-stdio). Конфиг шлюза только
   * редактируется: несуществующий файл плагин не создаёт.
   */
  async function runGatewayAdd(
    hostId: string,
    text: string,
  ): Promise<{ added: number; replaced: string[]; backups: string[]; errors: string[] }> {
    const snapshots = await readSnapshots();
    const snapshot = snapshots.find((item) => item.hostId === hostId);
    if (snapshot === undefined || snapshot.scan === null) {
      throw new Error(t("Машина не на связи или ещё не сканировалась"));
    }
    const gateway = snapshot.scan.agents.find((agent) => agent.kind === "metamcp-stdio");
    if (gateway === undefined || !gateway.configExists) {
      throw new Error(
        tp("На «{0}» нет конфига шлюза ~/.agents/metamcp.mcp.json — плагин не создаёт конфиги с неподтверждённым путём", snapshot.hostName),
      );
    }
    if (!gateway.writable) {
      throw new Error(gateway.warning ?? t("Конфиг шлюза недоступен для записи"));
    }
    const { servers, errors } = parseGatewayServers(text);
    if (servers.length === 0) {
      throw new Error(errors.join("\n") || t("Не найдено ни одного сервера"));
    }
    const replaced = servers
      .filter((server) => gateway.servers.some((item) => item.name === server.name))
      .map((server) => server.name);
    const ops: ApplyOp[] = servers.map((server) => ({
      kind: "metamcp-stdio",
      action: "upsert",
      server,
    }));
    const result = await host.call("apply", { ops, dryRun: false }, { hostId });
    const failed = result.results.filter((item) => !item.ok);
    if (failed.length === 0) await scanAll(hostId);
    return {
      added: result.results.length - failed.length,
      replaced,
      backups: result.backups,
      errors: [
        ...errors,
        ...failed.map((item) => `${item.name}: ${item.error ?? t("ошибка")}`),
      ].slice(0, 100),
    };
  }

  const PROBE_TIMEOUT_MS = 15_000;

  /**
   * Живая проверка: на каждой машине выполняется настоящий MCP-handshake.
   * Запускается только по команде пользователя — для stdio это запуск процесса.
   */
  async function runProbe(
    hostId: string | null,
    name: string | null,
  ): Promise<{ checked: number; failed: number }> {
    const snapshots = await readSnapshots();
    const previous = await readProbes();
    const fresh: ProbeView[] = [];
    let checked = 0;
    let failed = 0;
    for (const snapshot of snapshots) {
      if (snapshot.scan === null) continue;
      if (hostId !== null && snapshot.hostId !== hostId) continue;
      const targets: { kind: string; name: string }[] = [];
      for (const agent of snapshot.scan.agents) {
        if (!agent.installed) continue;
        for (const server of agent.servers) {
          if (name !== null && server.name !== name) continue;
          targets.push({ kind: agent.kind, name: server.name });
        }
      }
      if (targets.length === 0) continue;
      try {
        const result = await host.call(
          "probe",
          { targets: targets.slice(0, 60), timeoutMs: PROBE_TIMEOUT_MS },
          { hostId: snapshot.hostId },
        );
        for (const item of result.results) {
          fresh.push({ ...item, hostId: snapshot.hostId });
          checked += 1;
          if (!item.ok) failed += 1;
        }
      } catch (cause) {
        bb.log.info(
          `probe failed on ${snapshot.hostName}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    // Старые результаты по непроверенным серверам сохраняем, свежие — заменяют.
    const replaced = new Set(fresh.map((item) => `${item.hostId}:${item.kind}:${item.name}`));
    const merged = [
      ...previous.filter((item) => !replaced.has(`${item.hostId}:${item.kind}:${item.name}`)),
      ...fresh,
    ];
    await bb.storage.kv.set("probes", merged.slice(-400));
    return { checked, failed };
  }

  // -------------------------------------------------------------- catalog
  async function adopt(names: readonly string[], scope: "global" | "local-only" | null) {
    const [catalog, snapshots] = await Promise.all([readCatalog(), readSnapshots()]);
    const pending = computePending(snapshots, catalog, await readIgnored());
    const byName = new Map(pending.map((entry) => [entry.name, entry]));
    const next = [...catalog];
    for (const name of names) {
      const candidate = byName.get(name);
      if (candidate === undefined) continue;
      next.push({
        name: candidate.name,
        spec: candidate.spec,
        scope: scope ?? (candidate.localOnly ? "local-only" : "global"),
        targets: [],
        origin: { hostId: candidate.hostId, kind: candidate.kind },
        updatedAt: Date.now(),
      });
    }
    await writeCatalog(next);
  }

  // ------------------------------------------------------------- opencode
  async function runOpenCodeSync(args: {
    sourceHostId: string | null;
    targetHostId: string | null;
    syncProviders: boolean;
    syncModels: boolean;
    syncEnabled: boolean;
    dryRun: boolean;
  }): Promise<{ synced: number; errors: string[] }> {
    const openCodeSnapshots = await readOpenCodeSnapshots();
    const hostsList = await bb.sdk.hosts.list();

    const srcId =
      args.sourceHostId ??
      hostsList.find((h) => h.name.includes("Mini") || h.id === "host_7sea4qaad8")?.id ??
      hostsList[0]?.id;

    const sourceSnap = openCodeSnapshots.find((s) => s.hostId === srcId);
    if (!sourceSnap || !sourceSnap.scan || !sourceSnap.scan.configExists) {
      throw new Error(t("Конфиг OpenCode на исходной машине не найден"));
    }

    const targets = hostsList.filter(
      (candidate) =>
        (args.targetHostId === null || candidate.id === args.targetHostId) &&
        candidate.id !== srcId &&
        candidate.status === "connected",
    );

    let synced = 0;
    const errors: string[] = [];

    for (const machine of targets) {
      const ops: OpenCodeOp[] = [];

      if (args.syncProviders) {
        for (const [pId, pCfg] of Object.entries(sourceSnap.scan.providers)) {
          if (pCfg.raw) {
            ops.push({
              action: "upsert_provider",
              providerId: pId,
              config: pCfg.raw,
              enable: sourceSnap.scan.enabledProviders.includes(pId),
            });
          }
        }
      }

      if (args.syncModels) {
        ops.push({
          action: "set_models",
          model: sourceSnap.scan.model ?? undefined,
          smallModel: sourceSnap.scan.smallModel ?? undefined,
        });
      }

      if (args.syncEnabled) {
        ops.push({
          action: "set_enabled",
          enabledProviders: sourceSnap.scan.enabledProviders,
        });
      }

      if (ops.length === 0) continue;

      try {
        const res = await host.call("opencode_apply", { ops, dryRun: args.dryRun }, { hostId: machine.id });
        if (res.ok) {
          synced += 1;
          if (res.scan) {
            await bb.storage.kv.set(`opencode:${machine.id}`, {
              hostId: machine.id,
              hostName: machine.name,
              scan: res.scan,
              at: Date.now(),
            });
          }
        } else {
          errors.push(`${machine.name}: ${res.error ?? t("ошибка")}`);
        }
      } catch (cause) {
        errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    return { synced, errors: errors.slice(0, 100) };
  }

  async function runOpenCodeClean(args: {
    hostId: string | null;
    providerIds?: string[];
    dryRun: boolean;
  }): Promise<{ removed: number; errors: string[] }> {
    const openCodeSnapshots = await readOpenCodeSnapshots();
    const hostsList = await bb.sdk.hosts.list();

    const targets = hostsList.filter(
      (candidate) => (args.hostId === null || candidate.id === args.hostId) && candidate.status === "connected",
    );

    let removed = 0;
    const errors: string[] = [];

    for (const machine of targets) {
      const snap = openCodeSnapshots.find((s) => s.hostId === machine.id);
      if (!snap || !snap.scan || !snap.scan.configExists) continue;

      const toRemove =
        args.providerIds && args.providerIds.length > 0
          ? args.providerIds
          : Object.keys(snap.scan.providers).filter((id) => STALE_OPENCODE_PROVIDERS.has(id));

      if (toRemove.length === 0) continue;

      const ops: OpenCodeOp[] = toRemove.map((pId) => ({
        action: "remove_provider",
        providerId: pId,
      }));

      try {
        const res = await host.call("opencode_apply", { ops, dryRun: args.dryRun }, { hostId: machine.id });
        if (res.ok) {
          removed += toRemove.length;
          if (res.scan) {
            await bb.storage.kv.set(`opencode:${machine.id}`, {
              hostId: machine.id,
              hostName: machine.name,
              scan: res.scan,
              at: Date.now(),
            });
          }
        } else {
          errors.push(`${machine.name}: ${res.error ?? t("ошибка")}`);
        }
      } catch (cause) {
        errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    return { removed, errors: errors.slice(0, 100) };
  }

  // ------------------------------------------------------------------ rpc
  bb.rpc.register(rpcContract, {
    overview: () => overview(),
    rescan: async ({ hostId }) => {
      await Promise.all([scanAll(hostId), refreshMetaMcp()]);
      return publish();
    },
    adopt: async ({ names, scope }) => {
      await adopt(names, scope);
      return publish();
    },
    ignore: async ({ names }) => {
      const ignored = new Set(await readIgnored());
      for (const name of names) ignored.add(name);
      await bb.storage.kv.set("ignored", [...ignored]);
      return publish();
    },
    unignore: async ({ names }) => {
      const ignored = new Set(await readIgnored());
      for (const name of names) ignored.delete(name);
      await bb.storage.kv.set("ignored", [...ignored]);
      return publish();
    },
    catalog_update: async ({ name, scope, targets, spec }) => {
      const catalog = await readCatalog();
      const entry = catalog.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(tp("Нет записи каталога: {0}", name));
      if (scope !== null) entry.scope = scope;
      if (targets !== null) entry.targets = targets;
      if (spec !== null) entry.spec = spec;
      entry.updatedAt = Date.now();
      await writeCatalog(catalog);
      return publish();
    },
    catalog_remove: async ({ name }) => {
      const catalog = await readCatalog();
      await writeCatalog(catalog.filter((entry) => entry.name !== name));
      return publish();
    },
    purge: async ({ name, hostId, includeGateways, dryRun }) => {
      const result = await runPurge(name, hostId, includeGateways, dryRun);
      if (dryRun) return { ...result, overview: await overview() };
      const catalog = await readCatalog();
      await writeCatalog(catalog.filter((entry) => entry.name !== name));
      const ignored = new Set(await readIgnored());
      ignored.add(name);
      await bb.storage.kv.set("ignored", [...ignored]);
      return { ...result, overview: await publish() };
    },
    plan: async ({ hostId }) => ({
      operations: (await planOps(hostId, true)).map(({ server: _server, ...rest }) => rest),
    }),
    sync: async ({ hostId, dryRun, includeDifferent }) => {
      const result = await runSync(hostId, dryRun, includeDifferent);
      return { ...result, overview: await publish() };
    },
    probe: async ({ hostId, name }) => {
      const result = await runProbe(hostId, name);
      return { ...result, overview: await publish() };
    },
    set_server_enabled: async ({ name, hostId, enabled }) => {
      const result = await runSetEnabled(name, hostId, enabled);
      return { ...result, overview: await publish() };
    },
    gateway_add: async ({ hostId, text }) => {
      const result = await runGatewayAdd(hostId, text);
      return { ...result, overview: await publish() };
    },
    skill_adopt: async ({ hostId, locationId, name, mode }) => {
      // Отказ машины (нельзя удалять без симлинка, скилла нет на месте и т.п.)
      // раньше терялся молча — строка просто не менялась. Теперь это ошибка.
      const result = await host.call("skills_adopt", { locationId, name, mode }, { hostId });
      if (!result.ok) throw new Error(tp("Скилл {0}: {1}", name, t(result.error ?? "не удалось")));
      await scanAll(hostId);
      return publish();
    },
    skill_adopt_bulk: async ({ ops }) => {
      const byHost = new Map<string, typeof ops>();
      for (const op of ops) {
        const list = byHost.get(op.hostId) ?? [];
        list.push(op);
        byHost.set(op.hostId, list);
      }
      let changed = 0;
      let failed = 0;
      const errors: string[] = [];
      for (const [hostId, hostOps] of byHost) {
        try {
          const result = await host.call(
            "skills_adopt_bulk",
            { ops: hostOps.map(({ locationId, name, mode }) => ({ locationId, name, mode })) },
            { hostId },
          );
          for (const item of result.results) {
            if (item.ok) changed += 1;
            else {
              failed += 1;
              errors.push(`${item.name}: ${item.error ?? t("ошибка")}`);
            }
          }
        } catch (cause) {
          failed += hostOps.length;
          errors.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
      await scanAll(null);
      return { changed, failed, errors: errors.slice(0, 100), overview: await publish() };
    },
    set_language: async ({ lang: next }) => {
      currentLang = next;
      setLang(next);
      await bb.storage.kv.set("lang", next);
      return publish();
    },
    skills_fanout: async ({ hostId, dryRun }) => ({
      ...(await runSkillsFanOut(hostId, dryRun)),
      overview: await publish(),
    }),
    skills_backups: async ({ hostId }) => runSkillsBackups(hostId),
    skills_backup_restore: async ({ hostId, id }) => {
      const result = await host.call("skills_backup_restore", { id }, { hostId });
      if (!result.ok) throw new Error(result.error ?? t("не удалось восстановить снимок"));
      await scanAll(hostId);
      return { ok: true, message: result.message, overview: await publish() };
    },
    skills_sync: async ({ hostId }) => {
      const remote = (await readConfig()).skillsSyncRemote.trim();
      if (remote === "") throw new Error(t("Синк скиллов выключен: не задан git-remote в настройках плагина"));
      const hostsList = await bb.sdk.hosts.list();
      const targets = hostsList.filter(
        (candidate) => (hostId === null || candidate.id === hostId) && candidate.status === "connected",
      );
      let synced = 0;
      let failed = 0;
      const errors: string[] = [];
      for (const machine of targets) {
        try {
          await host.call("skills_sync", { remote }, { hostId: machine.id });
          synced += 1;
        } catch (cause) {
          failed += 1;
          errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      await scanAll(hostId);
      return { synced, failed, errors: errors.slice(0, 100), overview: await publish() };
    },
    opencode_sync: async ({ sourceHostId, targetHostId, syncProviders, syncModels, syncEnabled, dryRun }) => {
      const result = await runOpenCodeSync({ sourceHostId, targetHostId, syncProviders, syncModels, syncEnabled, dryRun });
      return { ...result, overview: await publish() };
    },
    opencode_clean: async ({ hostId, providerIds, dryRun }) => {
      const result = await runOpenCodeClean({ hostId, providerIds, dryRun });
      return { ...result, overview: await publish() };
    },
    opencode_apply: async ({ hostId, ops, dryRun }) => {
      const hostsList = await bb.sdk.hosts.list();
      const target = hostsList.find((h) => h.id === hostId);
      if (!target) throw new Error(t("Машина не найдена"));

      try {
        const res = await host.call("opencode_apply", { ops, dryRun }, { hostId });
        if (res.ok && res.scan) {
          await bb.storage.kv.set(`opencode:${hostId}`, {
            hostId,
            hostName: target.name,
            scan: res.scan,
            at: Date.now(),
          });
        }
        return { ok: res.ok, error: res.error, overview: await publish() };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          overview: await publish(),
        };
      }
    },
    opencode_set_default_model: async ({ modelId, smallModelId, setAsBbDefault, setAsOpenCodeDefault }) => {
      let updatedHosts = 0;
      let bbUpdated = false;

      if (setAsOpenCodeDefault) {
        const hostsList = await bb.sdk.hosts.list();
        const targets = hostsList.filter((c) => c.status === "connected");
        for (const machine of targets) {
          try {
            const ops: OpenCodeOp[] = [{ action: "set_models", model: modelId, smallModel: smallModelId }];
            const res = await host.call("opencode_apply", { ops, dryRun: false }, { hostId: machine.id });
            if (res.ok) {
              updatedHosts += 1;
              if (res.scan) {
                await bb.storage.kv.set(`opencode:${machine.id}`, {
                  hostId: machine.id,
                  hostName: machine.name,
                  scan: res.scan,
                  at: Date.now(),
                });
              }
            }
          } catch (cause) {
            bb.log.info(`failed to set opencode default model on ${machine.name}: ${cause}`);
          }
        }
      }

      if (setAsBbDefault) {
        bbUpdated = setBbPreselectedModel(modelId);
      }

      return {
        ok: true,
        updatedHosts,
        bbUpdated,
        overview: await publish(),
      };
    },
    set_auto_sync: async ({ enabled }) => {
      await bb.storage.kv.set("autoSync", enabled);
      return publish();
    },
  });

  // ------------------------------------------------------------- schedule
  bb.background.schedule("sweep", SWEEP_CRON, async () => {
    await Promise.all([scanAll(null), refreshMetaMcp()]);
    if (await readAutoSync()) {
      const result = await runSync(null, false, false);
      bb.log.info(`auto sync: applied ${result.applied}, failed ${result.failed}`);
    }
    const skillsRemote = (await readConfig()).skillsSyncRemote.trim();
    if (skillsRemote !== "") {
      for (const machine of await bb.sdk.hosts.list()) {
        if (machine.status !== "connected") continue;
        await host
          .call("skills_sync", { remote: skillsRemote }, { hostId: machine.id })
          .catch((cause: unknown) =>
            bb.log.info(
              `skills sync failed on ${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
      }
    }
    // Синк выравнивает каноны между машинами, раскатка — дома CLI внутри каждой.
    // Без неё новый скилл лежал бы в каноне, но не попадал ни в одну сессию.
    const fanOut = await runSkillsFanOut(null, false);
    if (fanOut.ops.length > 0) {
      bb.log.info(`skills fan-out: applied ${fanOut.applied}, failed ${fanOut.failed}`);
    }
    await publish();
  });

  // ------------------------------------------------------------------ cli
  const usage = [
    "Usage:",
    t("  bb tools status [--json]        Каталог, машины, расхождения"),
    t("  bb tools scan [--host <id>]     Пересканировать машины"),
    t("  bb tools catalog [--json]       Записи каталога"),
    t("  bb tools pending [--json]       Новые серверы, ещё не принятые"),
    t("  bb tools adopt <name...>        Принять серверы в каталог"),
    t("  bb tools ignore <name...>       Больше не предлагать"),
    t("  bb tools unignore <name...>     Вернуть скрытый сервер"),
    t("  bb tools plan [--host <id>]     Что изменит синхронизация"),
    "  bb tools sync [--host <id>] [--dry-run] [--with-different]",
    t("  bb tools forget <name>          Убрать запись из каталога"),
    t("  bb tools remove <name> [--with-gateways]   Удалить сервер со всех машин"),
    t("  bb tools probe [<name>]         Живая проверка связи"),
    t("  bb tools enable|disable <name>  Включить или выключить сервер"),
    t("  bb tools auto on|off            Автосинхронизация раз в час"),
    t("  bb tools gateway-add <файл> --host <id>  Добавить серверы за шлюз"),
    t("  bb tools lang [ru|en]           Язык интерфейса и вывода"),
    t("  bb tools skills [--host <id>]            Скиллы вне канона"),
    t("  bb tools skills-adopt <папка> <имя> --host <id> [--link|--delete|--take|--unlink]  Скилл за канон"),
  ].join("\n");

  function renderStatus(current: Overview): string {
    const lines: string[] = [];
    lines.push(tp("Каталог: {0}, автосинхронизация {1}", plural(current.catalog.length, ["сервер", "сервера", "серверов"]), current.autoSync ? t("включена") : t("выключена")));
    for (const machine of current.hosts) {
      const installed = machine.agents.filter((agent) => agent.installed);
      const missing = current.drift.filter((item) => item.hostId === machine.hostId && item.state === "missing").length;
      const different = current.drift.filter((item) => item.hostId === machine.hostId && item.state === "different").length;
      lines.push(
        `\n${machine.name} [${machine.status}] ${machine.hostname}` +
          (machine.error === null ? "" : `\n  ${tp("ошибка: {0}", machine.error)}`),
      );
      for (const agent of installed) {
        lines.push(
          `  ${agent.label}: ${plural(agent.servers.length, ["сервер", "сервера", "серверов"])}${agent.bridged ? "" : `  (${t("нет провайдера BB")})`}${agent.writable ? "" : `  (${t("только чтение")})`}`,
        );
      }
      if (machine.otherClis.length > 0) {
        lines.push(`  ${tp("другие CLI: {0}", machine.otherClis.map((cli) => cli.bin).join(", "))}`);
      }
      lines.push(`  ${tp("расхождения: не хватает {0}, отличается {1}", missing, different)}`);
    }
    if (current.pending.length > 0) {
      lines.push(`\n${tp("Новые серверы ({0}):", current.pending.length)}`);
      for (const item of current.pending) {
        lines.push(
          `  ${item.name}  ← ${item.hostName}/${item.kind}${item.localOnly ? `  [${tp("локальный: {0}", item.reason)}]` : ""}`,
        );
      }
    }
    for (const namespace of current.metamcp) {
      lines.push(
        `\nMetaMCP /${namespace.namespace}: ` +
          (namespace.error === null
            ? namespace.servers.map((server) => `${server.name}(${server.tools})`).join(", ")
            : tp("ошибка {0}", namespace.error)),
      );
    }
    return lines.join("\n");
  }

  bb.cli.register({
    name: "tools",
    summary: t("Инструменты агентов: MCP-серверы и навыки на всех машинах BB"),
    commands: [
      { name: "status", summary: t("Каталог, машины и расхождения"), usage: "bb tools status [--json]" },
      { name: "scan", summary: t("Пересканировать машины"), usage: "bb tools scan [--host <id>]" },
      { name: "catalog", summary: t("Записи каталога"), usage: "bb tools catalog [--json]" },
      { name: "pending", summary: t("Новые серверы"), usage: "bb tools pending [--json]" },
      { name: "adopt", summary: t("Принять серверы в каталог"), usage: "bb tools adopt <name...>" },
      { name: "ignore", summary: t("Больше не предлагать сервер"), usage: "bb tools ignore <name...>" },
      {
        name: "unignore",
        summary: t("Вернуть скрытый сервер в предложения"),
        usage: "bb tools unignore <name...>",
      },
      { name: "plan", summary: t("Показать план синхронизации"), usage: "bb tools plan [--host <id>]" },
      {
        name: "sync",
        summary: t("Синхронизировать машины с каталогом"),
        usage: "bb tools sync [--host <id>] [--dry-run] [--with-different]",
      },
      {
        name: "forget",
        summary: t("Убрать запись из каталога, машины не трогать"),
        usage: "bb tools forget <name>",
      },
      {
        name: "remove",
        summary: t("Удалить сервер со всех машин"),
        usage: "bb tools remove <name> [--host <id>] [--with-gateways] [--dry-run]",
      },
      {
        name: "probe",
        summary: t("Живая проверка связи с серверами"),
        usage: "bb tools probe [<name>] [--host <id>]",
      },
      {
        name: "enable",
        summary: t("Включить сервер там, где формат это поддерживает"),
        usage: "bb tools enable <name> [--host <id>]",
      },
      {
        name: "disable",
        summary: t("Выключить сервер, не удаляя его"),
        usage: "bb tools disable <name> [--host <id>]",
      },
      { name: "auto", summary: t("Автосинхронизация раз в час"), usage: "bb tools auto on|off" },
      {
        name: "gateway-add",
        summary: t("Добавить серверы за шлюз MetaMCP из JSON-файла"),
        usage: t("bb tools gateway-add <файл.json> --host <id>"),
      },
      {
        name: "lang",
        summary: t("Язык интерфейса и вывода: ru или en"),
        usage: "bb tools lang [ru|en]",
      },
      {
        name: "skills",
        summary: t("Скиллы вне канона, с --canon — сам канон по машинам"),
        usage: "bb tools skills [--host <id>] [--canon]",
      },
      {
        name: "skills-adopt",
        summary: t("Перенести скилл в канон или перекрыть симлинком"),
        usage: t("bb tools skills-adopt <папка> <имя> --host <id> [--link|--delete|--take|--unlink]"),
      },
      {
        name: "skills-fanout",
        summary: t("Разложить канон по домам CLI: ссылки, зеркало BB, архив"),
        usage: "bb tools skills-fanout [--host <id>] [--dry-run] [--all]",
      },
      {
        name: "skills-backups",
        summary: t("Архив снимков скиллов"),
        usage: "bb tools skills-backups [--host <id>] [--json]",
      },
      {
        name: "skills-restore",
        summary: t("Вернуть снимок из архива в канон"),
        usage: t("bb tools skills-restore <id-снимка> --host <id>"),
      },
      {
        name: "skills-sync",
        summary: t("Синк канона скиллов с git-remote"),
        usage: "bb tools skills-sync [--host <id>]",
      },
      {
        name: "plugins",
        summary: t("Установленные плагины BB по машинам"),
        usage: "bb tools plugins [--json]",
      },
      {
        name: "opencode",
        summary: t("Состояние моделей и провайдеров OpenCode на всех машинах"),
        usage: "bb tools opencode [--json]",
      },
      {
        name: "opencode-sync",
        summary: t("Синхронизировать конфигурацию OpenCode с эталона на другие машины"),
        usage: "bb tools opencode-sync [--from <host>] [--to <host>] [--dry-run] [--json]",
      },
      {
        name: "opencode-clean",
        summary: t("Очистить устаревшие провайдеры OpenCode"),
        usage: "bb tools opencode-clean [--host <id>] [--dry-run] [--json]",
      },
      {
        name: "opencode-set-default",
        summary: t("Выбрать предустановленную модель OpenCode для новых чатов BB и CLI"),
        usage: "bb tools opencode-set-default <modelId>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const dryRun = argv.includes("--dry-run");
      const withDifferent = argv.includes("--with-different");
      const withGateways = argv.includes("--with-gateways");
      const hostIndex = argv.indexOf("--host");
      const hostId = hostIndex === -1 ? null : (argv[hostIndex + 1] ?? null);
      const rest = argv.filter(
        (arg, index) =>
          !arg.startsWith("--") && (hostIndex === -1 || index !== hostIndex + 1),
      );
      const [command, ...args] = rest;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });

      switch (command) {
        case undefined:
        case "help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const current = await overview();
          return reply(current, renderStatus(current));
        }
        case "scan": {
          await Promise.all([scanAll(hostId), refreshMetaMcp()]);
          const current = await publish();
          return reply(current, renderStatus(current));
        }
        case "catalog": {
          const catalog = await readCatalog();
          return reply(
            catalog,
            catalog.length === 0
              ? t("Каталог пуст. Примите серверы: bb tools adopt <name>")
              : catalog
                  .map(
                    (entry) =>
                      `${entry.name}  [${entry.scope}]  ${entry.spec.transport}  ${entry.spec.command ?? entry.spec.url ?? ""}`,
                  )
                  .join("\n"),
          );
        }
        case "pending": {
          const current = await overview();
          return reply(
            current.pending,
            current.pending.length === 0
              ? t("Новых серверов нет.")
              : current.pending
                  .map(
                    (item) =>
                      `${item.name}  ← ${item.hostName}/${item.kind}${item.localOnly ? `  [${tp("локальный: {0}", item.reason)}]` : ""}`,
                  )
                  .join("\n"),
          );
        }
        case "adopt": {
          if (args.length === 0) break;
          await adopt(args, null);
          const current = await publish();
          return reply(current.catalog, tp("Принято в каталог: {0}", args.join(", ")));
        }
        case "ignore": {
          if (args.length === 0) break;
          const ignored = new Set(await readIgnored());
          for (const name of args) ignored.add(name);
          await bb.storage.kv.set("ignored", [...ignored]);
          await publish();
          return reply({ ignored: [...ignored] }, tp("Скрыто: {0}", args.join(", ")));
        }
        case "unignore": {
          if (args.length === 0) break;
          const ignored = new Set(await readIgnored());
          for (const name of args) ignored.delete(name);
          await bb.storage.kv.set("ignored", [...ignored]);
          await publish();
          return reply({ ignored: [...ignored] }, tp("Возвращено: {0}", args.join(", ")));
        }
        case "plan": {
          const ops = await planOps(hostId, true);
          return reply(
            ops.map(({ server: _server, ...rest }) => rest),
            ops.length === 0
              ? t("Всё синхронно.")
              : ops
                  .map((op) => `${op.hostName} / ${op.kind}: ${op.action} ${op.name} (${op.reason})`)
                  .join("\n"),
          );
        }
        case "sync": {
          const result = await runSync(hostId, dryRun, withDifferent);
          return reply(
            result,
            `${dryRun ? t("Пробный запуск. ") : ""}${tp("Применено: {0}, ошибок: {1}", result.applied, result.failed)}` +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "forget": {
          const name = args[0];
          if (name === undefined || args.length !== 1) break;
          const catalog = await readCatalog();
          if (!catalog.some((entry) => entry.name === name)) {
            return { exitCode: 1, stderr: tp("В каталоге нет записи {0}.", name) };
          }
          await writeCatalog(catalog.filter((entry) => entry.name !== name));
          const current = await publish();
          return reply(current.catalog, tp("Убрано из каталога: {0}. На машинах не тронуто.", name));
        }
        case "remove": {
          const name = args[0];
          if (name === undefined || args.length !== 1) break;
          const result = await runPurge(name, hostId, withGateways, dryRun);
          if (dryRun) {
            return reply(
              result,
              tp("Пробный запуск. Затронуло бы записей: {0}", result.removed) +
                (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
            );
          }
          const catalog = await readCatalog();
          await writeCatalog(catalog.filter((entry) => entry.name !== name));
          const ignored = new Set(await readIgnored());
          ignored.add(name);
          await bb.storage.kv.set("ignored", [...ignored]);
          await publish();
          return reply(
            result,
            tp("Удалено записей: {0}, ошибок: {1}", result.removed, result.failed) +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "probe": {
          const target = args[0] ?? null;
          const result = await runProbe(hostId, target);
          const current = await publish();
          const lines = current.probes
            .filter((item) => target === null || item.name === target)
            .map((item) => {
              const machine = current.hosts.find((host) => host.hostId === item.hostId)?.name ?? item.hostId;
              const status = item.ok
                ? `${t("отвечает")}${item.tools === null ? "" : tp(", инструментов {0}", item.tools)}`
                : tp("не отвечает: {0}", item.error ?? t("ошибка"));
              return `  ${item.name} (${machine} / ${item.kind}) — ${status}, ${tp("{0} мс", item.durationMs)}`;
            });
          if (result.checked === 0) {
            return reply(current.probes, t("Нечего проверять: серверов на машинах не найдено."));
          }
          return reply(
            current.probes,
            tp("Проверено {0}, не ответили {1}", result.checked, result.failed) +
              (lines.length === 0 ? "" : `\n${lines.join("\n")}`),
          );
        }
        case "enable":
        case "disable": {
          const name = args[0];
          if (name === undefined || args.length !== 1) break;
          const result = await runSetEnabled(name, hostId, command === "enable");
          return reply(
            result,
            tp("{0} в {1}", command === "enable" ? t("Включено") : t("Выключено"), plural(result.changed, ["конфиге", "конфигах", "конфигах"])) +
              (result.skipped === 0 ? "" : tp(", пропущено {0} (формат без флага выключения)", result.skipped)) +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "auto": {
          const mode = args[0];
          if (mode !== "on" && mode !== "off") break;
          await bb.storage.kv.set("autoSync", mode === "on");
          await publish();
          return reply({ autoSync: mode === "on" }, tp("Автосинхронизация {0}", mode === "on" ? t("включена") : t("выключена")));
        }
        case "gateway-add": {
          const file = args[0];
          if (file === undefined || args.length !== 1) break;
          if (hostId === null) {
            return { exitCode: 1, stderr: t("Укажите машину: --host <id>") };
          }
          let text: string;
          try {
            text = await readFile(expandHome(file), "utf8");
          } catch (cause) {
            return {
              exitCode: 1,
              stderr: tp("Не удалось прочитать {0}: {1}", file, cause instanceof Error ? cause.message : String(cause)),
            };
          }
          const result = await runGatewayAdd(hostId, text);
          await publish();
          return reply(
            result,
            tp("За шлюз добавлено: {0}", result.added) +
              (result.replaced.length > 0 ? tp(", заменены: {0}", result.replaced.join(", ")) : "") +
              (result.backups.length > 0 ? `\n${tp("Бэкап: {0}", result.backups.join(", "))}` : "") +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "lang": {
          const next = args[0];
          if (next === undefined) {
            return reply({ lang: currentLang }, tp(t("Язык: {0}. Переключить: bb tools lang ru|en"), currentLang));
          }
          if (!isLang(next) || args.length !== 1) {
            return { exitCode: 1, stderr: t("Укажите язык: ru или en") };
          }
          currentLang = next;
          setLang(next);
          await bb.storage.kv.set("lang", next);
          await publish();
          return reply(
            { lang: next },
            t("Язык переключён. Подписи настроек и команд обновятся после перезагрузки плагина."),
          );
        }
        case "skills": {
          const current = await overview();
          // Без флага показываем только то, что лежит мимо канона; с ним — сам
          // канон по машинам: одна строка на скилл, видно паритет целиком.
          if (argv.includes("--canon")) {
            const names = current.skills.map((view) => view.hostName);
            const lines = current.skillCanon.map((row) => {
              const cells = row.hosts
                .map((item, index) => {
                  const mark = item.state === "same" ? t("есть") : item.state === "differs" ? t("отличается") : t("нет");
                  return `${names[index] ?? item.hostId}: ${mark}`;
                })
                .join("  ");
              return `${row.name}${row.fromPlugin ? t(" (плагин)") : ""}  ${cells}`;
            });
            const gaps = current.skillCanon.filter((row) => row.hosts.some((item) => item.state === "missing")).length;
            const differs = current.skillCanon.filter((row) => row.hosts.some((item) => item.state === "differs")).length;
            return reply(
              current.skillCanon,
              current.skillCanon.length === 0
                ? t("Канон пуст или машины ещё не просканированы.")
                : `${lines.join("\n")}\n\n${tp("Всего {0}; не на всех машинах: {1}; расходятся: {2}", current.skillCanon.length, gaps, differs)}`,
            );
          }
          const rows = current.skills
            .filter((view) => hostId === null || view.hostId === hostId)
            .flatMap((view) =>
              view.rows.map((row) => ({ ...row, hostId: view.hostId, hostName: view.hostName })),
            );
          return reply(
            rows,
            rows.length === 0
              ? t("Скиллы вне канона не найдены.")
              : rows
                  .map(
                    (row) =>
                      `${row.name}  ← ${row.hostName} ${locationPath(row.locationId)}  [${row.state}]`,
                  )
                  .join("\n"),
          );
        }
        case "skills-adopt": {
          const [locationId, name] = args;
          if (locationId === undefined || name === undefined || args.length !== 2) break;
          if (hostId === null) {
            return { exitCode: 1, stderr: t("Укажите машину: --host <id>") };
          }
          const mode = argv.includes("--unlink")
            ? "unlink"
            : argv.includes("--delete")
              ? "delete"
              : argv.includes("--take")
                ? "take"
                : argv.includes("--link")
                  ? "link"
                  : "adopt";
          const outcome = await host.call("skills_adopt", { locationId, name, mode }, { hostId });
          if (!outcome.ok) {
            return { exitCode: 1, stderr: tp("Скилл {0}: {1}", name, t(outcome.error ?? "не удалось")) };
          }
          await scanAll(hostId);
          const current = await publish();
          const done =
            mode === "unlink"
              ? t("ссылка убрана")
              : mode === "delete"
                ? t("копия удалена")
                : mode === "link"
                  ? t("копия заменена каноном")
                  : t("перенесён в ~/.agents/skills");
          return reply({ ok: true }, tp("Скилл {0}: {1} ({2} в ожидании)", name, done, current.badge));
        }
        case "skills-fanout": {
          const result = await runSkillsFanOut(hostId, dryRun, argv.includes("--all") ? true : undefined);
          // Пустой канон и «дома уже совпадают» — разные новости для человека.
          const canonEmpty = (await overview()).skillCanon.length === 0;
          const byKind = new Map<string, number>();
          for (const op of result.ops) byKind.set(op.kind, (byKind.get(op.kind) ?? 0) + 1);
          const summary = [...byKind]
            .map(([kind, count]) => `${SKILL_FANOUT_LABEL[kind] ?? kind}: ${count}`)
            .join(", ");
          return reply(
            result,
            (dryRun ? t("Пробный запуск. ") : "") +
              (result.ops.length === 0
                ? canonEmpty
                  ? t("Канон пуст — раскатывать нечего.")
                  : t("Дома уже совпадают с каноном.")
                : `${summary}. ${tp("Готово: {0}, ошибок: {1}", result.applied, result.failed)}`) +
              (result.skippedByPlugin.length === 0
                ? ""
                : `\n${tp("Отдаёт плагин, не дублируем: {0}", result.skippedByPlugin.join(", "))}`) +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "skills-backups": {
          const result = await runSkillsBackups(hostId);
          return reply(
            result,
            result.backups.length === 0
              ? t("Архив пуст.")
              : result.backups
                  .map(
                    (item) =>
                      `${item.at}  ${item.name}  ${item.unique ? t("уникальная") : t("дубль")}  ${plural(item.files, ["файл", "файла", "файлов"])}  ${item.hostName}  ${t(item.reason)}\n  id: ${item.id}`,
                  )
                  .join("\n"),
          );
        }
        case "skills-restore": {
          const id = args[0];
          if (id === undefined || args.length !== 1) break;
          if (hostId === null) return { exitCode: 1, stderr: t("Укажите машину: --host <id>") };
          const result = await host.call("skills_backup_restore", { id }, { hostId });
          if (!result.ok) return { exitCode: 1, stderr: result.error ?? t("не удалось восстановить снимок") };
          await scanAll(hostId);
          await publish();
          return reply(result, result.message ?? t("Снимок восстановлен"));
        }
        case "skills-sync": {
          const result = await (async () => {
            const remote = (await readConfig()).skillsSyncRemote.trim();
            if (remote === "") throw new Error(t("Синк выключен: не задан git-remote (настройка «Скиллы: git-remote канона»)"));
            const hostsList = await bb.sdk.hosts.list();
            const targets = hostsList.filter(
              (candidate) => (hostId === null || candidate.id === hostId) && candidate.status === "connected",
            );
            let synced = 0;
            const errors: string[] = [];
            for (const machine of targets) {
              try {
                await host.call("skills_sync", { remote }, { hostId: machine.id });
                synced += 1;
              } catch (cause) {
                errors.push(`${machine.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
              }
            }
            return { synced, errors };
          })();
          await publish();
          return reply(
            result,
            tp("Синк скиллов: машин {0}", result.synced) +
              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
          );
        }
        case "plugins": {
          const current = await overview();
          const byAgent = new Map<string, CliPluginItem[]>();
          for (const p of current.plugins) {
            const list = byAgent.get(p.agentLabel) ?? [];
            list.push(p);
            byAgent.set(p.agentLabel, list);
          }

          const lines = [
            tp("Плагины CLI-агентов: {0} всего по {1} машинам", current.plugins.length, current.hosts.length),
            "",
          ];

          for (const [agentLabel, items] of byAgent) {
            lines.push(`${agentLabel} (${items.length}):`);
            for (const p of items) {
              const hostsInfo = Object.entries(p.hosts)
                .map(([_, h]) => `${h.hostName}: ${h.installed ? `${t("установлен")}${h.version ? ` v${h.version}` : ""}` : "—"}`)
                .join("; ");
              lines.push(`  • ${p.name} [${p.id}]${p.marketplace ? ` (${p.marketplace})` : ""}\n      ${hostsInfo}`);
            }
            lines.push("");
          }

          return reply(current.plugins, lines.join("\n").trimEnd());
        }
        case "opencode": {
          const current = await overview();
          const lines = [
            tp("OpenCode: машин {0}, провайдеров {1}, расхождений {2}", current.opencode.hosts.length, current.opencode.providers.length, current.opencode.drift.length),
            "",
            t("Машины:"),
            ...current.opencode.hosts.map((h) =>
              `  • ${h.hostName}: model=${h.model ?? "—"} small=${h.smallModel ?? "—"} ${t("активны")}=[${h.enabledProviders.join(", ")}] (${h.configPath ?? t("нет конфига")})`
            ),
            "",
            t("Провайдеры:"),
            ...current.opencode.providers.map((p) => {
              const presence = Object.entries(p.hosts)
                .map(([_, h]) => `${h.enabled ? t("включён") : h.configured ? t("настроен") : t("нет")}`)
                .join(" / ");
              return `  • ${p.name} (${p.id}): ${presence} ${p.isCanonical ? t("[канон]") : ""}${p.isStale ? t("[устаревший]") : ""}`;
            }),
          ];
          if (current.opencode.drift.length > 0) {
            lines.push("", t("Расхождения:"));
            for (const d of current.opencode.drift) {
              const h = current.opencode.hosts.find((x) => x.hostId === d.hostId)?.hostName ?? d.hostId;
              lines.push(`  ⚠ ${h}: ${d.description}`);
            }
          }
          return reply(current.opencode, lines.join("\n"));
        }
        case "opencode-sync": {
          const fromIdx = argv.indexOf("--from");
          const toIdx = argv.indexOf("--to");
          const sourceHostId = fromIdx === -1 ? null : argv[fromIdx + 1] ?? null;
          const targetHostId = toIdx === -1 ? null : argv[toIdx + 1] ?? null;
          const result = await runOpenCodeSync({
            sourceHostId,
            targetHostId,
            syncProviders: true,
            syncModels: true,
            syncEnabled: true,
            dryRun,
          });
          return reply(
            result,
            `OpenCode sync${dryRun ? " [dry-run]" : ""}: ${tp("синхронизировано машин {0}", result.synced)}` +
              (result.errors.length === 0 ? "" : `\n${tp("Ошибки: {0}", result.errors.join("\n"))}`),
          );
        }
        case "opencode-clean": {
          const result = await runOpenCodeClean({ hostId, dryRun });
          return reply(
            result,
            `OpenCode clean${dryRun ? " [dry-run]" : ""}: ${tp("удалено устаревших провайдеров {0}", result.removed)}` +
              (result.errors.length === 0 ? "" : `\n${tp("Ошибки: {0}", result.errors.join("\n"))}`),
          );
        }
        case "opencode-set-default": {
          const modelId = args[0];
          if (!modelId) {
            return { exitCode: 1, stderr: t("Укажите id модели: bb tools opencode-set-default <modelId>") };
          }
          const bbUpdated = setBbPreselectedModel(modelId);
          const hostsList = await bb.sdk.hosts.list();
          let hostsUpdated = 0;
          for (const m of hostsList.filter((c) => c.status === "connected")) {
            const res = await host.call(
              "opencode_apply",
              { ops: [{ action: "set_models", model: modelId }], dryRun: false },
              { hostId: m.id },
            ).catch(() => null);
            if (res?.ok) hostsUpdated += 1;
          }
          await scanAll(null);
          await publish();
          return reply(
            { modelId, bbUpdated, hostsUpdated },
            tp("Предустановленная модель: {0} (BB: {1}, хосты: {2})", modelId, bbUpdated ? t("обновлено") : t("пропущено"), hostsUpdated),
          );
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info(`loaded: ${AGENTS.length} agent adapters, ${EXTRA_CLI_BINS.length} extra CLIs`);
}
