import {
  EMPTY_CLASSIFIER_STATE,
  THREAD_MAX_AGE_MS,
  TURN_TIMEOUT_MS,
  type CategoryStore,
  type ClassifierState,
} from "../classifier.ts";
import { parseCard, type SkillCard, type StoredCard } from "./cards.ts";

export const TOOL_CARD_SAVE = "agent_tools_skill_card_save";
export const CARD_WRITER_ROLE = "agent-tools-card-writer";
export const CARD_BATCH = 10;
export const EMPTY_CARD_WRITER_STATE: ClassifierState = { ...EMPTY_CLASSIFIER_STATE };

export type CardJob = {
  name: string;
  description: string;
  body: string;
  siblings: string;
  hash: string;
  manual?: SkillCard;
};

export type CardWriterDeps = {
  readJobs(): Promise<CardJob[]>;
  readCards(): Promise<Record<string, StoredCard>>;
  writeCards(cards: Record<string, StoredCard>): Promise<void>;
  readState(): Promise<ClassifierState>;
  writeState(state: ClassifierState): Promise<void>;
  spawnThread(prompt: string): Promise<string>;
  sendMessage(threadId: string, text: string): Promise<void>;
  waitIdle(threadId: string, timeoutMs: number): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  now(): number;
  log(message: string): void;
};

const PROMPT = `You write a routing card for an AI agent skill. A small classifier reads the
card to decide whether this skill should be loaded for a user's request, so the card must
separate this skill from similar ones. Write English only, except triggers_ru.

Return the card by calling ${TOOL_CARD_SAVE} with:
{
  "does": "<= 220 chars: the concrete jobs this skill performs, verbs first",
  "not_for": "<= 160 chars: requests that look similar but belong elsewhere",
  "neighbors": "<= 200 chars: how it differs from the closest skills listed below, by name; empty if none is close",
  "examples": ["three short, realistic user requests (English) this skill should get"],
  "triggers_ru": ["up to 8 Russian words or short phrases a user would type for this job"]
}

Skill name: {name}
Skill description: {description}

Other skills in the same category (name: description):
{siblings}

SKILL.md (truncated):
{body}
`;

export function cardWriterIntro(): string {
  return [
    "You write routing cards for BB agent skills so a small classifier can pick the right skill for a user request.",
    `For every skill in the message, call ${TOOL_CARD_SAVE} exactly once with that skill's name and card.`,
    "Write English only, except triggers_ru. Do not read files, run commands or use other tools. Reply with one short line after the tool calls.",
  ].join("\n");
}

export function cardPrompt(job: CardJob): string {
  return PROMPT.replace("{name}", job.name)
    .replace("{description}", job.description.slice(0, 1500))
    .replace("{siblings}", job.siblings)
    .replace("{body}", job.body.slice(0, 6000));
}

export function formatSiblings(rows: readonly { name: string; description: string }[]): string {
  if (rows.length === 0) return "(none)";
  return rows
    .slice(0, 25)
    .map((row) => `- ${row.name}: ${row.description.slice(0, 160)}`)
    .join("\n");
}

export function cardStats(
  names: readonly string[],
  hashes: ReadonlyMap<string, string>,
  cards: Record<string, StoredCard>,
): { total: number; fresh: number; stale: number; manual: number; missing: number } {
  let fresh = 0;
  let stale = 0;
  let manual = 0;
  let missing = 0;
  for (const name of names) {
    const stored = cards[name];
    if (stored === undefined) {
      missing += 1;
      continue;
    }
    if (stored.source === "manual") manual += 1;
    if (stored.hash === hashes.get(name)) fresh += 1;
    else stale += 1;
  }
  return { total: names.length, fresh, stale, manual, missing };
}

export function siblingsFor(
  name: string,
  store: CategoryStore,
  descriptions: ReadonlyMap<string, string>,
): { name: string; description: string }[] {
  const assignment = store.assignments.find((item) => item.skill === name);
  if (assignment === undefined) return [];
  return store.assignments
    .filter((item) => item.subsectionId === assignment.subsectionId && item.skill !== name)
    .map((item) => ({ name: item.skill, description: descriptions.get(item.skill) ?? "" }))
    .slice(0, 25);
}

