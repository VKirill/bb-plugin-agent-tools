// Wire schemas shared by the server entry, the host entry, and the frontend.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const transportSchema = z.enum(["stdio", "http", "sse"]);

/** One MCP server, normalized away from any single CLI's dialect. */
export const mcpServerSchema = z.object({
  name: z.string().min(1).max(120),
  transport: transportSchema,
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  env: z.record(z.string().max(200), z.string().max(8192)).optional(),
  url: z.string().max(4096).optional(),
  headers: z.record(z.string().max(200), z.string().max(8192)).optional(),
  disabled: z.boolean().optional(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** What one CLI agent looks like on one machine. */
export const detectedAgentSchema = z.object({
  kind: z.string(),
  label: z.string(),
  installed: z.boolean(),
  binPath: z.string().nullable(),
  configPath: z.string().nullable(),
  configExists: z.boolean(),
  /** False when the file exists but cannot be edited safely (e.g. jsonc with comments). */
  writable: z.boolean(),
  gateway: z.boolean(),
  servers: z.array(mcpServerSchema).max(400),
  warning: z.string().max(400).nullable(),
});
export type DetectedAgent = z.infer<typeof detectedAgentSchema>;

export const hostScanSchema = z.object({
  hostname: z.string(),
  platform: z.string(),
  home: z.string(),
  scannedAt: z.number(),
  agents: z.array(detectedAgentSchema).max(64),
  /** Installed CLIs with no MCP adapter in this plugin. */
  otherClis: z.array(z.object({ bin: z.string(), path: z.string() })).max(64),
});
export type HostScan = z.infer<typeof hostScanSchema>;

export const applyOpSchema = z.object({
  kind: z.string(),
  action: z.enum(["upsert", "remove"]),
  server: mcpServerSchema,
});
export type ApplyOp = z.infer<typeof applyOpSchema>;

export const applyResultSchema = z.object({
  results: z
    .array(
      z.object({
        kind: z.string(),
        action: z.enum(["upsert", "remove"]),
        name: z.string(),
        ok: z.boolean(),
        error: z.string().max(400).nullable(),
      }),
    )
    .max(400),
  backups: z.array(z.string()).max(64),
});

/** Full-trust calls that run on each enrolled machine. */

// ---------------------------------------------------------------------------
// Skills: every folder a CLI might read skills from, scanned read-only.

export const skillsScanSchema = z.object({
  /** Абсолютный путь канонического дома (~/.agents/skills) на машине. */
  canonicalPath: z.string().max(1024),
  /** Канон на машине уже git-репозиторий (есть ~/.agents/skills/.git). Без URL. */
  canonHasGit: z.boolean().default(false),
  /** Имена скиллов, которые на этой машине уже отдают плагины-маркетплейсы. */
  pluginNames: z.array(z.string().max(120)).max(500).default([]),
  locations: z
    .array(
      z.object({
        id: z.string().max(40),
        path: z.string().max(1024),
        exists: z.boolean(),
        /** Сам CLI на машине есть (есть его домашняя папка), а папки скиллов ещё нет. */
        parentExists: z.boolean().default(false),
        entries: z
          .array(
            z.object({
              name: z.string().max(120),
              kind: z.enum(["dir", "symlink"]),
              /** Разрешённая абсолютная цель симлинка, если это симлинк. */
              target: z.string().max(1024).nullable(),
              hash: z.string().max(64).nullable(),
              mtime: z.number().nullable(),
              hasSkillMd: z.boolean(),
            }),
          )
          .max(500),
      }),
    )
    .max(32),
});
export type SkillsScan = z.infer<typeof skillsScanSchema>;

/** Снимок скилла в архиве: что, когда, откуда и почему туда попало. */
export const skillBackupSchema = z.object({
  /** Стабильный ключ снимка — относительный путь внутри архива. */
  id: z.string().max(300),
  name: z.string().max(120),
  at: z.string().max(40),
  /** Почему сняли: удалён человеком, заменён каноном, приехало удаление синком. */
  reason: z.string().max(200),
  locationId: z.string().max(40),
  hash: z.string().max(64).nullable(),
  files: z.number(),
  bytes: z.number(),
  /** Содержимое, которого больше нигде нет: ни в каноне, ни в других снимках. */
  unique: z.boolean(),
});
export type SkillBackup = z.infer<typeof skillBackupSchema>;

export const fanOutOpSchema = z.object({
  kind: z.enum(["link", "mirror", "drop", "pull", "retire"]),
  locationId: z.string().max(40),
  name: z.string().max(120),
  reason: z.string().max(200),
});

export const skillStateSchema = z.enum([
  "canonical", // настоящий скилл в ~/.agents/skills
  "linked", // симлинк на канон — здоровый алиас
  "linked-external", // симлинк куда-то ещё (например ~/.bb/skills)
  "copy", // реальная копия канона — дубликат
  "diverged", // копия с тем же именем, но другим содержимым
  "only-here", // есть только в этой папке — кандидат в канон
  "stray-link", // ссылка в папке, которую мы не используем (Gemini/Antigravity)
  "bb-registry", // ссылка на ~/.bb/skills — BB подставляет этот скилл в свои сессии сам
  "canonical-source", // канон ссылается сюда симлинком — реальное хранилище
]);
export type SkillState = z.infer<typeof skillStateSchema>;

/** Результат живой проверки одного сервера на машине. */
export const probeResultSchema = z.object({
  kind: z.string(),
  name: z.string(),
  ok: z.boolean(),
  /** Сколько инструментов отдал сервер, если успел ответить на tools/list. */
  tools: z.number().nullable(),
  error: z.string().max(300).nullable(),
  durationMs: z.number(),
  checkedAt: z.number(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

// ---------------------------------------------------------------------------
// OpenCode: models and providers across machines

export const openCodeModelConfigSchema = z.object({
  name: z.string().optional(),
  tool_call: z.boolean().optional(),
  attachment: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
});
export type OpenCodeModelConfig = z.infer<typeof openCodeModelConfigSchema>;

export const openCodeProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  npm: z.string().optional(),
  baseURL: z.string().optional(),
  hasApiKey: z.boolean(),
  models: z.record(z.string(), openCodeModelConfigSchema).optional(),
  whitelist: z.array(z.string()).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type OpenCodeProviderConfig = z.infer<typeof openCodeProviderConfigSchema>;

export const openCodeScanSchema = z.object({
  installed: z.boolean(),
  binPath: z.string().nullable(),
  configPath: z.string().nullable(),
  configExists: z.boolean(),
  writable: z.boolean(),
  model: z.string().nullable(),
  smallModel: z.string().nullable(),
  enabledProviders: z.array(z.string()).max(100),
  providers: z.record(z.string(), openCodeProviderConfigSchema),
  plugins: z.array(z.string()).max(100),
  warning: z.string().max(400).nullable(),
});
export type OpenCodeScan = z.infer<typeof openCodeScanSchema>;

export const openCodeOpSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert_provider"),
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()),
    enable: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("remove_provider"),
    providerId: z.string(),
  }),
  z.object({
    action: z.literal("set_models"),
    model: z.string().optional(),
    smallModel: z.string().optional(),
  }),
  z.object({
    action: z.literal("set_enabled"),
    enabledProviders: z.array(z.string()),
  }),
]);
export type OpenCodeOp = z.infer<typeof openCodeOpSchema>;

export const openCodeApplyInputSchema = z.object({
  ops: z.array(openCodeOpSchema).max(100),
  dryRun: z.boolean(),
});
export type OpenCodeApplyInput = z.infer<typeof openCodeApplyInputSchema>;

export const openCodeApplyResultSchema = z.object({
  ok: z.boolean(),
  backups: z.array(z.string()).max(64),
  error: z.string().max(400).nullable(),
  scan: openCodeScanSchema.nullable(),
});
export type OpenCodeApplyResult = z.infer<typeof openCodeApplyResultSchema>;

// ---------------------------------------------------------------------------
// Plugins: installed CLI agent plugins (Claude Code, OpenCode, Codex, etc.)

export const hostCliPluginsScanSchema = z.object({
  plugins: z
    .array(
      z.object({
        id: z.string().max(200),
        agent: z.string().max(60),
        name: z.string().max(120),
        marketplace: z.string().max(120).nullable(),
        version: z.string().max(60).nullable(),
        scope: z.string().max(60).nullable(),
        enabled: z.boolean(),
        installPath: z.string().max(1024).nullable(),
      }),
    )
    .max(300),
});
export type HostCliPluginsScan = z.infer<typeof hostCliPluginsScanSchema>;

export const cliPluginItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  agent: z.string(),
  agentLabel: z.string(),
  marketplace: z.string().nullable(),
  version: z.string().nullable(),
  scope: z.string().nullable(),
  hosts: z.record(
    z.string(),
    z.object({
      hostName: z.string(),
      installed: z.boolean(),
      enabled: z.boolean(),
      version: z.string().nullable(),
      installPath: z.string().nullable(),
    }),
  ),
});
export type CliPluginItem = z.infer<typeof cliPluginItemSchema>;

