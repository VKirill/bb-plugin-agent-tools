import { stat } from "node:fs/promises";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ensurePath,
  locate,
  removeCategory,
  renameCategory,
  seedTree,
  treeOutline,
  upsertAssignment,
  type ReviewItem,
  type SkillAssignment,
  type SkillTree,
} from "./categories.ts";
import {
  applyModelAssign,
  CLASSIFIER_ROLE,
  EMPTY_CLASSIFIER_STATE,
  SkillClassifier,
  TOOL_ASSIGN,
  TOOL_TREE,
  treeForModel,
  type CategoryStore,
  type ClassifierState,
} from "./classifier.ts";
import {
  hubGitState,
  listHubSkills,
  packHubSkill,
  publishArchive,
  readHubSkill,
  readHubSkillFile,
  removeHubSkill,
  type HubSkill,
} from "./hub-skills.ts";
import { skillBodyExcerpt } from "./skill-meta.ts";
import { bbServerSkillsDir } from "./skills-server.ts";
import { t, tp } from "./i18n.ts";
import {
  CARD_WRITER_ROLE,
  EMPTY_CARD_WRITER_STATE,
  SkillCardWriter,
  TOOL_CARD_SAVE,
  applyCardSave,
  cardStats,
  formatSiblings,
  siblingsFor,
  type CardJob,
} from "./skill-suggest/card-writer.ts";
import { contentHash, manualCard, skillBody, skillCardSchema, type StoredCard } from "./skill-suggest/cards.ts";
import { createHttpJevClient } from "./skill-suggest/jev.ts";
import { SkillDispatchInjector, type DispatchContext, type QueuedRow } from "./skill-suggest/dispatch.ts";
import { ThreadSkillMemory, alreadySuggested, appendLog, type SuggestLogEntry, type SuggestLogMode } from "./skill-suggest/log.ts";
import {
  DEFAULT_EXCLUDE,
  DEFAULT_THRESHOLDS,
  find,
  formatFindList,
  keywordFind,
  parseExclude,
  parseThreshold,
  relevanceBlock,
  suggest,
  type RosterEntry,
} from "./skill-suggest/suggest.ts";

// ---------------------------------------------------------------- contract

const problemSchema = z.object({ code: z.string(), detail: z.string(), blocking: z.boolean() });

const subsectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleEn: z.string(),
  description: z.string(),
});

export const skillTreeSchema = z.object({
  sections: z.array(subsectionSchema.extend({ subsections: z.array(subsectionSchema) })),
});

const commitSchema = z.object({ sha: z.string(), at: z.number(), subject: z.string(), author: z.string() });

const hubSkillViewSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  bytes: z.number(),
  files: z.number(),
  mtime: z.number(),
  problems: z.array(problemSchema),
  category: z
    .object({
      sectionId: z.string(),
      subsectionId: z.string(),
      source: z.enum(["manual", "family", "model"]),
      confidence: z.number().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  review: z
    .object({
      section: z.string(),
      subsection: z.string(),
      confidence: z.number().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
});

const foundSkillSchema = z.object({ name: z.string(), path: z.string(), home: z.string(), mtime: z.number() });

const machineHomesSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  homes: z.array(z.object({ id: z.string(), path: z.string(), skills: z.number(), links: z.number() })),
  /** Skills this machine's CLI folders hold that the hub does not have. */
  notOnHub: z.array(foundSkillSchema).default([]),
  error: z.string().nullable(),
  at: z.number(),
});

export const skillsHubSchema = z.object({
  available: z.boolean(),
  root: z.string(),
  git: z.object({
    isRepo: z.boolean(),
    branch: z.string().nullable(),
    head: commitSchema.nullable(),
    dirty: z.number(),
    remote: z.string().nullable(),
    error: z.string().nullable(),
  }),
  skills: z.array(hubSkillViewSchema),
  tree: skillTreeSchema,
  classifier: z.object({
    threadId: z.string().nullable(),
    startedAt: z.number(),
    count: z.number(),
    running: z.boolean(),
    lastRunAt: z.number().nullable(),
    lastError: z.string().nullable(),
    lastPlaced: z.number(),
    model: z.string(),
  }),
  machines: z.array(machineHomesSchema),
  offerCleanup: z.boolean(),
});

const skillsSettingsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  auto: z.boolean(),
  projectId: z.string(),
  offerCleanup: z.boolean(),
  providers: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean() })),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});

const detailSchema = hubSkillViewSchema.extend({
  content: z.string().nullable(),
  contentTruncated: z.boolean(),
  fileList: z.array(z.object({ path: z.string(), bytes: z.number() })),
  fileListTruncated: z.boolean(),
  history: z.array(commitSchema),
});

const commitResultSchema = z
  .object({ committed: z.boolean(), sha: z.string().nullable(), pushed: z.boolean(), error: z.string().nullable() })
  .nullable();

export const publishResultSchema = z.object({
  ok: z.boolean(),
  name: z.string().nullable(),
  replaced: z.boolean(),
  problems: z.array(problemSchema),
  commit: commitResultSchema,
  error: z.string().nullable(),
});

export const skillsRpcContract = {
  skills_hub: { input: z.null(), output: skillsHubSchema },
  skills_hub_detail: { input: z.object({ name: z.string().max(120) }), output: detailSchema.nullable() },
  skills_hub_file: {
    input: z.object({ name: z.string().max(120), path: z.string().max(500) }),
    output: z.object({ text: z.string().nullable() }),
  },
  skills_move: {
    input: z.object({ skill: z.string().max(120), sectionId: z.string(), subsectionId: z.string() }),
    output: skillsHubSchema,
  },
  skills_review_accept: { input: z.object({ skill: z.string().max(120) }), output: skillsHubSchema },
  skills_category_create: {
    input: z.object({ section: z.string().min(1).max(60), subsection: z.string().min(1).max(60) }),
    output: skillsHubSchema,
  },
  skills_category_rename: {
    input: z.object({ id: z.string(), title: z.string().min(1).max(60) }),
    output: skillsHubSchema,
  },
  skills_category_remove: { input: z.object({ id: z.string() }), output: skillsHubSchema },
  skills_classify: { input: z.null(), output: skillsHubSchema },
  skills_remove: {
    input: z.object({ name: z.string().max(120) }),
    output: z.object({ ok: z.boolean(), error: z.string().nullable(), hub: skillsHubSchema }),
  },
  skills_pull: {
    input: z.object({ name: z.string().max(120), hostId: z.string(), target: z.string().max(500).nullable() }),
    output: z.object({ ok: z.boolean(), path: z.string().nullable(), error: z.string().nullable() }),
  },
  skills_publish: {
    input: z.object({ hostId: z.string(), path: z.string().max(500), dryRun: z.boolean() }),
    output: publishResultSchema,
  },
  skills_settings: { input: z.null(), output: skillsSettingsSchema },
  skills_settings_set: {
    input: z.object({
      provider: z.string().max(120).optional(),
      model: z.string().max(200).optional(),
      auto: z.boolean().optional(),
      projectId: z.string().max(120).optional(),
      offerCleanup: z.boolean().optional(),
    }),
    output: skillsSettingsSchema,
  },
  skills_provider_models: {
    input: z.object({ providerId: z.string().max(120) }),
    output: z.object({
      models: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
      error: z.string().nullable(),
    }),
  },
  skills_machines_refresh: { input: z.null(), output: skillsHubSchema },
  skills_machines_import: {
    input: z.object({ hostId: z.string(), names: z.array(z.string().max(200)).max(3000).nullable() }),
    output: z.object({
      results: z.array(
        z.object({ name: z.string(), ok: z.boolean(), error: z.string().nullable(), problems: z.array(problemSchema) }),
      ),
      hub: skillsHubSchema,
    }),
  },
  skills_machines_cleanup: {
    input: z.object({ hostId: z.string(), dryRun: z.boolean() }),
    output: z.object({
      backup: z.string().nullable(),
      moved: z.array(z.object({ id: z.string(), count: z.number() })),
      errors: z.array(z.string()),
      hub: skillsHubSchema,
    }),
  },
} as const;

