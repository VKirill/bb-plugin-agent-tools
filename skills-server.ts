import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { SkillLocationScan } from "./skills.js";

const execFileAsync = promisify(execFile);
const FINGERPRINT_MAX_FILES = 500;

function isSkillJunk(name: string): boolean {
  if (name === "__pycache__" || name === "node_modules" || name === ".git") return true;
  if (name === ".DS_Store" || name === ".backup.json") return true;
  return name.endsWith(".pyc") || name.endsWith(".bak") || name.endsWith(".tmp");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fingerprintDir(dir: string): Promise<{ hash: string; mtime: number; bytes: number } | null> {
  const sha = createHash("sha1");
  let newest = 0;
  let count = 0;
  let bytes = 0;
  const walk = async (current: string, rel: string, depth: number): Promise<void> => {
    if (depth > 6 || count > FINGERPRINT_MAX_FILES) return;
    const items = await readdir(current).catch(() => [] as string[]);
    for (const item of items.sort()) {
      if (isSkillJunk(item) || item.startsWith(".")) continue;
      const full = path.join(current, item);
      const relPath = rel === "" ? item : `${rel}/${item}`;
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      if (info.isDirectory()) {
        count += 1;
        await walk(full, relPath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      count += 1;
      if (count > FINGERPRINT_MAX_FILES) return;
      newest = Math.max(newest, info.mtimeMs);
      bytes += info.size;
      const text = await readFile(full).catch(() => null);
      sha.update(`${relPath}:${info.size}:`);
      if (text !== null) sha.update(text);
    }
  };
  await walk(dir, "", 0);
  if (count === 0) return null;
  return { hash: sha.digest("hex").slice(0, 12), mtime: newest, bytes };
}

export function bbServerSkillsDir(dataDir: string): string {
  return path.join(dataDir, "skills");
}

export function canonSkillsDir(home = os.homedir()): string {
  return path.join(home, ".agents", "skills");
}

export async function scanSkillHome(id: string, dir: string): Promise<SkillLocationScan> {
  const real = await exists(dir);
  const entries: SkillLocationScan["entries"] = [];
  if (real) {
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (info === null) continue;
      const isSymlink = info.isSymbolicLink();
      const hasSkillMd = await exists(path.join(full, "SKILL.md"));
      const fingerprint = hasSkillMd ? await fingerprintDir(full) : null;
      entries.push({
        name,
        kind: isSymlink ? "symlink" : "dir",
        target: null,
        hash: fingerprint?.hash ?? null,
        mtime: fingerprint?.mtime ?? null,
        hasSkillMd,
        bytes: fingerprint?.bytes ?? 0,
      });
    }
  }
  return {
    id,
    path: dir,
    exists: real,
    parentExists: !real && (await exists(path.dirname(dir))),
    entries,
  };
}

async function backupSkillDir(source: string, name: string, reason: string): Promise<void> {
  const info = await lstat(source).catch(() => null);
  if (info === null || info.isSymbolicLink()) return;
  const dest = path.join(
    os.homedir(),
    ".agents",
    "skills-backups",
    name,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, dereference: true });
  await writeFile(
    path.join(dest, ".backup.json"),
    `${JSON.stringify({ name, at: new Date().toISOString(), reason, locationId: "bb-server", machine: os.hostname() }, null, 2)}\n`,
  );
}

export async function mirrorSkillFromCanon(canonRoot: string, destRoot: string, name: string, dryRun: boolean): Promise<void> {
  const here = path.join(destRoot, name);
  const canon = path.join(canonRoot, name);
  if (dryRun) return;
  await backupSkillDir(here, name, "заменено каноном на сервере BB");
  await rm(here, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  await cp(canon, here, { recursive: true, dereference: true });
}

export async function extractSkillArchive(destRoot: string, name: string, archiveBase64: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const here = path.join(destRoot, name);
  await backupSkillDir(here, name, "заменено архивом с машины");
  await rm(here, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  const tmp = path.join(os.tmpdir(), `bb-agent-tools-skill-${process.pid}-${Date.now()}.tgz`);
  await writeFile(tmp, Buffer.from(archiveBase64, "base64"));
  try {
    await execFileAsync("tar", ["xzf", tmp, "-C", destRoot], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await rm(tmp, { force: true });
  }
}

export function isSafeSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}
