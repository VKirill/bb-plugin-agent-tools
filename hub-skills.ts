import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { measureBbTree, SKILL_TAR_EXCLUDES, isSkillJunk } from "./skill-tree.ts";
import { execFileOutput } from "./skills-sync.ts";
import { parseSkillMeta, treeProblems, type SkillProblem } from "./skill-meta.ts";

/**
 * The skills canon on the hub: `<BB data dir>/skills` of the BB server, the
 * folder BB registers user skills from and stages into every session. The
 * folder is a git working copy of the skills repository; every change the
 * plugin makes is committed and pushed. Runs in the BB server process.
 */

export type HubSkill = {
  name: string;
  description: string | null;
  bytes: number;
  files: number;
  mtime: number;
  problems: SkillProblem[];
};

export type HubSkillFile = { path: string; bytes: number };

export type HubCommit = { sha: string; at: number; subject: string; author: string };

export type HubSkillDetail = HubSkill & {
  content: string | null;
  contentTruncated: boolean;
  fileList: HubSkillFile[];
  fileListTruncated: boolean;
  history: HubCommit[];
};

export type HubGitState = {
  isRepo: boolean;
  branch: string | null;
  head: HubCommit | null;
  dirty: number;
  remote: string | null;
  error: string | null;
};

const CONTENT_MAX = 200_000;
const FILE_LIST_MAX = 400;

async function gitRun(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileOutput("git", ["-C", dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return String(stdout);
}

function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(name) && !name.includes("..");
}

async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").catch(() => null);
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  let count = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6 || count > 600) return;
    for (const item of await readdir(current).catch(() => [] as string[])) {
      if (isSkillJunk(item) || item.startsWith(".")) continue;
      const full = path.join(current, item);
      const info = await lstat(full).catch(() => null);
      if (info === null || info.isSymbolicLink()) continue;
      count += 1;
      if (info.isDirectory()) await walk(full, depth + 1);
      else newest = Math.max(newest, info.mtimeMs);
    }
  };
  await walk(dir, 0);
  return Math.round(newest);
}

async function describe(root: string, name: string): Promise<HubSkill> {
  const dir = path.join(root, name);
  const content = await readText(path.join(dir, "SKILL.md"));
  const meta = parseSkillMeta(content, name);
  const tree = await measureBbTree(dir);
  return {
    name,
    description: meta.description,
    bytes: tree.bytes,
    files: tree.files,
    mtime: await newestMtime(dir),
    problems: [...meta.problems, ...treeProblems(tree.bytes, tree.files)],
  };
}

/** Every skill folder on the hub, with what BB would reject. */
export async function listHubSkills(root: string): Promise<HubSkill[]> {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => !name.startsWith(".")).sort();
  const result: HubSkill[] = [];
  for (const name of names) {
    const info = await stat(path.join(root, name)).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    result.push(await describe(root, name));
  }
  return result;
}

async function listFiles(dir: string): Promise<{ files: HubSkillFile[]; truncated: boolean }> {
  const files: HubSkillFile[] = [];
  let truncated = false;
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const item of (await readdir(current).catch(() => [] as string[])).sort()) {
      if (files.length >= FILE_LIST_MAX) {
        truncated = true;
        return;
      }
      if (isSkillJunk(item) || item === ".DS_Store") continue;
      const full = path.join(current, item);
      const relPath = rel === "" ? item : `${rel}/${item}`;
      const info = await lstat(full).catch(() => null);
      if (info === null || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(full, relPath);
      else files.push({ path: relPath, bytes: info.size });
    }
  };
  await walk(dir, "");
  return { files, truncated };
}

function parseLog(text: string): HubCommit[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, at, author, ...subject] = line.split("\u001f");
      return { sha: sha.slice(0, 12), at: Number(at) * 1000, author, subject: subject.join(" ") };
    });
}

export async function skillHistory(root: string, name: string, limit = 10): Promise<HubCommit[]> {
  try {
    return parseLog(await gitRun(root, ["log", `-n${limit}`, "--format=%H\u001f%ct\u001f%an\u001f%s", "--", name]));
  } catch {
    return [];
  }
}

