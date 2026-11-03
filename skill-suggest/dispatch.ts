// Per-turn skill suggestion on stock BB, without a provider hook.
//
// The `message.dispatch` hook cannot amend a message, so the flow is:
// 1. the hook answers `wait` for a user's new turn (instantly: the pass runs
//    under a server-wide lock);
// 2. the message lands in the thread queue and `message.queued` fires;
// 3. we ask Jev, append an agent-only block to the queued row, and call
//    `recheck`;
// 4. the hook sees the row is decided and answers `proceed`.
// Every failure path ends in `proceed`: `sendAt` makes core re-attempt after
// BUDGET_MS even if this plugin hangs, and a row older than the budget passes.

export const SUGGEST_MARKER = "<skill_relevance>";
export const BUDGET_MS = 4_000;
/** A thread rarely has more open rows than this; older decisions are dropped. */
const DECIDED_MAX = 500;

export type DispatchBlock = { type: string; text?: string; visibility?: string; [key: string]: unknown };

export type QueuedRow = {
  id: string;
  threadId: string;
  content: readonly DispatchBlock[];
  createdAt: number;
  updatedAt: number;
  initiator: "user" | "agent" | "system";
  payload?: { kind?: string } | null;
  waitingOn?: { kind: string; pluginId?: string } | null;
};

export type DispatchContext = {
  thread: { id: string; visibility?: string | null };
  input: { blocks: readonly DispatchBlock[]; text: string };
  attempt: "start-turn" | "join-turn";
  queuedMessage: QueuedRow | null;
};

export type DispatchDecision = { action: "proceed" } | { action: "wait"; reason: string; sendAt: number };

export type InjectorDeps = {
  enabled(): boolean;
  /** Visible text of the message plus the thread → the block to add, or null. */
  suggest(threadId: string, text: string): Promise<string | null>;
  updateRow(row: QueuedRow, content: DispatchBlock[]): Promise<void>;
  /** True for hidden service threads (card writer, classifier, Tasks workers). */
  isHidden(threadId: string): Promise<boolean>;
  recheck(): Promise<void>;
  waitReason(): string;
  now(): number;
  log(message: string): void;
};

export function hasMarker(blocks: readonly DispatchBlock[]): boolean {
  return blocks.some((block) => block.type === "text" && block.visibility === "agent-only" && (block.text ?? "").includes(SUGGEST_MARKER));
}

/** What the user wrote: text blocks the user sees, joined. */
export function visibleText(blocks: readonly DispatchBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && block.visibility !== "agent-only")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

export function agentOnlyBlock(text: string): DispatchBlock {
  return { type: "text", text, mentions: [], visibility: "agent-only" };
}

export class SkillDispatchInjector {
  private readonly decided = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly hiddenThreads = new Set<string>();

  private readonly deps: InjectorDeps;

  constructor(deps: InjectorDeps) {
    this.deps = deps;
  }

  /** The `message.dispatch` answer. Synchronous work only. */
  decide(ctx: DispatchContext): DispatchDecision {
    const { deps } = this;
    const proceed = { action: "proceed" } as const;
    if (!deps.enabled()) return proceed;
    if (ctx.attempt !== "start-turn") return proceed;
    if (ctx.thread.visibility === "hidden") {
      this.hiddenThreads.add(ctx.thread.id);
      return proceed;
    }
    if (hasMarker(ctx.input.blocks)) return proceed;
    if (visibleText(ctx.input.blocks) === "") return proceed;
    const row = ctx.queuedMessage;
    const now = deps.now();
    if (row === null) return { action: "wait", reason: deps.waitReason(), sendAt: now + BUDGET_MS };
    if (row.initiator !== "user" || row.payload?.kind === "retry") return proceed;
    if (this.decided.has(row.id)) return proceed;
    // Older rows waited on something else (a busy thread, a schedule) and were
    // handled when they were queued, or this plugin restarted: let them go.
    if (now - row.createdAt >= BUDGET_MS) return proceed;
    return { action: "wait", reason: deps.waitReason(), sendAt: row.createdAt + BUDGET_MS };
  }

  /** `message.queued` listener. */
  async onQueued(row: QueuedRow): Promise<void> {
    const { deps } = this;
    if (!deps.enabled()) return;
    if (this.decided.has(row.id) || this.inflight.has(row.id)) return;
    if (row.initiator !== "user" || row.payload?.kind === "retry") return;
    if (hasMarker(row.content)) return;
    if (this.hiddenThreads.has(row.threadId)) return;
    const text = visibleText(row.content);
    if (text === "") return;
    this.inflight.add(row.id);
    try {
      if (await deps.isHidden(row.threadId)) {
        this.hiddenThreads.add(row.threadId);
        return;
      }
      const block = await deps.suggest(row.threadId, text);
      if (block !== null && block !== "") await deps.updateRow(row, [...row.content, agentOnlyBlock(block)]);
    } catch (cause) {
      deps.log(`skill suggest on dispatch: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.inflight.delete(row.id);
      this.markDecided(row.id);
      if (row.waitingOn?.kind === "plugin") await deps.recheck().catch(() => undefined);
    }
  }

  private markDecided(id: string): void {
    this.decided.add(id);
    if (this.decided.size <= DECIDED_MAX) return;
    const oldest = this.decided.values().next().value;
    if (oldest !== undefined) this.decided.delete(oldest);
  }
}
