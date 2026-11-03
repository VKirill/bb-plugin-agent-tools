import { createHash } from "node:crypto";
import { cardFull, cardShort, type SkillCard } from "./cards.ts";
import type { JevAnswer, JevClient, JevQuestion, JevResponse } from "./jev.ts";

export const CHUNK = 200;
export const PER_CHUNK = 3;
export const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?";
export const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.";
export const GATE_QUESTIONS = {
  new_kind_of_task:
    "Does the latest message start a different kind of task (another tool, service, file format or workflow) rather than continue or correct the work just discussed?",
  needs_specific_instructions:
    "Would doing what the latest message asks require specific instructions for a particular tool, service, API, product or house method, beyond general coding and conversation skill?",
  only_ack_or_continue:
    "Is the latest message only an acknowledgement, an approval, a request to continue, or a question about what was already done?",
} as const;
export const INVERTED = new Set(["only_ack_or_continue"]);
export const DEFAULT_THRESHOLDS = { gate: 0.6, fits: 0.5 };
export const DEFAULT_EXCLUDE = [
  "project-life",
  "memory-discipline",
  "gitnexus-impact-analysis",
  "gitnexus-exploring",
  "gitnexus-debugging",
  "gitnexus-refactoring",
  "gitnexus-pr-review",
  "gitnexus-cli",
  "gitnexus-guide",
  "markdown-pro",
  "karpathy-guidelines",
  "writer-practices",
];

export type RosterEntry = { name: string; description: string; body: string; card?: SkillCard };
export type SuggestInput = { message: string; context?: { prevUser?: string; prevAssistant?: string } };
export type Thresholds = { gate: number; fits: number };

export type RankedItem = { name: string; probability: number };

export type RankResult = {
  shortlist: string[];
  ranked: RankedItem[];
  gate: number;
  gates: Record<string, number>;
  tokens: number;
};

export type RerankResult = {
  winner: string;
  probs: Record<string, number>;
  fits: Record<string, number>;
  tokens: number;
};

export type SuggestReason = "gate" | "fits" | "repeat" | "error";

export type SuggestResult = {
  skill: string | null;
  reason?: SuggestReason;
  error?: string;
  gate: number;
  gates: Record<string, number>;
  shortlist: string[];
  ranked: RankedItem[];
  fits: Record<string, number>;
  winner: string | null;
  tokens: number;
  ms: number;
};

export type FindCandidate = {
  name: string;
  probability: number;
  fits: number;
  card?: SkillCard;
  does: string;
  not_for: string;
};

const LRU_MAX = 200;
const cache = new Map<string, JevResponse>();

export function resetSuggestCache(): void {
  cache.clear();
}

function cacheKey(state: Record<string, string>, questions: Record<string, JevQuestion>): string {
  return createHash("sha256").update(JSON.stringify({ state, questions })).digest("hex");
}

async function askCached(
  client: JevClient,
  state: Record<string, string>,
  questions: Record<string, JevQuestion>,
): Promise<JevResponse> {
  const key = cacheKey(state, questions);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const out = await client.ask(state, questions);
  cache.set(key, out);
  while (cache.size > LRU_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return out;
}

export function buildState(input: SuggestInput): { request: string; recent_context: string } {
  const lines: string[] = [];
  const prevUser = input.context?.prevUser ?? "";
  const prevAssistant = input.context?.prevAssistant ?? "";
  if (prevUser !== "") lines.push(`Previous user message: ${prevUser.slice(0, 600)}`);
  if (prevAssistant !== "") lines.push(`Agent's last reply (tail): ${prevAssistant.slice(-900)}`);
  return { request: input.message.slice(0, 2000), recent_context: lines.join("\n") };
}

export function chunkNames(names: readonly string[], size = CHUNK): string[][] {
  // Code-point order, as in the measured experiment: localeCompare skips "-" and
  // would move chunk boundaries.
  const sorted = [...names].sort();
  const parts: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) parts.push(sorted.slice(i, i + size));
  return parts;
}

function byName(roster: readonly RosterEntry[]): Map<string, RosterEntry> {
  return new Map(roster.map((item) => [item.name, item]));
}

function choiceAnswer(answer: JevAnswer | undefined): Extract<JevAnswer, { type: "choice" }> | null {
  return answer !== undefined && answer.type === "choice" ? answer : null;
}

function noulAnswer(answer: JevAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" ? answer.noul : 0;
}