export async function readHubSkill(root: string, name: string): Promise<HubSkillDetail | null> {
  if (!safeName(name)) return null;
  const dir = path.join(root, name);
  const info = await stat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) return null;
  const base = await describe(root, name);
  const raw = await readText(path.join(dir, "SKILL.md"));
  const { files, truncated } = await listFiles(dir);
  return {
    ...base,
    content: raw === null ? null : raw.slice(0, CONTENT_MAX),
    contentTruncated: raw !== null && raw.length > CONTENT_MAX,
    fileList: files,
    fileListTruncated: truncated,
    history: await skillHistory(root, name),
  };
}

/** Reads one file of a skill for the viewer; text only, capped. */
export async function readHubSkillFile(root: string, name: string, relPath: string): Promise<string | null> {
  if (!safeName(name)) return null;
  const dir = path.join(root, name);
  const target = path.resolve(dir, relPath);
  if (!target.startsWith(`${dir}${path.sep}`)) return null;
  const text = await readText(target);
  return text === null ? null : text.slice(0, CONTENT_MAX);
}

function redactRemote(url: string): string {
  return url.replace(/\/\/[^@/]+@/u, "//");
}

export async function hubGitState(root: string): Promise<HubGitState> {
  try {
    const inside = (await gitRun(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    if (!inside) return { isRepo: false, branch: null, head: null, dirty: 0, remote: null, error: null };
  } catch {
    return { isRepo: false, branch: null, head: null, dirty: 0, remote: null, error: null };
  }
  try {
    const branch = (await gitRun(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const head = parseLog(await gitRun(root, ["log", "-n1", "--format=%H\u001f%ct\u001f%an\u001f%s"]))[0] ?? null;
    const dirty = (await gitRun(root, ["status", "--porcelain"])).split("\n").filter((line) => line.trim() !== "").length;
    const remote = (await gitRun(root, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    return { isRepo: true, branch, head, dirty, remote: remote === "" ? null : redactRemote(remote), error: null };
  } catch (cause) {
    return {
      isRepo: true,
      branch: null,
      head: null,
      dirty: 0,
      remote: null,
      error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
    };
  }
}

export type CommitResult = { committed: boolean; sha: string | null; pushed: boolean; error: string | null };

/** Commits whatever changed under `paths` and pushes. A push failure keeps the commit. */
export async function commitAndPush(root: string, paths: string[], message: string): Promise<CommitResult> {
  const state = await hubGitState(root);
  if (!state.isRepo) return { committed: false, sha: null, pushed: false, error: "not a git repository" };
  try {
    await gitRun(root, ["add", "-A", "--", ...paths]);
    const staged = (await gitRun(root, ["diff", "--cached", "--name-only"])).trim();
    if (staged === "") return { committed: false, sha: state.head?.sha ?? null, pushed: false, error: null };
    await gitRun(root, [
      "-c",
      "user.name=Agent Tools",
      "-c",
      "user.email=agent-tools@users.noreply.github.com",
      "commit",
      "-q",
      "-m",
      message,
    ]);
  } catch (cause) {
    return { committed: false, sha: null, pushed: false, error: cause instanceof Error ? cause.message.slice(0, 500) : String(cause) };
  }
  const sha = (await gitRun(root, ["rev-parse", "--short=12", "HEAD"]).catch(() => "")).trim() || null;
  try {
    await gitRun(root, ["push", "-q", "origin", "HEAD"]);
    return { committed: true, sha, pushed: true, error: null };
  } catch (cause) {
    return { committed: true, sha, pushed: false, error: cause instanceof Error ? cause.message.slice(0, 500) : String(cause) };
  }
}

async function isIgnored(root: string, name: string): Promise<boolean> {
  try {
    await gitRun(root, ["check-ignore", "-q", name]);
    return true;
  } catch {
    return false;
  }
}

function backupRoot(): string {
  return path.join(os.homedir(), ".agents", "skills-backups");
}

async function backupDir(source: string, name: string, reason: string): Promise<string | null> {
  const info = await lstat(source).catch(() => null);
  if (info === null || !info.isDirectory()) return null;
  const dest = path.join(backupRoot(), name, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, filter: (item) => item === source || !isSkillJunk(path.basename(item)) });
  await writeFile(
    path.join(dest, ".backup.json"),
    `${JSON.stringify({ name, at: new Date().toISOString(), reason, locationId: "hub", machine: os.hostname() }, null, 2)}\n`,
  );
  return dest;
}

export type PublishResult = {
  ok: boolean;
  name: string | null;
  replaced: boolean;
  problems: SkillProblem[];
  commit: CommitResult | null;
  error: string | null;
};

/**
 * Publishes a skill archive (one top-level folder) to the hub. The archive is
 * unpacked and checked in a temp dir first; the hub copy changes only when
 * BB would accept the result.
 */
export async function publishArchive(
  root: string,
  archiveBase64: string,
  source: string,
  opts: { dryRun?: boolean } = {},
): Promise<PublishResult> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-tools-publish-"));
  try {
    const tgz = path.join(temp, "skill.tgz");
    await writeFile(tgz, Buffer.from(archiveBase64, "base64"));
    const out = path.join(temp, "out");
    await mkdir(out);
    const excludes = SKILL_TAR_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
    await execFileOutput("tar", ["xzf", tgz, ...excludes, "-C", out], { maxBuffer: 8 * 1024 * 1024 });
    const tops = (await readdir(out)).filter((item) => !item.startsWith("."));
    if (tops.length !== 1) {
      return { ok: false, name: null, replaced: false, problems: [], commit: null, error: "the archive must hold exactly one skill folder" };
    }
    const name = tops[0];
    if (!safeName(name)) {
      return { ok: false, name, replaced: false, problems: [], commit: null, error: "invalid folder name" };
    }
    const staged = await describe(out, name);
    const blocking = staged.problems.filter((problem) => problem.blocking);
    if (blocking.length > 0) {
      return { ok: false, name, replaced: false, problems: staged.problems, commit: null, error: "BB would reject this skill" };
    }
    const dest = path.join(root, name);
    const existed = (await stat(dest).catch(() => null)) !== null;
    if (opts.dryRun === true) {
      return { ok: true, name, replaced: existed, problems: staged.problems, commit: null, error: null };
    }
    if (existed) {
      await backupDir(dest, name, `replaced by publish from ${source}`);
      await rm(dest, { recursive: true, force: true });
    }
    await mkdir(root, { recursive: true });
    await rename(path.join(out, name), dest).catch(async () => {
      await cp(path.join(out, name), dest, { recursive: true });
    });
    const commit = (await isIgnored(root, name))
      ? null
      : await commitAndPush(root, [name], `${existed ? "update" : "add"} ${name} (published from ${source})`);
    return { ok: true, name, replaced: existed, problems: staged.problems, commit, error: null };
  } catch (cause) {
    return {
      ok: false,
      name: null,
      replaced: false,
      problems: [],
      commit: null,
      error: cause instanceof Error ? cause.message.slice(0, 500) : String(cause),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Packs a hub skill for `skills-pull`. */
export async function packHubSkill(root: string, name: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (!safeName(name)) throw new Error("invalid skill name");
  if ((await stat(path.join(root, name)).catch(() => null)) === null) throw new Error(`no skill ${name} on the hub`);
  const excludes = SKILL_TAR_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
  const { stdout } = await execFileOutput("tar", ["czf", "-", ...excludes, "-C", root, name], {
    encoding: "buffer",
    maxBuffer: maxBytes + 1,
  });
  if (stdout.length > maxBytes) throw new Error("skill is too large to transfer");
  return stdout.toString("base64");
}

/** Moves a hub skill to the backups and records the removal in git. */
export async function removeHubSkill(root: string, name: string, source: string): Promise<{ ok: boolean; backup: string | null; commit: CommitResult | null; error: string | null }> {
  if (!safeName(name)) return { ok: false, backup: null, commit: null, error: "invalid skill name" };
  const dir = path.join(root, name);
  if ((await stat(dir).catch(() => null)) === null) return { ok: false, backup: null, commit: null, error: "not found" };
  const ignored = await isIgnored(root, name);
  const backup = await backupDir(dir, name, `removed from the hub by ${source}`);
  await rm(dir, { recursive: true, force: true });
  const commit = ignored ? null : await commitAndPush(root, [name], `remove ${name} (by ${source})`);
  return { ok: true, backup, commit, error: null };
}