export const openCodeProviderRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string().nullable(),
  baseURL: z.string().nullable(),
  isCanonical: z.boolean(),
  isStale: z.boolean(),
  hosts: z.record(
    z.string(),
    z.object({
      configured: z.boolean(),
      enabled: z.boolean(),
      models: z.array(z.string()),
      hasApiKey: z.boolean(),
    }),
  ),
});
export type OpenCodeProviderRow = z.infer<typeof openCodeProviderRowSchema>;

export const openCodeModelItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  isDefaultInOpenCode: z.boolean(),
  isSmallInOpenCode: z.boolean(),
  isBbPreselected: z.boolean(),
});
export type OpenCodeModelItem = z.infer<typeof openCodeModelItemSchema>;

export const openCodeOverviewSchema = z.object({
  hosts: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      installed: z.boolean(),
      binPath: z.string().nullable(),
      configPath: z.string().nullable(),
      configExists: z.boolean(),
      writable: z.boolean(),
      model: z.string().nullable(),
      smallModel: z.string().nullable(),
      enabledProviders: z.array(z.string()),
      plugins: z.array(z.string()),
      warning: z.string().nullable(),
    }),
  ),
  providers: z.array(openCodeProviderRowSchema),
  availableModels: z.array(openCodeModelItemSchema),
  bbPreselectedModel: z.string().nullable(),
  drift: z.array(
    z.object({
      hostId: z.string(),
      type: z.enum(["model", "small_model", "stale_provider", "missing_provider", "disabled_provider"]),
      description: z.string(),
    }),
  ),
  canonicalSourceHostId: z.string().nullable(),
});
export type OpenCodeOverview = z.infer<typeof openCodeOverviewSchema>;