function topNames(probabilities: Record<string, number>, limit: number): RankedItem[] {
  return Object.entries(probabilities)
    .map(([name, probability]) => ({ name, probability }))
    .sort((a, b) => b.probability - a.probability || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function filterRoster(roster: readonly RosterEntry[], exclude: readonly string[]): RosterEntry[] {
  const skip = new Set(exclude);
  return roster.filter((item) => !skip.has(item.name));
}

export async function rank(
  client: JevClient,
  roster: readonly RosterEntry[],
  input: SuggestInput,
  opts: { includeGates?: boolean } = {},
): Promise<RankResult> {
  const includeGates = opts.includeGates !== false;
  const lookup = byName(roster);
  const parts = chunkNames(roster.map((item) => item.name));
  const questions: Record<string, JevQuestion> = {};
  for (const [index, part] of parts.entries()) {
    const criteria: Record<string, string> = {};
    for (const name of part) {
      const skill = lookup.get(name);
      if (skill === undefined) continue;
      criteria[name] = cardShort(name, skill.card, skill.description);
    }
    questions[`which::${index}`] = { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria };
  }
  if (includeGates) {
    for (const [key, instructions] of Object.entries(GATE_QUESTIONS)) {
      questions[`gate::${key}`] = { type: "noul", instructions };
    }
  }
  const out = await askCached(client, buildState(input), questions);
  const shortlist: string[] = [];
  const ranked: RankedItem[] = [];
  for (const [key, answer] of Object.entries(out.answers)) {
    if (!key.startsWith("which::")) continue;
    const choice = choiceAnswer(answer);
    if (choice === null) continue;
    const top = topNames(choice.probabilities, PER_CHUNK);
    shortlist.push(...top.map((item) => item.name));
    ranked.push(...top);
  }
  const gates: Record<string, number> = {};
  const oriented: number[] = [];
  if (includeGates) {
    for (const key of Object.keys(GATE_QUESTIONS)) {
      const value = noulAnswer(out.answers[`gate::${key}`]);
      gates[key] = value;
      oriented.push(INVERTED.has(key) ? 1 - value : value);
    }
  }
  ranked.sort((a, b) => b.probability - a.probability || a.name.localeCompare(b.name));
  return {
    shortlist,
    ranked: ranked.slice(0, 12),
    gate: oriented.length === 0 ? 0 : oriented.reduce((sum, value) => sum + value, 0) / oriented.length,
    gates,
    tokens: out.usage.input_tokens,
  };
}

export async function rerank(
  client: JevClient,
  roster: readonly RosterEntry[],
  input: SuggestInput,
  shortlist: readonly string[],
): Promise<RerankResult> {
  const lookup = byName(roster);
  const criteria: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  for (const name of shortlist) {
    const skill = lookup.get(name);
    if (skill === undefined) continue;
    const full = cardFull(name, skill.card, skill.description, skill.body);
    criteria[name] = full;
    questions[`fits::${name}`] = {
      type: "noul",
      instructions: `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${full}`,
    };
  }
  questions.which = { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria };
  const out = await askCached(client, buildState(input), questions);
  const which = choiceAnswer(out.answers.which);
  const fits: Record<string, number> = {};
  for (const [key, answer] of Object.entries(out.answers)) {
    if (key.startsWith("fits::")) fits[key.slice(6)] = noulAnswer(answer);
  }
  const winner = which?.choice && criteria[which.choice] !== undefined ? which.choice : (shortlist[0] ?? "");
  return {
    winner,
    probs: which?.probabilities ?? {},
    fits,
    tokens: out.usage.input_tokens,
  };
}

function emptyResult(partial: Partial<SuggestResult> & { ms: number }): SuggestResult {
  return {
    skill: null,
    gate: 0,
    gates: {},
    shortlist: [],
    ranked: [],
    fits: {},
    winner: null,
    tokens: 0,
    ...partial,
  };
}

export async function suggest(
  client: JevClient,
  roster: readonly RosterEntry[],
  input: SuggestInput,
  opts: { thresholds?: Thresholds; exclude?: readonly string[]; alreadySuggested?: readonly string[] } = {},
): Promise<SuggestResult> {
  const started = Date.now();
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const filtered = filterRoster(roster, opts.exclude ?? DEFAULT_EXCLUDE);
  try {
    const pass1 = await rank(client, filtered, input);
    const ms1 = { gate: pass1.gate, gates: pass1.gates, shortlist: pass1.shortlist, ranked: pass1.ranked, tokens: pass1.tokens };
    if (pass1.gate < thresholds.gate) {
      return emptyResult({ ...ms1, skill: null, reason: "gate", ms: Date.now() - started });
    }
    if (pass1.shortlist.length === 0) {
      return emptyResult({ ...ms1, skill: null, reason: "fits", ms: Date.now() - started });
    }
    const pass2 = await rerank(client, filtered, input, pass1.shortlist);
    const fitsMax = Object.values(pass2.fits).reduce((max, value) => Math.max(max, value), 0);
    const tokens = pass1.tokens + pass2.tokens;
    const base = { ...ms1, fits: pass2.fits, winner: pass2.winner, tokens, ms: Date.now() - started };
    if (fitsMax < thresholds.fits) return emptyResult({ ...base, skill: null, reason: "fits" });
    if ((opts.alreadySuggested ?? []).includes(pass2.winner)) {
      return emptyResult({ ...base, skill: null, reason: "repeat" });
    }
    return { ...base, skill: pass2.winner };
  } catch (cause) {
    return emptyResult({
      skill: null,
      reason: "error",
      error: cause instanceof Error ? cause.message : String(cause),
      ms: Date.now() - started,
    });
  }
}

export async function find(
  client: JevClient,
  roster: readonly RosterEntry[],
  query: string,
  context?: string,
  limit = 5,
): Promise<FindCandidate[]> {
  const input: SuggestInput = { message: query, context: context !== undefined && context !== "" ? { prevUser: context } : undefined };
  const pass1 = await rank(client, roster, input, { includeGates: false });
  if (pass1.shortlist.length === 0) return [];
  const pass2 = await rerank(client, roster, input, pass1.shortlist);
  const lookup = byName(roster);
  const candidates = pass1.shortlist.map((name) => {
    const skill = lookup.get(name);
    return {
      name,
      probability: pass2.probs[name] ?? 0,
      fits: pass2.fits[name] ?? 0,
      card: skill?.card,
      does: cardShort(name, skill?.card, skill?.description ?? ""),
      not_for: skill?.card?.not_for ?? "",
    };
  });
  candidates.sort((a, b) => b.probability - a.probability || b.fits - a.fits || a.name.localeCompare(b.name));
  return candidates.slice(0, Math.max(1, limit));
}

/** `skill_read` names the plugin tool; without it the agent loads the skill natively. */
export function relevanceBlock(skill: string | null, opts: { skillRead?: boolean } = {}): string {
  if (skill === null) return "";
  const how = opts.skillRead === false ? `Load the ${skill} skill (its SKILL.md) before acting.` : "Read its SKILL.md with skill_read before acting.";
  return [
    "<skill_relevance>",
    `Relevant to the current request: ${skill}. ${how} If it is already loaded in this conversation, use it as is and do not load it again. Ignore this if it does not fit what the user actually asked for.`,
    "</skill_relevance>",
  ].join("\n");
}

export function parseThreshold(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseExclude(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const KEYWORD_STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into"]);

export function keywordFind(roster: readonly RosterEntry[], query: string, limit = 5): FindCandidate[] {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !KEYWORD_STOP.has(token));
  const scored = roster.map((skill) => {
    const hay = `${skill.name} ${skill.description} ${skill.card?.does ?? ""} ${skill.card?.not_for ?? ""} ${skill.card?.neighbors ?? ""} ${skill.card?.triggers_ru.join(" ") ?? ""}`.toLowerCase();
    let hits = 0;
    for (const token of tokens) if (hay.includes(token)) hits += 1;
    if (skill.name.toLowerCase() === query.trim().toLowerCase()) hits += 10;
    return {
      name: skill.name,
      probability: tokens.length === 0 ? 0 : hits / tokens.length,
      fits: tokens.length === 0 ? 0 : hits / tokens.length,
      card: skill.card,
      does: cardShort(skill.name, skill.card, skill.description),
      not_for: skill.card?.not_for ?? "",
    };
  });
  return scored
    .filter((item) => item.fits > 0)
    .sort((a, b) => b.fits - a.fits || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit));
}

export function formatFindList(candidates: readonly FindCandidate[]): string {
  if (candidates.length === 0) return "No matching skills.";
  return candidates
    .map((item) => {
      const notFor = item.not_for.trim() !== "" ? ` — Not for: ${item.not_for}` : "";
      return `- **${item.name}** (fit ${item.fits.toFixed(2)}): ${item.does}${notFor}`;
    })
    .join("\n");
}