export type SkillsHub = z.infer<typeof skillsHubSchema>;
export type SkillsHubDetail = z.infer<typeof detailSchema>;
export type MachineHomes = z.infer<typeof machineHomesSchema>;

// ---------------------------------------------------------------- service

type HostCaller = {
  call(method: string, input: unknown, opts: { hostId: string; timeoutMs?: number }): Promise<unknown>;
};

export type SkillsHubConfig = {
  classifierProvider: string;
  classifierModel: string;
  classifierProjectId: string;
  classifierAuto: boolean;
  /** Off by default: the plugin never offers to touch skill folders on machines. */
  offerCleanup: boolean;
  jevApiKey: string;
  jevModel: string;
  skillsSuggestTools: boolean;
  /** Append a skill hint to each user turn through the dispatch hook. */
  skillsSuggestInject: boolean;
  skillsSuggestGate: string;
  skillsSuggestFits: string;
  skillsSuggestExclude: string;
};

export type SkillsHubConfigPatch = Partial<{
  skillsClassifierProvider: string;
  skillsClassifierModel: string;
  skillsClassifierProjectId: string;
  skillsClassifierAuto: boolean;
  skillsOfferCleanup: boolean;
}>;

const CACHE_MS = 15_000;
const KV = {
  tree: "skillTree",
  assignments: "skillAssignments",
  review: "skillReview",
  classifier: "skillClassifier",
  machines: "skillMachines",
  cards: "skillCards",
  cardWriter: "skillCardWriter",
  suggestLog: "skillSuggestLog",
} as const;

const SKILL_READ_MAX = 60_000;
const SUGGEST_TOOLS = ["skills_find", "skill_read"] as const;

