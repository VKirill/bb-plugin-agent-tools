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

const machineHomesSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  homes: z.array(z.object({ id: z.string(), path: z.string(), skills: z.number(), links: z.number() })),
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
  skills_machines_refresh: { input: z.null(), output: skillsHubSchema },
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
};

const CACHE_MS = 15_000;
const KV = {
  tree: "skillTree",
  assignments: "skillAssignments",
  review: "skillReview",
  classifier: "skillClassifier",
  machines: "skillMachines",
} as const;

export function createSkillsHubService(
  bb: BbPluginApi,
  host: HostCaller,
  readConfig: () => Promise<SkillsHubConfig>,
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
    spawnThread: async (prompt) => {
      const config = await readConfig();
      const result = (await bb.sdk.threads.spawn({
        projectId: await personalProjectId(),
        providerId: config.classifierProvider,
        model: config.classifierModel,
        environment: { type: "project-default" },
        visibility: "hidden",
        title: "Agent Tools: skill categories",
        pluginMetadata: { role: CLASSIFIER_ROLE },
        prompt,
      } as Parameters<typeof bb.sdk.threads.spawn>[0])) as { id?: string; thread?: { id: string } };
      const id = result.thread?.id ?? result.id;
      if (id === undefined) throw new Error("BB did not return the classifier thread id");
      return id;
    },
    sendMessage: async (threadId, text) => {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text }] } as Parameters<typeof bb.sdk.threads.send>[0]);
    },
    waitIdle: async (threadId, timeoutMs) => {
      const started = Date.now();
      let seenBusy = false;
      await sleep(2000);
      while (Date.now() - started < timeoutMs) {
        const status = await threadStatus(threadId);
        if (status === "error") throw new Error("the classifier thread failed");
        if (status !== null && status !== "idle") seenBusy = true;
        if (status === "idle" && (seenBusy || Date.now() - started > 20_000)) return;
        await sleep(2000);
      }
      throw new Error("the classifier thread did not answer in time");
    },
    archiveThread: async (threadId) => {
      await (bb.sdk.threads as unknown as { archive(args: { threadId: string }): Promise<unknown> }).archive({ threadId });
    },
    now: () => Date.now(),
    log: (message) => bb.log.info(message),
  });

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

  /** Tools and instructions for the classifier's own threads; nothing for other threads. */
  function configureThread(pluginMetadata: Readonly<Record<string, unknown>>): { tools: string[]; instructions?: string } | null {
    if (pluginMetadata.role !== CLASSIFIER_ROLE) return null;
    return {
      tools: [TOOL_TREE, TOOL_ASSIGN],
      instructions: `You are the Agent Tools skill classifier. Use only ${TOOL_TREE} and ${TOOL_ASSIGN}.`,
    };
  }

  // ------------------------------------------------------------- machines
  async function refreshMachines(): Promise<MachineHomes[]> {
    const hosts = (await bb.sdk.hosts.list()) as unknown as Array<{ id: string; name: string; status?: string }>;
    const result: MachineHomes[] = [];
    for (const item of hosts) {
      try {
        const homes = (await host.call("skill_homes_count", {}, { hostId: item.id, timeoutMs: 30_000 })) as {
          homes: MachineHomes["homes"];
        };
        result.push({ hostId: item.id, hostName: item.name, homes: homes.homes, error: null, at: Date.now() });
      } catch (cause) {
        result.push({
          hostId: item.id,
          hostName: item.name,
          homes: [],
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
      classifier: { ...state, running: state.running || classifier.busy, model: config.classifierModel },
      machines: machines ?? [],
    };
  }

  function kick(): void {
    void classifier.run();
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

  const handlers = {
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
  async function cli(command: string, args: string[], callerHostId: string | null): Promise<string | null> {
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
                : `${machine.hostName}: ${machine.homes.map((home) => `${home.path} ${home.skills}+${home.links}`).join(", ")}`,
          )
          .join("\n");
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
      default:
        return null;
    }
  }

  return { handlers, cli, configureThread, kick, refreshMachines, view };
}

export const SKILLS_CLI_USAGE = [
  "  bb tools skills-hub [--json]                Навыки на хабе: git, проблемы, копии на машинах",
  "  bb tools skills-tree [--skills] [--json]    Дерево категорий",
  "  bb tools skills-publish <папка> [--host <машина>] [--dry-run]  Опубликовать навык на хаб",
  "  bb tools skills-pull <навык> [--to <папка>] [--host <машина>]  Взять навык с хаба в работу",
  "  bb tools skills-move <навык> \"Раздел/Подраздел\"  Перенести навык вручную",
  "  bb tools skills-classify [--wait]           Разложить навыки без категории",
  "  bb tools skills-remove <навык>              Убрать навык с хаба в архив",
  "  bb tools skills-machines                    Копии навыков на машинах",
  "  bb tools skills-cleanup --host <машина> [--dry-run]  Убрать копии с машины в архив",
];