export const hostContract = defineRpcContract({
  scan: { input: z.object({}), output: hostScanSchema },
  apply: {
    input: z.object({ ops: z.array(applyOpSchema).max(200), dryRun: z.boolean() }),
    output: applyResultSchema,
  },
  probe: {
    input: z.object({
      targets: z.array(z.object({ kind: z.string(), name: z.string() })).max(60),
      timeoutMs: z.number().min(1000).max(60_000),
    }),
    output: z.object({ results: z.array(probeResultSchema).max(60) }),
  },
  skills_scan: { input: z.object({}), output: skillsScanSchema },
  skills_adopt: {
    input: z.object({
      locationId: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
      /** adopt — перенести; link — заменить симлинком/удалить; take — копия новее: её содержание в канон; unlink — убрать ссылку. */
      mode: z.enum(["adopt", "link", "take", "delete", "unlink"]),
    }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().max(300).nullable(),
    }),
  },
  skills_adopt_bulk: {
    input: z.object({
      ops: z
        .array(
          z.object({
            locationId: z.string().min(1).max(40),
            name: z.string().min(1).max(120),
            mode: z.enum(["adopt", "link", "take", "delete", "unlink"]),
          }),
        )
        .max(200),
    }),
    output: z.object({
      results: z
        .array(
          z.object({
            name: z.string().max(120),
            ok: z.boolean(),
            error: z.string().max(300).nullable(),
          }),
        )
        .max(200),
    }),
  },
  /**
   * Раскатка канона по домам CLI: ссылки для Claude Code, зеркало для BB,
   * архив для всего, что при этом заменяется или пропадает.
   */
  skills_fanout: {
    input: z.object({
      /** Имена, которые CLI и так получает из плагинов-маркетплейсов. */
      pluginNames: z.array(z.string().max(120)).max(500),
      dryRun: z.boolean(),
    }),
    output: z.object({
      ops: z.array(fanOutOpSchema.extend({ ok: z.boolean(), error: z.string().max(300).nullable() })).max(500),
      skippedByPlugin: z.array(z.string().max(120)).max(500),
    }),
  },
  skills_backups_list: {
    input: z.object({}),
    output: z.object({ backups: z.array(skillBackupSchema).max(500) }),
  },
  skills_backup_restore: {
    input: z.object({ id: z.string().min(1).max(300) }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().max(300).nullable(),
      message: z.string().max(600).nullable(),
    }),
  },
  skills_sync: {
    input: z.object({ remote: z.string().min(1).max(2048) }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().max(2000).nullable(),
      message: z.string().max(2000).nullable(),
    }),
  },
  opencode_scan: { input: z.object({}), output: openCodeScanSchema },
  opencode_apply: { input: openCodeApplyInputSchema, output: openCodeApplyResultSchema },
  plugins_scan: { input: z.object({}), output: hostCliPluginsScanSchema },
});

