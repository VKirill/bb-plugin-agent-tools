/**
 * Experimental "skills only on the hub" enforcement: for every connected
 * machine, publish the skills the hub lacks, then archive the CLI skill
 * copies on that machine. A machine is cleaned only when every skill it
 * holds is loadable from the hub. A hub skill with a blocking problem does
 * not count as present; a blocking rejection or a transient failure keeps
 * the machine as it is for this run.
 */

export type HubOnlyDeps = {
  hosts: () => Promise<Array<{ hostId: string; hostName: string }>>;
  refresh: (hostId: string) => Promise<{
    notOnHub: Array<{ name: string; path: string }>;
    homes: Array<{ id: string; path: string; skills: number; links: number }>;
    error: string | null;
  }>;
  importSkill: (
    hostId: string,
    skill: { name: string; path: string },
  ) => Promise<{
    ok: boolean;
    error: string | null;
    problems: Array<{ code: string; detail: string; blocking: boolean }>;
  }>;
  cleanup: (hostId: string) => Promise<{
    backup: string | null;
    moved: Array<{ id: string; count: number }>;
    errors: string[];
  }>;
  log: (message: string) => void;
};

export type HubOnlyReport = Array<{
  hostId: string;
  hostName: string;
  /** Skills published to the hub this run. */
  imported: string[];
  /** Refused by BB rules (a blocking problem): the machine is not cleaned. */
  rejected: Array<{ name: string; reason: string }>;
  /** Why this machine was left as is this run; null when it was processed. */
  skipped: string | null;
  cleanup: { backup: string | null; moved: Array<{ id: string; count: number }>; errors: string[] } | null;
}>;

/** Hub skill names BB can load: no problem with blocking: true. A missing problems list counts as none. */
export function loadableHubNames(skills: Array<{ name: string; problems?: Array<{ blocking: boolean }> }>): Set<string> {
  return new Set(skills.filter((skill) => !(skill.problems ?? []).some((problem) => problem.blocking)).map((skill) => skill.name));
}

/** Machine skills whose names are not among the loadable hub skills; other fields of each entry are kept. */
export function machineNotOnHub<T extends { name: string }>(
  found: T[],
  hub: Array<{ name: string; problems?: Array<{ blocking: boolean }> }>,
): T[] {
  const hubNames = loadableHubNames(hub);
  return found.filter((skill) => !hubNames.has(skill.name));
}

function skippedForRejected(rejected: Array<{ name: string; reason: string }>, labels: string[]): string {
  return `BB не загружает: ${labels.length > 0 ? labels.join("; ") : rejected.map((item) => item.name).join("; ")}`;
}

export async function enforceHubOnly(deps: HubOnlyDeps): Promise<HubOnlyReport> {
  const report: HubOnlyReport = [];
  for (const host of await deps.hosts()) {
    const entry: HubOnlyReport[number] = {
      hostId: host.hostId,
      hostName: host.hostName,
      imported: [],
      rejected: [],
      skipped: null,
      cleanup: null,
    };
    try {
      const fresh = await deps.refresh(host.hostId);
      if (fresh.error !== null) {
        entry.skipped = fresh.error;
      } else {
        const transient: string[] = [];
        const rejectedLabels: string[] = [];
        for (const skill of fresh.notOnHub) {
          const result = await deps.importSkill(host.hostId, skill);
          if (result.ok) {
            entry.imported.push(skill.name);
            continue;
          }
          const blocking = result.problems.filter((problem) => problem.blocking);
          if (blocking.length > 0) {
            const first = blocking[0]!;
            entry.rejected.push({
              name: skill.name,
              reason: blocking.map((problem) => problem.detail).join("; ") || result.error || "rejected",
            });
            rejectedLabels.push(`${skill.name} (${first.code}: ${first.detail})`);
          } else {
            transient.push(`${skill.name}: ${result.error ?? "import failed"}`);
          }
        }
        if (entry.rejected.length > 0 || transient.length > 0) {
          const parts: string[] = [];
          if (entry.rejected.length > 0) parts.push(skippedForRejected(entry.rejected, rejectedLabels));
          if (transient.length > 0) parts.push(transient.join("; "));
          entry.skipped = parts.join("; ");
        } else {
          // Also on an already-empty machine: the cleanup writes the
          // ~/.agents/skills-on-hub marker the installers read.
          entry.cleanup = await deps.cleanup(host.hostId);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`skills hub-only ${host.hostName}: ${message}`);
      entry.skipped = message.slice(0, 300);
    }
    const rejectedNames = entry.rejected.map((item) => item.name).join(", ");
    deps.log(
      `skills hub-only ${host.hostName}: imported ${entry.imported.length}, rejected ${entry.rejected.length}` +
        (rejectedNames.length > 0 ? ` (${rejectedNames})` : "") +
        (entry.cleanup === null
          ? `, skipped: ${entry.skipped ?? "?"}`
          : `, moved ${entry.cleanup.moved.reduce((sum, item) => sum + item.count, 0)} to ${entry.cleanup.backup ?? "?"}`),
    );
    report.push(entry);
  }
  return report;
}