export function applyCardSave(
  cards: Record<string, StoredCard>,
  input: { skill: string; card: unknown },
  known: ReadonlyMap<string, CardJob>,
  now: number,
): { cards: Record<string, StoredCard>; outcome: "saved" | "rejected"; message: string } {
  const job = known.get(input.skill);
  if (job === undefined) {
    return { cards, outcome: "rejected", message: `unknown skill ${input.skill}` };
  }
  let card: SkillCard;
  try {
    card = parseCard(input.card);
  } catch (cause) {
    return { cards, outcome: "rejected", message: cause instanceof Error ? cause.message : String(cause) };
  }
  return {
    cards: {
      ...cards,
      [input.skill]: { card, hash: job.hash, source: "model", at: now },
    },
    outcome: "saved",
    message: `Saved card for ${input.skill}.`,
  };
}

export class SkillCardWriter {
  private active: Promise<void> | null = null;
  private readonly deps: CardWriterDeps;

  constructor(deps: CardWriterDeps) {
    this.deps = deps;
  }

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
      const jobs = await deps.readJobs();
      let cards = await deps.readCards();
      const manuals = jobs.filter((job) => job.manual !== undefined);
      if (manuals.length > 0) {
        const next = { ...cards };
        for (const job of manuals) {
          next[job.name] = { card: job.manual as SkillCard, hash: job.hash, source: "manual", at: deps.now() };
        }
        cards = next;
        await deps.writeCards(cards);
      }
      const queue = jobs.filter((job) => job.manual === undefined);
      for (let i = 0; i < queue.length; i += CARD_BATCH) {
        const batch = queue.slice(i, i + CARD_BATCH);
        cards = await deps.readCards();
        const pending = batch.filter((job) => cards[job.name]?.hash !== job.hash);
        if (pending.length === 0) continue;
        state = await this.writeBatch(pending, state);
        await deps.writeState(state);
      }
      state = { ...state, running: false, lastRunAt: deps.now() };
      await deps.writeState(state);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`skill card writer stopped: ${message}`);
      state = { ...state, running: false, lastRunAt: deps.now(), lastError: message.slice(0, 500) };
      await deps.writeState(state);
    }
  }

  private async writeBatch(batch: CardJob[], start: ClassifierState): Promise<ClassifierState> {
    const { deps } = this;
    let state = start;
    const now = deps.now();
    const stale = state.threadId === null || now - state.startedAt > THREAD_MAX_AGE_MS || state.count >= 60;
    const body = batch.map((job) => cardPrompt(job)).join("\n\n----\n\n");
    const message = `Write a card for each of these ${batch.length} skills.\n\n${body}`;
    // A kept thread can vanish under us (archived by hand, deleted): start a new one then.
    const reused = !stale && (await deps.sendMessage(state.threadId as string, message).then(() => true, () => false));
    if (reused) {
      state = { ...state, count: state.count + batch.length };
    } else {
      if (state.threadId !== null) await deps.archiveThread(state.threadId).catch(() => undefined);
      const threadId = await deps.spawnThread(`${cardWriterIntro()}\n\n${message}`);
      state = { ...state, threadId, startedAt: now, count: batch.length };
    }
    await deps.writeState(state);
    await deps.waitIdle(state.threadId as string, TURN_TIMEOUT_MS);
    const missing = await this.unwritten(batch);
    if (missing.length > 0) {
      await deps.sendMessage(
        state.threadId as string,
        `You did not call ${TOOL_CARD_SAVE} for: ${missing.join(", ")}. Call it once for each remaining skill.`,
      );
      await deps.waitIdle(state.threadId as string, TURN_TIMEOUT_MS);
    }
    const still = await this.unwritten(batch);
    return { ...state, lastPlaced: state.lastPlaced + (batch.length - still.length) };
  }

  private async unwritten(batch: CardJob[]): Promise<string[]> {
    const cards = await this.deps.readCards();
    return batch.filter((job) => cards[job.name]?.hash !== job.hash).map((job) => job.name);
  }
}
