import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipErrorText, formatSkillsSyncError, gitBinSearchDirs, parseUntrackedOverwriteNames } from "./i18n.js";

const execFileAsync = promisify(execFile);

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type SkillsSyncGitRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type SkillsSyncDeps = {
  gitBin: string;
  hostname?: string;
  runGit?: SkillsSyncGitRunner;
  expand?: (relative: string) => string;
  stamp?: () => string;
  fingerprintDir?: (dir: string) => Promise<{ hash: string } | null>;
};

export type SkillsSyncResult = {
  ok: boolean;
  error: string | null;
  message: string | null;
};

export async function runGit(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(bin, args, {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function rebaseInProgress(dir: string): Promise<boolean> {
  return (
    (await exists(path.join(dir, ".git", "rebase-merge"))) ||
    (await exists(path.join(dir, ".git", "rebase-apply")))
  );
}

async function abortRebase(bin: string, dir: string, git: SkillsSyncGitRunner): Promise<void> {
  if (!(await rebaseInProgress(dir))) return;
  await git(bin, ["-C", dir, "rebase", "--abort"]).catch(() => undefined);
}

async function remoteRef(bin: string, dir: string, git: SkillsSyncGitRunner): Promise<string> {
  const head = await git(bin, ["-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => "");
  if (head !== "") return head;
  for (const candidate of ["origin/main", "origin/master", "FETCH_HEAD"]) {
    const ok = await git(bin, ["-C", dir, "rev-parse", "--verify", candidate]).then(
      () => true,
      () => false,
    );
    if (ok) return candidate;
  }
  throw new Error("не удалось определить ветку remote");
}

function pushFailureError(cause: unknown): string {
  const text = String((cause as { stderr?: unknown }).stderr ?? (cause instanceof Error ? cause.message : cause));
  return clipErrorText(`push не выполнен: ${text.trim().split("\n")[0] ?? "ошибка"}`);
}

/**
 * Свести локальный канон с remote. ok:true только если pull/checkout прошли
 * и push выполнен либо не требовался (already up-to-date).
 */
export async function syncSkillsCanon(
  dir: string,
  remote: string,
  deps: SkillsSyncDeps,
): Promise<SkillsSyncResult> {
  const gitBin = deps.gitBin;
  const git = deps.runGit ?? runGit;
  const hostname = deps.hostname ?? os.hostname();
  const expandPath = deps.expand ?? ((relative: string) => path.join(os.homedir(), relative));
  const makeStamp = deps.stamp ?? (() => new Date().toISOString().replace(/[:.]/g, "-"));
  const messages: string[] = [];
  let fetchedRef: string | null = null;
  try {
    if (!await exists(path.join(dir, ".git"))) {
      await mkdir(dir, { recursive: true });
      const snapshot = expandPath(`.agents/skills-migrate-${makeStamp()}`);
      await cp(dir, snapshot, { recursive: true, dereference: true });
      const temp = expandPath(`.agents/skills-clone-${makeStamp()}`);
      await rm(temp, { recursive: true, force: true });
      await git(gitBin, ["clone", remote, temp]);
      let added = 0;
      const diverged: string[] = [];
      for (const name of await readdir(temp).catch(() => [] as string[])) {
        if (name === ".git") continue;
        const incoming = path.join(temp, name);
        const local = path.join(dir, name);
        if (!await exists(local)) {
          await rename(incoming, local);
          added += 1;
          continue;
        }
        if (deps.fingerprintDir) {
          const mine = await deps.fingerprintDir(local);
          const theirs = await deps.fingerprintDir(incoming);
          if (mine !== null && theirs !== null && mine.hash !== theirs.hash) diverged.push(name);
        }
      }
      await rename(path.join(temp, ".git"), path.join(dir, ".git"));
      await rm(temp, { recursive: true, force: true });
      fetchedRef = await remoteRef(gitBin, dir, git);
      messages.push(
        `миграция: снимок в ${snapshot}, добавлено из репозитория ${added}` +
          (diverged.length === 0 ? "" : `, расходятся (оставлено своё): ${diverged.join(", ")}`),
      );
    } else {
      const origin = await git(gitBin, ["-C", dir, "remote", "get-url", "origin"])
        .then((result) => result.stdout.trim())
        .catch(() => "");
      if (origin !== remote) {
        if (origin === "") await git(gitBin, ["-C", dir, "remote", "add", "origin", remote]);
        else await git(gitBin, ["-C", dir, "remote", "set-url", "origin", remote]);
      }
      try {
        await git(gitBin, ["-C", dir, "pull", "--rebase", "--autostash"]);
        fetchedRef = await remoteRef(gitBin, dir, git);
      } catch (cause) {
        const stderr = String((cause as { stderr?: unknown }).stderr ?? (cause instanceof Error ? cause.message : cause));
        await abortRebase(gitBin, dir, git);
        const untracked = parseUntrackedOverwriteNames(stderr);
        if (untracked.length === 0) {
          return { ok: false, error: formatSkillsSyncError(cause, remote, gitBin), message: null };
        }
        try {
          await git(gitBin, ["-C", dir, "fetch", "origin"]);
          const ref = await remoteRef(gitBin, dir, git);
          fetchedRef = ref;
          const incoming = (await git(gitBin, ["-C", dir, "ls-tree", "--name-only", ref])).stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((name) => name !== "" && !name.startsWith("."));
          let added = 0;
          const diverged: string[] = [];
          for (const name of incoming) {
            const local = path.join(dir, name);
            if (await exists(local)) {
              diverged.push(name);
              continue;
            }
            await git(gitBin, ["-C", dir, "checkout", ref, "--", name]);
            added += 1;
          }
          messages.push(
            `pull заблокирован незакоммиченными файлами (оставлено своё): ${untracked.join(", ")}` +
              `; добавлено с remote ${added}` +
              (diverged.length === 0 ? "" : `, уже были локально: ${diverged.join(", ")}`),
          );
        } catch (fetchCause) {
          await abortRebase(gitBin, dir, git);
          return { ok: false, error: formatSkillsSyncError(fetchCause, remote, gitBin), message: null };
        }
      }
    }
    const ignorePath = path.join(dir, ".gitignore");
    const ignore = await readFile(ignorePath, "utf8").catch(() => "");
    const lines = new Set(ignore.split("\n").map((line) => line.trim()));
    let ignoreDirty = false;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(".")) continue;
      const isLink = await lstat(path.join(dir, name)).then((info) => info.isSymbolicLink()).catch(() => false);
      if (!isLink) continue;
      const line = `/${name}`;
      if (!lines.has(line)) {
        lines.add(line);
        ignoreDirty = true;
      }
    }
    if (ignoreDirty) await writeFile(ignorePath, `${[...lines].join("\n")}\n`);
    await git(gitBin, ["-C", dir, "add", "-A"]);
    const status = await git(gitBin, ["-C", dir, "status", "--porcelain"]);
    let committed = false;
    if (status.stdout.trim() !== "") {
      await git(gitBin, ["-C", dir, "commit", "-m", `skills sync ${hostname}`]);
      committed = true;
    }
    if (fetchedRef === null) throw new Error("не удалось определить ветку remote после синка");
    const includesRemote = await git(gitBin, ["-C", dir, "merge-base", "--is-ancestor", fetchedRef, "HEAD"])
      .then(() => true, () => false);
    if (!includesRemote) {
      await git(gitBin, [
        "-C", dir, "merge", "--no-ff", "--strategy=ours", "-m",
        `skills sync merge ${hostname}`, fetchedRef,
      ]);
    }
    const reconciled = await git(gitBin, ["-C", dir, "merge-base", "--is-ancestor", fetchedRef, "HEAD"])
      .then(() => true, () => false);
    if (!reconciled) throw new Error("remote не включён в локальную историю");
    try {
      await git(gitBin, ["-C", dir, "push"]);
    } catch (cause) {
      return {
        ok: false,
        error: pushFailureError(cause),
        message: messages.length > 0 ? messages.join("; ") : null,
      };
    }
    const tail = `${committed ? "commit + " : ""}push`;
    return { ok: true, error: null, message: [...messages, tail].join("; ") };
  } catch (cause) {
    await abortRebase(gitBin, dir, git);
    return { ok: false, error: formatSkillsSyncError(cause, remote, gitBin), message: null };
  }
}

/** git для host-процесса и для раскладки на сервер BB: PATH launchd часто пуст. */
export async function resolveGitBin(home = os.homedir()): Promise<string | null> {
  for (const dir of gitBinSearchDirs(process.env.PATH ?? "", home, path.delimiter)) {
    const candidate = path.join(dir, "git");
    try {
      const info = await stat(candidate);
      if (info.isFile() || info.isSymbolicLink()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
