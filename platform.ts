// Platform helpers shared by the host entry, the server process and the catalogue
// rules. Pure functions only: no Node imports, so they stay safe in any bundle and
// are easy to test with an injected platform.
import type { McpServer } from "./contract";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * File names to try for an executable called `name` in one PATH directory.
 * Windows resolves bare names through PATHEXT; other platforms use the name as is.
 */
export function binCandidates(
  name: string,
  platform: string = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return [name];
  const extensions = (pathext !== undefined && pathext.trim() !== "" ? pathext : DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const lower = name.toLowerCase();
  if (extensions.some((ext) => lower.endsWith(ext))) return [name];
  return [...extensions.map((ext) => name + ext), name];
}

/** `C:\dir`, `C:/dir` or a UNC path `\\host\share`. */
export function isWindowsAbsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function lastSegment(value: string): string {
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
}

function isCmdShell(command: string): boolean {
  return /^cmd(\.exe)?$/i.test(lastSegment(command));
}

/**
 * `cmd /c npx -y pkg` → `npx -y pkg`. Tolerates `/d` and `/s` before `/c`.
 * Anything that is not a cmd wrapper comes back unchanged.
 */
export function unwrapShell(
  command: string,
  args: readonly string[] | undefined,
): { command: string; args: string[] | undefined } {
  const unchanged = { command, args: args === undefined ? undefined : [...args] };
  if (args === undefined || !isCmdShell(command)) return unchanged;
  let index = 0;
  while (index < args.length && /^\/[ds]$/i.test(args[index]!)) index += 1;
  if (index >= args.length || args[index]!.toLowerCase() !== "/c") return unchanged;
  const inner = args[index + 1];
  if (inner === undefined) return unchanged;
  const rest = args.slice(index + 2);
  return { command: inner, args: rest.length > 0 ? rest : undefined };
}

/**
 * Native Windows Claude Code and Codex cannot spawn `.cmd` shims (npx, gitnexus,
 * agentmemory) directly. True for bare names that are not an `.exe`/`.com`, and
 * for explicit `.cmd`/`.bat` paths.
 */
export function needsCmdWrapper(command: string): boolean {
  if (/\.(cmd|bat)$/i.test(command)) return true;
  const hasDir = command.includes("/") || command.includes("\\");
  return !hasDir && !/\.(exe|com)$/i.test(command);
}

/** Rewrite a stdio server into the `cmd /c …` form when Windows needs it. */
export function wrapForWindows(server: McpServer): McpServer {
  if (server.transport !== "stdio") return server;
  const command = server.command;
  if (command === undefined || command === "" || isCmdShell(command)) return server;
  if (!needsCmdWrapper(command)) return server;
  return { ...server, command: "cmd", args: ["/c", command, ...(server.args ?? [])] };
}