// ---------------------------------------------------------------------------
// Catalogue: the desired state the machines are brought to.

export const catalogEntrySchema = z.object({
  name: z.string().min(1).max(120),
  spec: mcpServerSchema,
  /** local-only entries are never rolled out; they stay where they were found. */
  scope: z.enum(["global", "local-only"]),
  /** Agent kinds to roll out to; empty means every managed agent. */
  targets: z.array(z.string()).max(32),
  origin: z.object({ hostId: z.string(), kind: z.string() }).nullable(),
  updatedAt: z.number(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Где именно сервер найден: машина, CLI и состояние в её конфиге. */
export const occurrenceSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  kind: z.string(),
  disabled: z.boolean(),
  /** Формат конфига понимает выключение (Codex, OpenCode, Grok). */
  togglable: z.boolean(),
});
export type Occurrence = z.infer<typeof occurrenceSchema>;

/** A server seen on a machine that the catalogue does not know yet. */
export const pendingSchema = z.object({
  name: z.string(),
  spec: mcpServerSchema,
  hostId: z.string(),
  hostName: z.string(),
  kind: z.string(),
  /** Все места, где этот сервер встречается, а не только первое. */
  occurrences: z.array(occurrenceSchema).max(200),
  /** Heuristic: absolute paths, loopback URLs and ${SECRET} refs are machine-bound. */
  localOnly: z.boolean(),
  /** server — обычный MCP, gateway — вход в другой набор, vendor — часть самого CLI. */
  role: z.enum(["server", "gateway", "vendor"]),
  reason: z.string().max(200),
  firstSeenAt: z.number(),
});
export type Pending = z.infer<typeof pendingSchema>;

export const cellStateSchema = z.enum([
  "present", // matches the catalogue
  "missing", // catalogue wants it here, machine lacks it
  "different", // present but configured differently
  "extra", // present, not in the catalogue
  "n/a", // agent not installed here
]);
export type CellState = z.infer<typeof cellStateSchema>;

