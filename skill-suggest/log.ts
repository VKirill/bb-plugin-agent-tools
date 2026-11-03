export type SuggestLogMode = "cli" | "tool";

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

export const SUGGEST_LOG_MAX = 500;
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
