import { execFile, type ExecFileOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { binCandidates } from "./platform.ts";
import { gitBinSearchDirs } from "./i18n.ts";

/**
 * execFile as a promise of `{ stdout, stderr }`, built on the plain callback.
 * `promisify(execFile)` depends on execFile's custom promisify hook; in the BB
 * host worker on Windows it resolved without `stdout`, so every git read came
 * back undefined. A failure carries `stdout`/`stderr` like promisify's does.
 */
export function execFileOutput(
  bin: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function execFileOutput(
  bin: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }>;
export function execFileOutput(
  bin: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding?: string | null } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { encoding: "utf8", ...options } as ExecFileOptions, (error, stdout, stderr) => {
      if (error !== null) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export async function runGit(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  // autocrlf=false keeps shared git trees byte-identical across platforms (Windows git defaults to true).
  return execFileOutput(bin, ["-c", "core.autocrlf=false", ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LC_MESSAGES: "C",
      LANG: "C",
      LANGUAGE: "C",
    },
  });
}

/** git для host-процесса и для раскладки на сервер BB: PATH launchd часто пуст. */
export async function resolveGitBin(home = os.homedir()): Promise<string | null> {
  for (const dir of gitBinSearchDirs(process.env.PATH ?? "", home, path.delimiter)) {
    for (const name of binCandidates("git")) {
      const candidate = path.join(dir, name);
      try {
        const info = await stat(candidate);
        if (info.isFile() || info.isSymbolicLink()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