export function createSkillsHubService(
  bb: BbPluginApi,
  host: HostCaller,
  readConfig: () => Promise<SkillsHubConfig>,
  saveConfig: (patch: SkillsHubConfigPatch) => Promise<void>,
) {
  const root = bbServerSkillsDir(bb.server.experimental_dataDir);
  let cache: { at: number; skills: HubSkill[] } | null = null;

  async function hubSkills(fresh = false): Promise<HubSkill[]> {
    if (!fresh && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.skills;
    const skills = await listHubSkills(root);
    cache = { at: Date.now(), skills };
    return skills;
  }

  function invalidate(): void {
    cache = null;
  }

  async function readStore(): Promise<CategoryStore> {
    const [tree, assignments, review] = await Promise.all([
      bb.storage.kv.get<SkillTree>(KV.tree),
      bb.storage.kv.get<SkillAssignment[]>(KV.assignments),
      bb.storage.kv.get<ReviewItem[]>(KV.review),
    ]);
    return { tree: tree ?? seedTree(), assignments: assignments ?? [], review: review ?? [] };
  }

  // KV writes of the store are serialised: tool calls and UI edits can overlap.
  let storeLock: Promise<unknown> = Promise.resolve();
  function withStore<T>(fn: (store: CategoryStore) => Promise<{ store: CategoryStore; value: T }>): Promise<T> {
    const next = storeLock.then(async () => {
      const result = await fn(await readStore());
      await writeStore(result.store);
      return result.value;
    });
    storeLock = next.catch(() => undefined);
    return next;
  }

  async function writeStore(store: CategoryStore): Promise<void> {
    await Promise.all([
      bb.storage.kv.set(KV.tree, store.tree),
      bb.storage.kv.set(KV.assignments, store.assignments),
      bb.storage.kv.set(KV.review, store.review),
    ]);
  }

  async function readState(): Promise<ClassifierState> {
    return { ...EMPTY_CLASSIFIER_STATE, ...((await bb.storage.kv.get<ClassifierState>(KV.classifier)) ?? {}) };
  }

  async function personalProjectId(): Promise<string> {
    const configured = (await readConfig()).classifierProjectId.trim();
    if (configured !== "") return configured;
    const projects = (await bb.sdk.projects.list()) as unknown as Array<{ id: string; kind?: string }> | { projects: Array<{ id: string; kind?: string }> };
    const list = Array.isArray(projects) ? projects : projects.projects;
    const pick = list.find((project) => project.kind === "personal") ?? list[0];
    if (pick === undefined) throw new Error("no BB project to run the skill classifier in");
    return pick.id;
  }

  async function threadStatus(threadId: string): Promise<string | null> {
    const result = (await bb.sdk.threads.get({ threadId }).catch(() => null)) as { status?: string; thread?: { status?: string } } | null;
    return result?.status ?? result?.thread?.status ?? null;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function spawnHidden(title: string, role: string, prompt: string): Promise<string> {
    const config = await readConfig();
    const result = (await bb.sdk.threads.spawn({
      projectId: await personalProjectId(),
      providerId: config.classifierProvider,
      // Empty: the provider's own default model.
      ...(config.classifierModel !== "" ? { model: config.classifierModel } : {}),
      environment: { type: "project-default" },
      visibility: "hidden",
      title,
      pluginMetadata: { role },
      prompt,
    } as Parameters<typeof bb.sdk.threads.spawn>[0])) as { id?: string; thread?: { id: string } };
    const id = result.thread?.id ?? result.id;
    if (id === undefined) throw new Error("BB did not return the hidden thread id");
    return id;
  }

  const sendMessage = async (threadId: string, text: string) => {
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text }] } as Parameters<typeof bb.sdk.threads.send>[0]);
  };

  const waitIdleFor = (label: string) => async (threadId: string, timeoutMs: number) => {
    const started = Date.now();
    let seenBusy = false;
    await sleep(2000);
    while (Date.now() - started < timeoutMs) {
      const status = await threadStatus(threadId);
      if (status === "error") throw new Error(`the ${label} thread failed`);
      if (status !== null && status !== "idle") seenBusy = true;
      if (status === "idle" && (seenBusy || Date.now() - started > 20_000)) return;
      await sleep(2000);
    }
    throw new Error(`the ${label} thread did not answer in time`);
  };

  const archiveThread = async (threadId: string) => {
    await (bb.sdk.threads as unknown as { archive(args: { threadId: string }): Promise<unknown> }).archive({ threadId });
  };

  const classifier = new SkillClassifier({
    readSkills: async () => {
      const skills = await hubSkills(true);
      const out = [];
      for (const skill of skills) {
        if (skill.problems.some((problem) => problem.code === "no-skill-md")) continue;
        const detail = await readHubSkill(root, skill.name);
        out.push({ name: skill.name, description: skill.description, excerpt: skillBodyExcerpt(detail?.content ?? null) });
      }
      return out;
    },
    readStore,
    writeStore: async (store) => {
      await withStore(async () => ({ store, value: undefined }));
    },
    readState,
    writeState: (state) => bb.storage.kv.set(KV.classifier, state),
    spawnThread: (prompt) => spawnHidden("Agent Tools: skill categories", CLASSIFIER_ROLE, prompt),
    sendMessage,
    waitIdle: waitIdleFor("classifier"),
    archiveThread,
    now: () => Date.now(),
    log: (message) => bb.log.info(message),
  });

  // A reload (update, restart) drops a run in progress but leaves its flag in
  // KV; clear it and pick the queue up again.
  void (async () => {
    const state = await readState();
    if (!state.running) return;
    await bb.storage.kv.set(KV.classifier, { ...state, running: false });
    bb.log.info("skill classifier: resuming after a reload");
    void classifier.run();
  })().catch((cause: unknown) => bb.log.warn(`skill classifier resume: ${String(cause)}`));

  let suggestToolsOn = false;
  void readConfig()
    .then((config) => {
      suggestToolsOn = config.skillsSuggestTools === true;
    })
    .catch(() => undefined);

  // One KV key per card: a KV value is capped at 256 KB, and all cards in one
  // value hit that cap at ~235 skills. 0.2.18 kept them under KV.cards; that
  // value is split into per-card keys on first read.
  const CARD_PREFIX = "skillCard:";

  async function migrateLegacyCards(): Promise<void> {
    const legacy = await bb.storage.kv.get<Record<string, StoredCard>>(KV.cards);
    if (legacy === undefined || legacy === null) return;
    for (const [name, card] of Object.entries(legacy)) {
      if ((await bb.storage.kv.get<StoredCard>(CARD_PREFIX + name)) === undefined) await bb.storage.kv.set(CARD_PREFIX + name, card);
    }
    await bb.storage.kv.delete(KV.cards);
  }

  let legacyMigrated: Promise<void> | null = null;
  async function readCards(): Promise<Record<string, StoredCard>> {
    legacyMigrated ??= migrateLegacyCards().catch((cause: unknown) => {
      legacyMigrated = null;
      throw cause;
    });
    await legacyMigrated;
    const keys = await bb.storage.kv.list(CARD_PREFIX);
    const values = await Promise.all(keys.map((key) => bb.storage.kv.get<StoredCard>(key)));
    const cards: Record<string, StoredCard> = {};
    keys.forEach((key, index) => {
      const value = values[index];
      if (value !== undefined && value !== null) cards[key.slice(CARD_PREFIX.length)] = value;
    });
    return cards;
  }

  /** Writes only the cards that changed and removes the ones that disappeared. */
  async function writeCardsDiff(before: Record<string, StoredCard>, after: Record<string, StoredCard>): Promise<void> {
    for (const [name, card] of Object.entries(after)) {
      if (JSON.stringify(before[name]) !== JSON.stringify(card)) await bb.storage.kv.set(CARD_PREFIX + name, card);
    }
    for (const name of Object.keys(before)) {
      if (!(name in after)) await bb.storage.kv.delete(CARD_PREFIX + name);
    }
  }

  let cardsLock: Promise<unknown> = Promise.resolve();
  function withCards<T>(fn: (cards: Record<string, StoredCard>) => Promise<{ cards: Record<string, StoredCard>; value: T }>): Promise<T> {
    const next = cardsLock.then(async () => {
      const before = await readCards();
      const result = await fn({ ...before });
      await writeCardsDiff(before, result.cards);
      rosterCache = null;
      return result.value;
    });
    cardsLock = next.catch(() => undefined);
    return next;
  }

  async function readSuggestLog(): Promise<SuggestLogEntry[]> {
    return (await bb.storage.kv.get<SuggestLogEntry[]>(KV.suggestLog)) ?? [];
  }

  // One read-modify-write at a time: dispatch hints log in the background and
  // several can land together.
  let logLock: Promise<unknown> = Promise.resolve();
  function pushLog(entry: SuggestLogEntry): Promise<void> {
    const next = logLock.then(async () => {
      await bb.storage.kv.set(KV.suggestLog, appendLog(await readSuggestLog(), entry));
    });
    logLock = next.catch(() => undefined);
    return next;
  }

  const hinted = new ThreadSkillMemory();

  /** One suggestion, logged. Null result means no Jev key. */
  async function runSuggest(args: {
    message: string;
    prevUser?: string;
    prevAssistant?: string;
    threadId: string | null;
    mode: SuggestLogMode;
  }) {
    const config = await readConfig();
    const key = config.jevApiKey.trim();
    if (key === "") return null;
    const log = await readSuggestLog();
    const now = Date.now();
    const suggested =
      args.threadId === null ? [] : [...new Set([...alreadySuggested(log, args.threadId, now), ...hinted.recent(args.threadId, now)])];
    const result = await suggest(createHttpJevClient({ apiKey: key, model: config.jevModel.trim() || "jev-1.14.0" }), await loadRoster(), {
      message: args.message,
      context: { prevUser: args.prevUser || undefined, prevAssistant: args.prevAssistant || undefined },
    }, {
      thresholds: {
        gate: parseThreshold(config.skillsSuggestGate, DEFAULT_THRESHOLDS.gate),
        fits: parseThreshold(config.skillsSuggestFits, DEFAULT_THRESHOLDS.fits),
      },
      exclude: parseExclude(config.skillsSuggestExclude || DEFAULT_EXCLUDE.join(", ")),
      alreadySuggested: suggested,
    });
    if (args.threadId !== null && result.skill !== null) hinted.record(args.threadId, result.skill, Date.now());
    const logged = pushLog({
      at: Date.now(),
      threadId: args.threadId,
      message: args.message.slice(0, 200),
      skill: result.skill,
      reason: result.reason ?? "ok",
      gate: result.gate,
      fitsMax: Object.values(result.fits).reduce((max, value) => Math.max(max, value), 0),
      shortlist: result.shortlist,
      tokens: result.tokens,
      ms: result.ms,
      mode: args.mode,
    });
    // A queued turn must not wait for the log write.
    if (args.mode === "dispatch") logged.catch((cause: unknown) => bb.log.warn(`skill suggest log: ${String(cause)}`));
    else await logged;
    return { result, skillRead: config.skillsSuggestTools === true };
  }

  // ------------------------------------------------- per-turn hint (dispatch)
  // The hook must answer synchronously, so the switch is cached and refreshed
  // in the background at most every few seconds.
  let injectOn: boolean | null = null;
  let injectReadAt = 0;
  async function readInject(): Promise<boolean> {
    const config = await readConfig();
    injectOn = config.skillsSuggestInject === true && config.jevApiKey.trim() !== "";
    // Keep the roster warm so a queued turn never waits for a cold build.
    if (injectOn) void loadRoster().catch(() => undefined);
    return injectOn;
  }
  function refreshInject(): void {
    if (Date.now() - injectReadAt < 5_000) return;
    injectReadAt = Date.now();
    void readInject().catch(() => undefined);
  }
  refreshInject();

  // Conversation context for Jev: the agent's last answer (from thread.idle)
  // and the user's previous message, kept in memory per thread.
  const lastAssistant = new Map<string, string>();
  const lastUser = new Map<string, string>();
  const CONTEXT_THREADS_MAX = 300;
  function remember(map: Map<string, string>, threadId: string, text: string): void {
    map.delete(threadId);
    map.set(threadId, text.slice(-4000));
    if (map.size > CONTEXT_THREADS_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  const injector = new SkillDispatchInjector({
    pluginId: bb.pluginId,
    enabled: () => {
      refreshInject();
      return injectOn;
    },
    ensureEnabled: async () => injectOn ?? (await readInject().catch(() => false)),
    suggest: async (threadId, text) => {
      let prevAssistant = lastAssistant.get(threadId);
      if (prevAssistant === undefined) {
        // Only after a plugin restart; a new thread has no output yet. Capped so
        // the queued turn is not held by a slow read.
        const output = (await Promise.race([
          bb.sdk.threads.output({ threadId }).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ])) as { output?: string | null } | null;
        prevAssistant = output?.output ?? "";
      }
      const prevUser = lastUser.get(threadId);
      remember(lastUser, threadId, text);
      const ran = await runSuggest({ message: text, prevUser, prevAssistant, threadId, mode: "dispatch" });
      if (ran === null || ran.result.skill === null) return null;
      return relevanceBlock(ran.result.skill, { skillRead: ran.skillRead });
    },
    updateRow: async (row, content) => {
      await bb.sdk.threads.queuedMessages.update({
        threadId: row.threadId,
        queuedMessageId: row.id,
        expectedUpdatedAt: row.updatedAt,
        input: content,
      } as unknown as Parameters<typeof bb.sdk.threads.queuedMessages.update>[0]);
    },
    isHidden: async (threadId) => {
      const found = (await bb.sdk.threads.get({ threadId }).catch(() => null)) as { visibility?: string; thread?: { visibility?: string } } | null;
      return (found?.thread?.visibility ?? found?.visibility) === "hidden";
    },
    recheck: () => bb.experimental_hooks.recheck("message.dispatch"),
    waitReason: () => t("Agent Tools: подбираю навык"),
    now: () => Date.now(),
    log: (message) => bb.log.info(message),
  });

  bb.experimental_hooks.on("message.dispatch", (context) => injector.decide(context as unknown as DispatchContext));
  bb.events.on("message.queued", ({ entry }) => injector.onQueued(entry as unknown as QueuedRow));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (lastAssistantText) remember(lastAssistant, thread.id, lastAssistantText);
  });

  // SKILL.md text only: readHubSkill also lists files and runs `git log` per
  // skill, which is far too slow for a per-turn suggestion over ~300 skills.
  async function skillContents(skills: HubSkill[]): Promise<Map<string, string>> {
    const texts = await Promise.all(
      skills.map(async (skill) => [skill.name, (await readHubSkillFile(root, skill.name, "SKILL.md")) ?? ""] as const),
    );
    return new Map(texts);
  }

  async function loadJobs(): Promise<CardJob[]> {
    const skills = await hubSkills(true);
    const store = await readStore();
    const descriptions = new Map(skills.map((skill) => [skill.name, skill.description ?? ""]));
    const contents = await skillContents(skills);
    const jobs: CardJob[] = [];
    for (const skill of skills) {
      if (skill.problems.some((problem) => problem.code === "no-skill-md")) continue;
      const content = contents.get(skill.name) ?? "";
      jobs.push({
        name: skill.name,
        description: skill.description ?? "",
        body: skillBody(content),
        siblings: formatSiblings(siblingsFor(skill.name, store, descriptions)),
        hash: contentHash(content),
        manual: content === "" ? undefined : (manualCard(content) ?? undefined),
      });
    }
    return jobs;
  }

  // The roster sits on the per-turn path: rebuilt at most once a minute, and
  // right away after a card is saved.
  const ROSTER_TTL_MS = 60_000;
  let rosterCache: { at: number; roster: RosterEntry[] } | null = null;

  // A cold build reads every SKILL.md (~1.5 s), too slow for a turn that is
  // waiting in the queue: a stale roster is served once while a fresh one is
  // built in the background, and concurrent builds share one promise.
  let rosterBuild: Promise<RosterEntry[]> | null = null;
  function buildRoster(): Promise<RosterEntry[]> {
    rosterBuild ??= (async () => {
      const skills = (await hubSkills()).filter((skill) => !skill.problems.some((problem) => problem.code === "no-skill-md"));
      const [cards, contents] = await Promise.all([readCards(), skillContents(skills)]);
      const roster = skills.map((skill) => {
        const content = contents.get(skill.name) ?? "";
        return {
          name: skill.name,
          description: skill.description ?? "",
          body: skillBody(content),
          card: (content !== "" ? manualCard(content) : undefined) ?? cards[skill.name]?.card,
        };
      });
      rosterCache = { at: Date.now(), roster };
      return roster;
    })().finally(() => {
      rosterBuild = null;
    });
    return rosterBuild;
  }

  async function loadRoster(): Promise<RosterEntry[]> {
    if (rosterCache === null) return buildRoster();
    if (Date.now() - rosterCache.at >= ROSTER_TTL_MS) void buildRoster().catch(() => undefined);
    return rosterCache.roster;
  }

  async function readCardWriterState() {
    return { ...EMPTY_CARD_WRITER_STATE, ...((await bb.storage.kv.get<typeof EMPTY_CARD_WRITER_STATE>(KV.cardWriter)) ?? {}) };
  }

  const cardWriter = new SkillCardWriter({
    readJobs: loadJobs,
    readCards,
    // Merge, never replace: a snapshot taken before a concurrent save must not drop it.
    writeCards: (cards) => withCards(async (current) => ({ cards: { ...current, ...cards }, value: undefined })),
    readState: readCardWriterState,
    writeState: (state) => bb.storage.kv.set(KV.cardWriter, state),
    spawnThread: (prompt) => spawnHidden("Agent Tools: skill cards", CARD_WRITER_ROLE, prompt),
    sendMessage,
    waitIdle: waitIdleFor("skill card writer"),
    archiveThread,
    now: () => Date.now(),
    log: (message) => bb.log.info(message),
  });

  void (async () => {
    const state = await readCardWriterState();
    if (!state.running) return;
    await bb.storage.kv.set(KV.cardWriter, { ...state, running: false });
    bb.log.info("skill card writer: resuming after a reload");
    void cardWriter.run();
  })().catch((cause: unknown) => bb.log.warn(`skill card writer resume: ${String(cause)}`));

  // ------------------------------------------------------------- tools
  bb.agents.registerTool({
    name: TOOL_TREE,
    description:
      "Agent Tools skill classifier: returns the current two-level category tree (section → subsection) with the number of skills in each subsection.",
    parameters: z.object({}),
    execute: async () => treeForModel(await readStore()),
  });

  bb.agents.registerTool({
    name: TOOL_ASSIGN,
    description:
      "Agent Tools skill classifier: places one skill into a section/subsection, creating either when missing. Russian names, English titles in sectionEn/subsectionEn. confidence 0..1.",
    parameters: z.object({
      skill: z.string().min(1).max(120),
      section: z.string().min(1).max(60),
      subsection: z.string().min(1).max(60),
      sectionEn: z.string().max(60).optional(),
      subsectionEn: z.string().max(60).optional(),
      confidence: z.number().min(0).max(1),
      reason: z.string().max(300).optional(),
    }),
    execute: async (params) => {
      const names = (await hubSkills()).map((skill) => skill.name);
      const outcome = await withStore(async (store) => {
        const result = applyModelAssign(store, params, names, Date.now());
        return { store: result.store, value: result.outcome };
      });
      if (outcome.kind === "rejected") return { content: [{ type: "text", text: `Rejected: ${outcome.message}` }], isError: true };
      if (outcome.kind === "review") return `Saved for manual review: ${params.skill}.`;
      const created = outcome.created.length > 0 ? ` Created: ${outcome.created.join("; ")}.` : "";
      return `Placed ${params.skill} into ${params.section} / ${params.subsection}.${created}`;
    },
  });

  bb.agents.registerTool({
    name: TOOL_CARD_SAVE,
    description:
      "Agent Tools card writer: saves the routing card for one hub skill (does, not_for, neighbors, examples, triggers_ru).",
    parameters: z.object({
      skill: z.string().min(1).max(120),
      card: skillCardSchema,
    }),
    execute: async (params) => {
      const jobs = new Map((await loadJobs()).map((job) => [job.name, job]));
      const outcome = await withCards(async (cards) => {
        const result = applyCardSave(cards, params, jobs, Date.now());
        return { cards: result.cards, value: result };
      });
      if (outcome.outcome === "rejected") {
        return { content: [{ type: "text", text: `Rejected: ${outcome.message}` }], isError: true };
      }
      return outcome.message;
    },
  });

  bb.agents.registerTool({
    name: "skills_find",
    description:
      "Find the BB skills that fit a task. Returns up to `limit` skills ranked for the query with what each does and is not for. Call it before a task that may need a specific tool, service or procedure, then read the chosen one with skill_read.",
    parameters: z.object({
      query: z.string().min(1).max(2000),
      context: z.string().max(2000).optional(),
      limit: z.number().min(1).max(10).optional(),
    }),
    execute: async ({ query, context, limit }) => {
      const started = Date.now();
      const config = await readConfig();
      suggestToolsOn = config.skillsSuggestTools === true;
      const roster = await loadRoster();
      const cap = limit ?? 5;
      const client = config.jevApiKey.trim() === "" ? null : createHttpJevClient({ apiKey: config.jevApiKey.trim(), model: config.jevModel.trim() || "jev-1.14.0" });
      let candidates: Awaited<ReturnType<typeof find>> = [];
      let note = "";
      try {
        candidates = client === null ? keywordFind(roster, query, cap) : await find(client, roster, query, context, cap);
        if (client === null) note = "Jev is not configured; ranked by keyword match.\n";
      } catch (cause) {
        candidates = [];
        note = `Skill search failed open: ${cause instanceof Error ? cause.message : String(cause)}\n`;
      }
      const fitsMax = candidates.reduce((max, item) => Math.max(max, item.fits), 0);
      await pushLog({
        at: Date.now(),
        threadId: null,
        message: query.slice(0, 200),
        skill: candidates[0]?.name ?? null,
        reason: client === null ? "keyword" : "find",
        gate: 0,
        fitsMax,
        shortlist: candidates.map((item) => item.name),
        tokens: 0,
        ms: Date.now() - started,
        mode: "tool",
      });
      return `${note}${formatFindList(candidates)}`;
    },
  });

  bb.agents.registerTool({
    name: "skill_read",
    description: "Read a BB skill's SKILL.md, or a file it references, from the BB hub.",
    parameters: z.object({
      name: z.string().min(1).max(120),
      file: z.string().max(500).optional(),
    }),
    execute: async ({ name, file }) => {
      if (file !== undefined && file !== "") {
        const text = await readHubSkillFile(root, name, file);
        if (text === null) return { content: [{ type: "text", text: `unknown skill file ${name}/${file}` }], isError: true };
        return text.length > SKILL_READ_MAX ? text.slice(0, SKILL_READ_MAX) : text;
      }
      const detail = await readHubSkill(root, name);
      if (detail === null) return { content: [{ type: "text", text: `unknown skill ${name}` }], isError: true };
      const content = detail.content ?? "";
      const files = detail.fileList.map((item) => `- ${item.path}`).join("\n");
      const body = `${content.slice(0, SKILL_READ_MAX)}\n\nFiles:\n${files === "" ? "- (none)" : files}`;
      return body.length > SKILL_READ_MAX ? body.slice(0, SKILL_READ_MAX) : body;
    },
  });

  /** Tools and instructions for hidden helper threads; public find/read tools are listed separately. */
  function configureThread(pluginMetadata: Readonly<Record<string, unknown>>): { tools: string[]; instructions?: string } | null {
    if (pluginMetadata.role === CLASSIFIER_ROLE) {
      return {
        tools: [TOOL_TREE, TOOL_ASSIGN],
        instructions: `You are the Agent Tools skill classifier. Use only ${TOOL_TREE} and ${TOOL_ASSIGN}.`,
      };
    }
    if (pluginMetadata.role === CARD_WRITER_ROLE) {
      return {
        tools: [TOOL_CARD_SAVE],
        instructions: `You are the Agent Tools skill card writer. Use only ${TOOL_CARD_SAVE}.`,
      };
    }
    return null;
  }

  function publicTools(): string[] {
    void readConfig()
      .then((config) => {
        suggestToolsOn = config.skillsSuggestTools === true;
      })
      .catch(() => undefined);
    return suggestToolsOn ? [...SUGGEST_TOOLS] : [];
  }

  // ------------------------------------------------------------- machines
  async function refreshMachines(): Promise<MachineHomes[]> {
    const hosts = (await bb.sdk.hosts.list()) as unknown as Array<{ id: string; name: string; status?: string }>;
    const result: MachineHomes[] = [];
    for (const item of hosts) {
      try {
        const homes = (await host.call("skill_homes_count", {}, { hostId: item.id, timeoutMs: 60_000 })) as {
          homes: MachineHomes["homes"];
          found?: MachineHomes["notOnHub"];
        };
        const onHub = new Set((await hubSkills()).map((skill) => skill.name));
        result.push({
          hostId: item.id,
          hostName: item.name,
          homes: homes.homes,
          notOnHub: (homes.found ?? []).filter((skill) => !onHub.has(skill.name)),
          error: null,
          at: Date.now(),
        });
      } catch (cause) {
        result.push({
          hostId: item.id,
          hostName: item.name,
          homes: [],
          notOnHub: [],
          error: cause instanceof Error ? cause.message.slice(0, 200) : String(cause),
          at: Date.now(),
        });
      }
    }
    await bb.storage.kv.set(KV.machines, result);
    return result;
  }

  // ------------------------------------------------------------- views
  async function view(fresh = false): Promise<SkillsHub> {
    const available = (await stat(root).catch(() => null)) !== null;
    const [skills, store, git, state, machines, config] = await Promise.all([
      available ? hubSkills(fresh) : Promise.resolve([] as HubSkill[]),
      readStore(),
      hubGitState(root),
      readState(),
      bb.storage.kv.get<MachineHomes[]>(KV.machines),
      readConfig(),
    ]);
    const byName = new Map(store.assignments.map((item) => [item.skill, item]));
    const reviewByName = new Map(store.review.map((item) => [item.skill, item]));
    return {
      available,
      root,
      git,
      skills: skills.map((skill) => {
        const placed = byName.get(skill.name);
        const valid = placed !== undefined && locate(store.tree, placed.sectionId, placed.subsectionId) !== null;
        const review = reviewByName.get(skill.name);
        return {
          ...skill,
          category: valid
            ? {
                sectionId: placed.sectionId,
                subsectionId: placed.subsectionId,
                source: placed.source,
                confidence: placed.confidence,
                reason: placed.reason,
              }
            : null,
          review: review === undefined ? null : { section: review.section, subsection: review.subsection, confidence: review.confidence, reason: review.reason },
        };
      }),
      tree: store.tree,
      classifier: { ...state, running: state.running || classifier.busy, model: config.classifierModel || `${config.classifierProvider} (default)` },
      offerCleanup: config.offerCleanup,
      machines: (machines ?? []).map((machine) => ({
        ...machine,
        notOnHub: (machine.notOnHub ?? []).filter((skill) => !skills.some((item) => item.name === skill.name)),
      })),
    };
  }

  function kick(): void {
    void classifier.run().then(() => cardWriter.run());
  }

  function kickCards(): void {
    void cardWriter.run();
  }

  async function moveSkill(skill: string, sectionId: string, subsectionId: string): Promise<void> {
    await withStore(async (store) => {
      if (locate(store.tree, sectionId, subsectionId) === null) throw new Error("unknown category");
      const { assignments } = upsertAssignment(store.assignments, {
        skill,
        sectionId,
        subsectionId,
        source: "manual",
        confidence: null,
        reason: null,
        at: Date.now(),
      });
      return { store: { ...store, assignments, review: store.review.filter((item) => item.skill !== skill) }, value: undefined };
    });
  }

  async function acceptReview(skill: string): Promise<void> {
    await withStore(async (store) => {
      const item = store.review.find((entry) => entry.skill === skill);
      if (item === undefined || item.section === "" || item.subsection === "") throw new Error("no proposal to accept");
      const ensured = ensurePath(store.tree, { section: item.section, subsection: item.subsection });
      const { assignments } = upsertAssignment(store.assignments, {
        skill,
        sectionId: ensured.sectionId,
        subsectionId: ensured.subsectionId,
        source: "manual",
        confidence: item.confidence,
        reason: item.reason,
        at: Date.now(),
      });
      return {
        store: { tree: ensured.tree, assignments, review: store.review.filter((entry) => entry.skill !== skill) },
        value: undefined,
      };
    });
  }

  async function publishFromHost(hostId: string, dir: string, dryRun: boolean, source: string) {
    const packed = (await host.call("skill_pack", { path: dir }, { hostId, timeoutMs: 120_000 })) as {
      ok: boolean;
      name: string | null;
      archiveBase64: string | null;
      error: string | null;
    };
    if (!packed.ok || packed.archiveBase64 === null) {
      return { ok: false, name: packed.name, replaced: false, problems: [], commit: null, error: packed.error ?? "pack failed" };
    }
    const result = await publishArchive(root, packed.archiveBase64, source, { dryRun });
    invalidate();
    if (result.ok && !dryRun) kick();
    return result;
  }

  async function pullToHost(name: string, hostId: string, target: string | null) {
    try {
      const archiveBase64 = await packHubSkill(root, name);
      return (await host.call("skill_unpack", { name, archiveBase64, target }, { hostId, timeoutMs: 120_000 })) as {
        ok: boolean;
        path: string | null;
        error: string | null;
      };
    } catch (cause) {
      return { ok: false, path: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** Publishes the skills a machine has and the hub lacks, one by one. */
  async function importFromMachine(hostId: string, names: string[] | null, dryRun = false) {
    const machines = (await bb.storage.kv.get<MachineHomes[]>(KV.machines)) ?? (await refreshMachines());
    const machine = machines.find((item) => item.hostId === hostId);
    if (machine === undefined) throw new Error("unknown machine; refresh the machines first");
    const onHub = new Set((await hubSkills(true)).map((skill) => skill.name));
    const todo = (machine.notOnHub ?? []).filter((skill) => !onHub.has(skill.name) && (names === null || names.includes(skill.name)));
    const results: Array<{ name: string; ok: boolean; error: string | null; problems: Array<{ code: string; detail: string; blocking: boolean }> }> = [];
    for (const skill of todo) {
      const result = await publishFromHost(hostId, skill.path, dryRun, `import from ${machine.hostName}`);
      results.push({ name: skill.name, ok: result.ok, error: result.error, problems: result.problems });
    }
    if (!dryRun) {
      invalidate();
      await refreshMachines();
    }
    return results;
  }

  // First open after install: nothing was counted yet, so look at the machines now.
  void (async () => {
    if ((await bb.storage.kv.get<MachineHomes[]>(KV.machines)) === null) await refreshMachines();
  })().catch((cause: unknown) => bb.log.warn(`skills machines first scan: ${String(cause)}`));

  async function settingsView() {
    const config = await readConfig();
    const providers = ((await bb.sdk.providers.list().catch(() => [])) as unknown as Array<{ id: string; displayName?: string; available?: boolean }>).map(
      (item) => ({ id: item.id, label: item.displayName ?? item.id, available: item.available !== false }),
    );
    const projectList = (await bb.sdk.projects.list().catch(() => [])) as unknown as
      | Array<{ id: string; name?: string; kind?: string }>
      | { projects: Array<{ id: string; name?: string; kind?: string }> };
    const projects = (Array.isArray(projectList) ? projectList : projectList.projects).map((item) => ({
      id: item.id,
      name: item.kind === "personal" ? `${item.name ?? item.id} (personal)` : (item.name ?? item.id),
    }));
    return {
      provider: config.classifierProvider,
      model: config.classifierModel,
      auto: config.classifierAuto,
      projectId: config.classifierProjectId,
      offerCleanup: config.offerCleanup,
      providers,
      projects,
    };
  }

  async function providerModels(providerId: string) {
    try {
      const result = (await bb.sdk.providers.models({ providerId })) as unknown as
        | Array<{ id: string; model?: string; displayName?: string; description?: string }>
        | { models?: Array<{ id: string; model?: string; displayName?: string; description?: string }> };
      const list = Array.isArray(result) ? result : (result.models ?? []);
      return {
        models: list.map((item) => ({
          id: item.model ?? item.id,
          label: item.displayName ?? item.model ?? item.id,
          description: item.description ?? "",
        })),
        error: null,
      };
    } catch (cause) {
      return { models: [], error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) };
    }
  }

  const handlers = {
    skills_settings: async () => settingsView(),
    skills_settings_set: async (input: { provider?: string; model?: string; auto?: boolean; projectId?: string; offerCleanup?: boolean }) => {
      const before = await readConfig();
      await saveConfig({
        ...(input.provider !== undefined ? { skillsClassifierProvider: input.provider } : {}),
        ...(input.model !== undefined ? { skillsClassifierModel: input.model } : {}),
        ...(input.auto !== undefined ? { skillsClassifierAuto: input.auto } : {}),
        ...(input.projectId !== undefined ? { skillsClassifierProjectId: input.projectId } : {}),
        ...(input.offerCleanup !== undefined ? { skillsOfferCleanup: input.offerCleanup } : {}),
      });
      const after = await readConfig();
      // A new model or provider starts a new classifier thread with the next skill.
      if (after.classifierProvider !== before.classifierProvider || after.classifierModel !== before.classifierModel) {
        const state = await readState();
        await bb.storage.kv.set(KV.classifier, { ...state, threadId: null, count: 0 });
      }
      return settingsView();
    },
    skills_provider_models: async ({ providerId }: { providerId: string }) => providerModels(providerId),
    skills_hub: async () => view(),
    skills_hub_detail: async ({ name }: { name: string }) => {
      const detail = await readHubSkill(root, name);
      if (detail === null) return null;
      const hub = await view();
      const row = hub.skills.find((skill) => skill.name === name);
      return { ...detail, category: row?.category ?? null, review: row?.review ?? null };
    },
    skills_hub_file: async ({ name, path }: { name: string; path: string }) => ({ text: await readHubSkillFile(root, name, path) }),
    skills_move: async ({ skill, sectionId, subsectionId }: { skill: string; sectionId: string; subsectionId: string }) => {
      await moveSkill(skill, sectionId, subsectionId);
      return view();
    },
    skills_review_accept: async ({ skill }: { skill: string }) => {
      await acceptReview(skill);
      return view();
    },
    skills_category_create: async ({ section, subsection }: { section: string; subsection: string }) => {
      await withStore(async (store) => ({ store: { ...store, tree: ensurePath(store.tree, { section, subsection }).tree }, value: undefined }));
      return view();
    },
    skills_category_rename: async ({ id, title }: { id: string; title: string }) => {
      await withStore(async (store) => ({ store: { ...store, tree: renameCategory(store.tree, id, title) }, value: undefined }));
      return view();
    },
    skills_category_remove: async ({ id }: { id: string }) => {
      await withStore(async (store) => ({ store: { ...store, tree: removeCategory(store.tree, id, store.assignments) }, value: undefined }));
      return view();
    },
    skills_classify: async () => {
      kick();
      return view();
    },
    skills_remove: async ({ name }: { name: string }) => {
      const result = await removeHubSkill(root, name, "Agent Tools UI");
      invalidate();
      return { ok: result.ok, error: result.error ?? result.commit?.error ?? null, hub: await view(true) };
    },
    skills_pull: async ({ name, hostId, target }: { name: string; hostId: string; target: string | null }) => pullToHost(name, hostId, target),
    skills_publish: async ({ hostId, path, dryRun }: { hostId: string; path: string; dryRun: boolean }) =>
      publishFromHost(hostId, path, dryRun, "Agent Tools UI"),
    skills_machines_refresh: async () => {
      await refreshMachines();
      return view();
    },
    skills_machines_import: async ({ hostId, names }: { hostId: string; names: string[] | null }) => {
      const results = await importFromMachine(hostId, names);
      return { results, hub: await view(true) };
    },
    skills_machines_cleanup: async ({ hostId, dryRun }: { hostId: string; dryRun: boolean }) => {
      const result = (await host.call("skill_homes_cleanup", { dryRun }, { hostId, timeoutMs: 180_000 })) as {
        backup: string | null;
        moved: Array<{ id: string; count: number }>;
        errors: string[];
      };
      if (!dryRun) await refreshMachines();
      return { ...result, hub: await view() };
    },
  };

  // ------------------------------------------------------------- cli
  async function hostIdByName(value: string | null): Promise<string | null> {
    if (value === null) return null;
    const hosts = (await bb.sdk.hosts.list()) as unknown as Array<{ id: string; name: string }>;
    const needle = value.toLowerCase();
    return hosts.find((item) => item.id === value || item.name.toLowerCase() === needle)?.id ?? null;
  }

  function flag(args: string[], name: string): string | null {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
  }

  /** Handles the hub skill subcommands; null means "not mine". */
  async function cli(command: string, args: string[], callerHostId: string | null, callerThreadId: string | null = null): Promise<string | null> {
    const json = args.includes("--json");
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--host") && !args[index - 1]?.startsWith("--to"));
    const hostId = (await hostIdByName(flag(args, "--host"))) ?? callerHostId;
    switch (command) {
      case "skills-hub": {
        const hub = await view(true);
        if (json) return JSON.stringify(hub, null, 2);
        const blocked = hub.skills.filter((skill) => skill.problems.some((problem) => problem.blocking));
        const unplaced = hub.skills.filter((skill) => skill.category === null && skill.review === null);
        const lines = [
          tp("Навыки на хабе: {0} ({1})", hub.skills.length, hub.root),
          hub.git.isRepo
            ? tp("git: {0} {1}, незакоммичено {2}", hub.git.branch ?? "?", hub.git.head?.sha ?? "?", hub.git.dirty)
            : t("git: папка не под git"),
          tp("Без категории: {0}, на проверке: {1}, BB не примет: {2}", unplaced.length, hub.skills.filter((skill) => skill.review !== null).length, blocked.length),
        ];
        for (const skill of blocked) {
          lines.push(`  ✗ ${skill.name}: ${skill.problems.filter((problem) => problem.blocking).map((problem) => problem.detail).join("; ")}`);
        }
        for (const machine of hub.machines.filter((item) => item.homes.length > 0)) {
          lines.push(
            tp("Копии на машине {0}: {1}", machine.hostName, machine.homes.map((home) => `${home.path} ${home.skills + home.links}`).join(", ")),
          );
        }
        return lines.join("\n");
      }
      case "skills-tree": {
        const hub = await view();
        if (json) return JSON.stringify({ tree: hub.tree, skills: hub.skills.map((skill) => ({ name: skill.name, category: skill.category })) }, null, 2);
        const counts = new Map<string, number>();
        for (const skill of hub.skills) if (skill.category) counts.set(skill.category.subsectionId, (counts.get(skill.category.subsectionId) ?? 0) + 1);
        const lines = [treeOutline(hub.tree, counts)];
        if (args.includes("--skills")) {
          lines.push("");
          for (const section of hub.tree.sections) {
            for (const sub of section.subsections) {
              const names = hub.skills.filter((skill) => skill.category?.subsectionId === sub.id).map((skill) => skill.name);
              if (names.length > 0) lines.push(`${section.title} / ${sub.title}: ${names.join(", ")}`);
            }
          }
        }
        return lines.join("\n");
      }
      case "skills-publish": {
        const dir = positional[0];
        if (dir === undefined) return t("Укажите папку навыка: bb tools skills-publish <папка> [--host <машина>] [--dry-run]");
        if (hostId === null) return t("Не удалось определить машину: укажите --host");
        const result = await publishFromHost(hostId, dir, dryRun, `bb tools on ${hostId}`);
        if (json) return JSON.stringify(result, null, 2);
        if (!result.ok) {
          return [tp("Не опубликовано: {0}", result.error ?? ""), ...result.problems.map((problem) => `  - ${problem.detail}`)].join("\n");
        }
        const commit = result.commit;
        return [
          dryRun ? tp("Проверка пройдена: {0} можно публиковать", result.name ?? "") : tp("Опубликовано на хаб: {0}", result.name ?? ""),
          ...result.problems.map((problem) => `  ! ${problem.detail}`),
          commit === null
            ? ""
            : commit.pushed
              ? tp("git: коммит {0} отправлен", commit.sha ?? "")
              : tp("git: коммит {0}, push не прошёл: {1}", commit.sha ?? "", commit.error ?? ""),
        ]
          .filter((line) => line !== "")
          .join("\n");
      }
      case "skills-pull": {
        const name = positional[0];
        if (name === undefined) return t("Укажите навык: bb tools skills-pull <навык> [--to <папка>] [--host <машина>]");
        if (hostId === null) return t("Не удалось определить машину: укажите --host");
        const result = await pullToHost(name, hostId, flag(args, "--to"));
        return result.ok ? tp("Навык скопирован в {0}", result.path ?? "") : tp("Не удалось: {0}", result.error ?? "");
      }
      case "skills-move": {
        const [skill, target] = positional;
        if (skill === undefined || target === undefined || !target.includes("/")) {
          return t("Формат: bb tools skills-move <навык> \"Раздел/Подраздел\"");
        }
        const [section, subsection] = target.split("/").map((part) => part.trim());
        const ids = await withStore(async (store) => {
          const ensured = ensurePath(store.tree, { section, subsection });
          return { store: { ...store, tree: ensured.tree }, value: ensured };
        });
        await moveSkill(skill, ids.sectionId, ids.subsectionId);
        return tp("{0} → {1} / {2}", skill, section, subsection);
      }
      case "skills-classify": {
        if (args.includes("--wait")) await classifier.run();
        else kick();
        const state = await readState();
        return args.includes("--wait")
          ? tp("Разложено моделью: {0}. Ошибка: {1}", state.lastPlaced, state.lastError ?? "—")
          : t("Классификация запущена в фоне; итог — bb tools skills-hub");
      }
      case "skills-remove": {
        const name = positional[0];
        if (name === undefined) return t("Укажите навык: bb tools skills-remove <навык>");
        const result = await removeHubSkill(root, name, "bb tools");
        invalidate();
        return result.ok ? tp("Убрано с хаба в архив: {0}", result.backup ?? "") : tp("Не удалось: {0}", result.error ?? "");
      }
      case "skills-machines": {
        const machines = await refreshMachines();
        if (json) return JSON.stringify(machines, null, 2);
        return machines
          .map((machine) =>
            machine.error !== null
              ? `${machine.hostName}: ${machine.error}`
              : machine.homes.length === 0
                ? tp("{0}: чисто", machine.hostName)
                : `${machine.hostName}: ${machine.homes.map((home) => `${home.path} ${home.skills}+${home.links}`).join(", ")}` +
                  (machine.notOnHub.length > 0 ? tp("; нет на хабе: {0}", machine.notOnHub.length) : ""),
          )
          .join("\n");
      }
      case "skills-import": {
        if (hostId === null) return t("Укажите машину: bb tools skills-import --host <машина> [--dry-run]");
        await refreshMachines();
        const results = await importFromMachine(hostId, positional.length > 0 ? positional : null, dryRun);
        if (json) return JSON.stringify(results, null, 2);
        if (results.length === 0) return t("На этой машине нет навыков, которых не хватает на хабе");
        return [
          dryRun ? t("Проверка переноса на хаб:") : t("Перенос на хаб:"),
          ...results.map((item) =>
            item.ok ? `  ✓ ${item.name}` : `  ✗ ${item.name}: ${item.problems.filter((problem) => problem.blocking).map((problem) => problem.detail).join("; ") || item.error}`,
          ),
        ].join("\n");
      }
      case "skills-cleanup": {
        if (hostId === null) return t("Укажите машину: bb tools skills-cleanup --host <машина> [--dry-run]");
        const result = (await host.call("skill_homes_cleanup", { dryRun }, { hostId, timeoutMs: 180_000 })) as {
          backup: string | null;
          moved: Array<{ id: string; count: number }>;
          errors: string[];
        };
        if (!dryRun) await refreshMachines();
        return [
          dryRun ? t("Будет перенесено в архив:") : tp("Перенесено в архив {0}:", result.backup ?? ""),
          ...result.moved.map((item) => `  ${item.id}: ${item.count}`),
          ...result.errors.map((error) => `  ✗ ${error}`),
        ].join("\n");
      }
      case "skills-suggest": {
        const config = await readConfig();
        suggestToolsOn = config.skillsSuggestTools === true;
        // The handler runs in the BB server, not in the calling CLI process, so
        // there is no caller stdin here: hooks pass every field as an argument.
        const message = flag(args, "--message") ?? "";
        if (message.trim() === "") {
          return t("Укажите сообщение: bb tools skills-suggest --message <текст> [--json]");
        }
        const ran = await runSuggest({
          message,
          prevUser: flag(args, "--prev-user") ?? "",
          prevAssistant: flag(args, "--prev-assistant") ?? "",
          threadId: flag(args, "--thread") ?? callerThreadId,
          mode: "cli",
        });
        if (ran === null) {
          if (json) return JSON.stringify({ skill: null, reason: "error", error: "no Jev key" }, null, 2);
          return t("Ключ TypeSafe (Jev) не задан");
        }
        if (json) return JSON.stringify(ran.result, null, 2);
        return relevanceBlock(ran.result.skill);
      }
      case "skills-cards": {
        const show = flag(args, "--show");
        if (show !== null) {
          const stored = (await readCards())[show];
          if (stored === undefined) return tp("Карточки для {0} нет", show);
          return JSON.stringify(stored, null, 2);
        }
        if (args.includes("--refresh")) {
          if (args.includes("--wait")) await cardWriter.run();
          else kickCards();
        }
        const jobs = await loadJobs();
        const stats = cardStats(
          jobs.map((job) => job.name),
          new Map(jobs.map((job) => [job.name, job.hash])),
          await readCards(),
        );
        if (json) return JSON.stringify(stats, null, 2);
        const started = args.includes("--refresh") && !args.includes("--wait") ? t("Обновление карточек запущено в фоне.") + "\n" : "";
        return (
          started +
          tp(
            "Навыки: {0}. Карточек: свежих {1}, устаревших {2}, ручных {3}, нет {4}",
            stats.total,
            stats.fresh,
            stats.stale,
            stats.manual,
            stats.missing,
          )
        );
      }
      case "skills-suggest-log": {
        const rawLimit = flag(args, "--limit");
        const parsed = rawLimit === null ? 50 : Number(rawLimit);
        const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(500, Math.floor(parsed)) : 50;
        const entries = (await readSuggestLog()).slice(-limit);
        if (json) return JSON.stringify(entries, null, 2);
        if (entries.length === 0) return t("Журнал подбора пуст");
        return entries
          .map((entry) => {
            const when = new Date(entry.at).toISOString();
            const skill = entry.skill ?? "—";
            return `${when}  ${entry.reason}  ${skill}  gate ${entry.gate.toFixed(2)}  ${entry.message}`;
          })
          .join("\n");
      }
      default:
        return null;
    }
  }

  return { handlers, cli, configureThread, publicTools, kick, kickCards, refreshMachines, view };
}

export const SKILLS_CLI_USAGE = [
  "  bb tools skills-hub [--json]                Навыки на хабе: git, проблемы, копии на машинах",
  "  bb tools skills-tree [--skills] [--json]    Дерево категорий",
  "  bb tools skills-publish <папка> [--host <машина>] [--dry-run]  Опубликовать навык на хаб",
  "  bb tools skills-pull <навык> [--to <папка>] [--host <машина>]  Взять навык с хаба в работу",
  "  bb tools skills-move <навык> \"Раздел/Подраздел\"  Перенести навык вручную",
  "  bb tools skills-classify [--wait]           Разложить навыки без категории",
  "  bb tools skills-suggest --message <текст> [--prev-user <текст>] [--prev-assistant <текст>] [--thread <id>] [--json]  Какой навык подходит к сообщению",
  "  bb tools skills-cards [--refresh] [--wait] [--json] [--show <навык>]  Карточки маршрутизации навыков",
  "  bb tools skills-suggest-log [--limit N] [--json]  Журнал подбора навыков",
  "  bb tools skills-remove <навык>              Убрать навык с хаба в архив",
  "  bb tools skills-machines                    Копии навыков на машинах",
  "  bb tools skills-import --host <машина> [--dry-run]  Перенести на хаб навыки, которых там нет",
  "  bb tools skills-cleanup --host <машина> [--dry-run]  Убрать копии с машины в архив",
];
