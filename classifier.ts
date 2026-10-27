import {
  CONFIDENCE_FLOOR,
  ensurePath,
  inferByFamily,
  locate,
  pruneMissing,
  treeOutline,
  unplacedSkills,
  upsertAssignment,
  type ReviewItem,
  type SkillAssignment,
  type SkillTree,
} from "./categories.ts";

/**
 * Places hub skills into the plugin's category tree. Skills without a
 * category are first matched by family; the rest go one by one, in order, to
 * one hidden BB thread running a small model. A thread older than an hour (or
 * one that has seen MAX_PER_THREAD skills) is archived and the next skill
 * starts a fresh one. The model answers by calling the plugin's tools, which
 * validate and store the placement.
 */

export const THREAD_MAX_AGE_MS = 60 * 60 * 1000;
export const MAX_PER_THREAD = 60;
export const TURN_TIMEOUT_MS = 4 * 60 * 1000;
export const TOOL_TREE = "agent_tools_skill_tree";
export const TOOL_ASSIGN = "agent_tools_skill_assign";
export const CLASSIFIER_ROLE = "skill-classifier";

export type CategoryStore = {
  tree: SkillTree;
  assignments: SkillAssignment[];
  review: ReviewItem[];
};

export type ClassifierState = {
  threadId: string | null;
  startedAt: number;
  count: number;
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  /** Skills placed by the model in the last run, for the status line. */
  lastPlaced: number;
};

export const EMPTY_CLASSIFIER_STATE: ClassifierState = {
  threadId: null,
  startedAt: 0,
  count: 0,
  running: false,
  lastRunAt: null,
  lastError: null,
  lastPlaced: 0,
};

export type ClassifierSkill = { name: string; description: string | null; excerpt: string };

export type ClassifierDeps = {
  readSkills(): Promise<ClassifierSkill[]>;
  readStore(): Promise<CategoryStore>;
  writeStore(store: CategoryStore): Promise<void>;
  readState(): Promise<ClassifierState>;
  writeState(state: ClassifierState): Promise<void>;
  /** Starts the hidden thread with the first message; returns its id. */
  spawnThread(prompt: string): Promise<string>;
  sendMessage(threadId: string, text: string): Promise<void>;
  /** Resolves when the thread is idle again; rejects on timeout. */
  waitIdle(threadId: string, timeoutMs: number): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  now(): number;
  log(message: string): void;
};

export function classifierIntro(): string {
  return [
    "You sort agent skills into a two-level category tree (section → subsection) for the Agent Tools plugin of BB.",
    "Each message names one skill with its description and the start of its SKILL.md.",
    `For every skill: call ${TOOL_TREE} to see the current tree, then call ${TOOL_ASSIGN} exactly once.`,
    "Rules:",
    "- Prefer an existing subsection. Create a new subsection only when none fits; create a new section only when the skill belongs to no section.",
    "- Category names are short and in Russian (1–4 words), with an English title in sectionEn/subsectionEn. Never go deeper than two levels.",
    "- Judge by what the skill is for, not by single words in it.",
    `- confidence is 0..1. Below ${CONFIDENCE_FLOOR} the skill goes to manual review and nothing is created.`,
    "- Do not read files, run commands or use other tools. Reply with one short line after the tool call.",
  ].join("\n");
}

export function skillMessage(skill: ClassifierSkill): string {
  return [
    `Skill: ${skill.name}`,
    `Description: ${skill.description ?? "(none)"}`,
    "Start of SKILL.md:",
    "```",
    skill.excerpt.slice(0, 4000),
    "```",
  ].join("\n");
}

function counts(store: CategoryStore): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of store.assignments) map.set(item.subsectionId, (map.get(item.subsectionId) ?? 0) + 1);
  return map;
}

/** Text the model gets from the tree tool. */
export function treeForModel(store: CategoryStore): string {
  return treeOutline(store.tree, counts(store));
}

export type AssignInput = {
  skill: string;
  section: string;
  subsection: string;
  sectionEn?: string;
  subsectionEn?: string;
  confidence: number;
  reason?: string;
};

export type AssignOutcome =
  | { kind: "placed"; sectionId: string; subsectionId: string; created: string[] }
  | { kind: "review" }
  | { kind: "rejected"; message: string };

/** Validates and stores the model's answer. Pure over the store. */
export function applyModelAssign(
  store: CategoryStore,
  input: AssignInput,
  knownSkills: readonly string[],
  now: number,
): { store: CategoryStore; outcome: AssignOutcome } {
  if (!knownSkills.includes(input.skill)) {
    return { store, outcome: { kind: "rejected", message: `unknown skill ${input.skill}` } };
  }
  const current = store.assignments.find((item) => item.skill === input.skill);
  if (current !== undefined) {
    return { store, outcome: { kind: "rejected", message: `${input.skill} already has a category; leave it` } };
  }
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
  const reason = input.reason?.slice(0, 300) ?? null;
  if (confidence < CONFIDENCE_FLOOR) {
    const review = [
      ...store.review.filter((item) => item.skill !== input.skill),
      { skill: input.skill, section: input.section, subsection: input.subsection, confidence, reason, at: now },
    ];
    return { store: { ...store, review }, outcome: { kind: "review" } };
  }
  let ensured;
  try {
    ensured = ensurePath(store.tree, input);
  } catch (cause) {
    return { store, outcome: { kind: "rejected", message: cause instanceof Error ? cause.message : String(cause) } };
  }
  const { assignments } = upsertAssignment(store.assignments, {
    skill: input.skill,
    sectionId: ensured.sectionId,
    subsectionId: ensured.subsectionId,
    source: "model",
    confidence,
    reason,
    at: now,
  });
  const created = [
    ...(ensured.createdSection ? [input.section] : []),
    ...(ensured.createdSubsection ? [`${input.section} / ${input.subsection}`] : []),
  ];
  return {
    store: { ...store, tree: ensured.tree, assignments, review: store.review.filter((item) => item.skill !== input.skill) },
    outcome: { kind: "placed", sectionId: ensured.sectionId, subsectionId: ensured.subsectionId, created },
  };
}

