/**
 * Experimental "skills only on the hub" enforcement: for every connected
 * machine, publish the skills the hub lacks, then archive the CLI skill
 * copies on that machine. A machine is cleaned only when every import either
 * succeeded or was refused with a blocking problem (BB would not load such a
 * skill anyway); a transient failure keeps the machine as it is for this run.
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
  /** Refused by BB rules (a blocking problem): they go to the archive too. */
  rejected: Array<{ name: string; reason: string }>;
  /** Why this machine was left as is this run; null when it was processed. */
  skipped: string | null;
  cleanup: { backup: string | null; moved: Array<{ id: string; count: number }>; errors: string[] } | null;
}>;

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
        for (const skill of fresh.notOnHub) {
          const result = await deps.importSkill(host.hostId, skill);
          if (result.ok) {
            entry.imported.push(skill.name);
            continue;
          }
          const blocking = result.problems.filter((problem) => problem.blocking);
          if (blocking.length > 0) {
            entry.rejected.push({
              name: skill.name,
              reason: blocking.map((problem) => problem.detail).join("; ") || result.error || "rejected",
            });
          } else {
            transient.push(`${skill.name}: ${result.error ?? "import failed"}`);
          }
        }
        if (transient.length > 0) {
          entry.skipped = transient.join("; ");
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
    deps.log(
      `skills hub-only ${host.hostName}: imported ${entry.imported.length}, rejected ${entry.rejected.length}` +
        (entry.cleanup === null
          ? `, skipped: ${entry.skipped ?? "?"}`
          : `, moved ${entry.cleanup.moved.reduce((sum, item) => sum + item.count, 0)} to ${entry.cleanup.backup ?? "?"}`),
    );
    report.push(entry);
  }
  return report;
}
