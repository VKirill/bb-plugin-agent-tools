export type SuggestLogMode = "cli" | "tool" | "dispatch";

export type SuggestLogEntry = {
  at: number;
  threadId: string | null;
  message: string;
  skill: string | null;
  reason: string;
  gate: number;
  fitsMax: number;
  shortlist: string[];
  tokens: number;
  ms: number;
  mode: SuggestLogMode;
};

// 200 entries of ~500 bytes stay well under the 256 KB cap on one KV value.
export const SUGGEST_LOG_MAX = 200;
export const ALREADY_SUGGESTED_MS = 6 * 60 * 60 * 1000;

export function appendLog(log: SuggestLogEntry[], entry: SuggestLogEntry): SuggestLogEntry[] {
  return [...log, entry].slice(-SUGGEST_LOG_MAX);
}

export function alreadySuggested(log: readonly SuggestLogEntry[], threadId: string, now: number): string[] {
  const names: string[] = [];
  for (const entry of log) {
    if (entry.threadId !== threadId || entry.skill === null) continue;
    if (now - entry.at > ALREADY_SUGGESTED_MS) continue;
    if (!names.includes(entry.skill)) names.push(entry.skill);
  }
  return names;
}

const MEMORY_THREADS_MAX = 1000;

/**
 * Skills already hinted per thread, in memory. The shared log keeps only the
 * last SUGGEST_LOG_MAX entries across all threads, so with a hint on every
 * turn an early hint can scroll out of it and come back; this map does not.
 * The log still covers the time after a plugin restart.
 */
export class ThreadSkillMemory {
  private readonly threads = new Map<string, Map<string, number>>();

  record(threadId: string, skill: string, at: number): void {
    const skills = this.threads.get(threadId) ?? new Map<string, number>();
    skills.set(skill, at);
    this.threads.delete(threadId);
    this.threads.set(threadId, skills);
    if (this.threads.size > MEMORY_THREADS_MAX) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
  }

  recent(threadId: string, now: number): string[] {
    const skills = this.threads.get(threadId);
    if (skills === undefined) return [];
    return [...skills].filter(([, at]) => now - at <= ALREADY_SUGGESTED_MS).map(([skill]) => skill);
  }
}