/** Family pass: places what siblings already decide. Returns the new store and how many were placed. */
export function placeByFamily(store: CategoryStore, skills: readonly string[], now: number): { store: CategoryStore; placed: number } {
  let assignments = store.assignments;
  let placed = 0;
  let progress = true;
  // A placed skill can complete the quorum for its siblings, so repeat until stable.
  while (progress) {
    progress = false;
    for (const name of unplacedSkills(skills, assignments, store.review)) {
      const hit = inferByFamily(name, assignments);
      if (hit === null || locate(store.tree, hit.sectionId, hit.subsectionId) === null) continue;
      assignments = upsertAssignment(assignments, {
        skill: name,
        sectionId: hit.sectionId,
        subsectionId: hit.subsectionId,
        source: "family",
        confidence: null,
        reason: null,
        at: now,
      }).assignments;
      placed += 1;
      progress = true;
    }
  }
  return { store: { ...store, assignments }, placed };
}

export class SkillClassifier {
  private active: Promise<void> | null = null;
  private readonly deps: ClassifierDeps;

  constructor(deps: ClassifierDeps) {
    this.deps = deps;
  }

  /** Starts a run unless one is in progress; resolves when that run ends. */
  run(): Promise<void> {
    if (this.active !== null) return this.active;
    this.active = this.runOnce().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  private async runOnce(): Promise<void> {
    const { deps } = this;
    let state: ClassifierState = { ...(await deps.readState()), running: true, lastError: null, lastPlaced: 0 };
    await deps.writeState(state);
    try {
      const skills = await deps.readSkills();
      const names = skills.map((skill) => skill.name);
      let store = await deps.readStore();
      store = {
        ...store,
        assignments: pruneMissing(store.assignments, names),
        review: pruneMissing(store.review, names),
      };
      const family = placeByFamily(store, names, deps.now());
      store = family.store;
      await deps.writeStore(store);
      const queue = unplacedSkills(names, store.assignments, store.review);
      for (const name of queue) {
        const skill = skills.find((item) => item.name === name);
        if (skill === undefined) continue;
        // Siblings placed a moment ago may already decide this one.
        const current = await deps.readStore();
        if (current.assignments.some((item) => item.skill === name) || current.review.some((item) => item.skill === name)) continue;
        const byFamily = placeByFamily(current, [name, ...current.assignments.map((item) => item.skill)], deps.now());
        if (byFamily.placed > 0) {
          await deps.writeStore(byFamily.store);
          continue;
        }
        state = await this.classifyOne(skill, state);
        await deps.writeState(state);
      }
      state = { ...state, running: false, lastRunAt: deps.now() };
      await deps.writeState(state);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`skill classifier stopped: ${message}`);
      state = { ...state, running: false, lastRunAt: deps.now(), lastError: message.slice(0, 500) };
      await deps.writeState(state);
    }
  }

  private async placed(name: string): Promise<boolean> {
    const store = await this.deps.readStore();
    return store.assignments.some((item) => item.skill === name) || store.review.some((item) => item.skill === name);
  }

  private async classifyOne(skill: ClassifierSkill, start: ClassifierState): Promise<ClassifierState> {
    const { deps } = this;
    let state = start;
    const now = deps.now();
    const stale = state.threadId === null || now - state.startedAt > THREAD_MAX_AGE_MS || state.count >= MAX_PER_THREAD;
    const message = skillMessage(skill);
    if (stale) {
      if (state.threadId !== null) await deps.archiveThread(state.threadId).catch(() => undefined);
      const threadId = await deps.spawnThread(`${classifierIntro()}\n\n${message}`);
      state = { ...state, threadId, startedAt: now, count: 1 };
    } else {
      await deps.sendMessage(state.threadId as string, message);
      state = { ...state, count: state.count + 1 };
    }
    await deps.writeState(state);
    await deps.waitIdle(state.threadId as string, TURN_TIMEOUT_MS);
    if (!(await this.placed(skill.name))) {
      await deps.sendMessage(
        state.threadId as string,
        `You did not call ${TOOL_ASSIGN} for ${skill.name}. Call ${TOOL_TREE}, then ${TOOL_ASSIGN} once for this skill.`,
      );
      await deps.waitIdle(state.threadId as string, TURN_TIMEOUT_MS);
    }
    if (!(await this.placed(skill.name))) {
      const store = await deps.readStore();
      await deps.writeStore({
        ...store,
        review: [
          ...store.review,
          { skill: skill.name, section: "", subsection: "", confidence: null, reason: "the model gave no answer", at: deps.now() },
        ],
      });
      return state;
    }
    return { ...state, lastPlaced: state.lastPlaced + 1 };
  }
}
