import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SKILL_TAR_EXCLUDES } from "./skill-tree.ts";
import { execFileOutput } from "./skills-sync.ts";

/**
 * Machine side of the hub canon: pack a draft for publishing, unpack a hub
 * skill into the drafts folder, and clear the CLI skill folders that would
 * otherwise show every hub skill twice in BB sessions.
 */

/** CLI folders a machine keeps skills in. `keep` entries belong to the CLI itself. */
export const MACHINE_SKILL_HOMES = [
  { id: "agents", path: ".agents/skills", keep: [] as string[] },
  { id: "claude", path: ".claude/skills", keep: ["synced"] },
  { id: "codex", path: ".codex/skills", keep: [] as string[] },
  { id: "bb", path: ".bb/skills", keep: [] as string[] },
  { id: "gemini-config", path: ".gemini/config/skills", keep: [] as string[] },
  { id: "gemini", path: ".gemini/skills", keep: [] as string[] },
  { id: "opencode", path: ".config/opencode/skills", keep: [] as string[] },
  { id: "cursor", path: ".cursor/skills", keep: [] as string[] },
  { id: "qwen", path: ".qwen/skills", keep: [] as string[] },
  { id: "grok", path: ".grok/skills", keep: [] as string[] },
] as const;

export const DRAFTS_DIR = "skill-drafts";
/** Marker file in ~/.agents: this machine keeps no skill copies. */
export const HUB_MARKER = "skills-on-hub";

export function expandHome(value: string, home = os.homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? value : path.join(home, value);
}

async function exists(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => null)) !== null;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type PackResult = { ok: boolean; name: string | null; archiveBase64: string | null; error: string | null };

/** Packs a skill folder (one with SKILL.md) for publishing to the hub. */
export async function packSkillDir(dirInput: string, tarBin: string, maxBytes = 8 * 1024 * 1024): Promise<PackResult> {
  const dir = path.resolve(expandHome(dirInput));
  const name = path.basename(dir);
  if (!(await exists(path.join(dir, "SKILL.md")))) {
    return { ok: false, name, archiveBase64: null, error: `no SKILL.md in ${dir}` };
  }
  try {
    const excludes = SKILL_TAR_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
    const { stdout } = await execFileOutput(tarBin, ["czf", "-", ...excludes, "-C", path.dirname(dir), name], {
      encoding: "buffer",
      maxBuffer: maxBytes + 1,
    });
    if (stdout.length > maxBytes) return { ok: false, name, archiveBase64: null, error: "the packed skill is larger than 8 MB" };
    return { ok: true, name, archiveBase64: stdout.toString("base64"), error: null };
  } catch (cause) {
    return { ok: false, name, archiveBase64: null, error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) };
  }
}

export type UnpackResult = { ok: boolean; path: string | null; previous: string | null; error: string | null };

/** Unpacks a hub skill into `<target>/<name>`; an existing folder is renamed aside, not lost. */
export async function unpackSkill(
  name: string,
  archiveBase64: string,
  targetInput: string | null,
  tarBin: string,
): Promise<UnpackResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(name)) return { ok: false, path: null, previous: null, error: "invalid skill name" };
  const target = path.resolve(expandHome(targetInput ?? DRAFTS_DIR));
  const dest = path.join(target, name);
  let previous: string | null = null;
  try {
    await mkdir(target, { recursive: true });
    if (await exists(dest)) {
      previous = `${dest}.bak-${stamp()}`;
      await rename(dest, previous);
    }
    const tgz = path.join(os.tmpdir(), `agent-tools-pull-${process.pid}-${Date.now()}.tgz`);
    await writeFile(tgz, Buffer.from(archiveBase64, "base64"));
    try {
      await execFileOutput(tarBin, ["xzf", tgz, "-C", target], { maxBuffer: 8 * 1024 * 1024 });
    } finally {
      await rm(tgz, { force: true });
    }
    return { ok: true, path: dest, previous, error: null };
  } catch (cause) {
    return { ok: false, path: dest, previous, error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) };
  }
}

export type HomeCount = { id: string; path: string; skills: number; links: number };

async function entriesOf(dir: string, keep: readonly string[]): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter(
    (name) => !name.startsWith(".") && !keep.includes(name),
  );
}

/** How many skills (folders and links) each CLI folder still holds. */
export async function countSkillHomes(home = os.homedir()): Promise<HomeCount[]> {
  const result: HomeCount[] = [];
  for (const location of MACHINE_SKILL_HOMES) {
    const dir = path.join(home, location.path);
    let skills = 0;
    let links = 0;
    for (const name of await entriesOf(dir, location.keep)) {
      const info = await lstat(path.join(dir, name)).catch(() => null);
      if (info === null) continue;
      if (info.isSymbolicLink()) links += 1;
      else if (info.isDirectory()) skills += 1;
    }
    if (skills + links > 0) result.push({ id: location.id, path: `~/${location.path}`, skills, links });
  }
  return result;
}

export type FoundSkill = { name: string; path: string; home: string; mtime: number };

/**
 * Every skill folder (with SKILL.md) the CLI folders hold, links resolved to
 * their real folder, one entry per name: the newest copy wins. This is what a
 * machine would lose from BB sessions if it is not on the hub.
 */
export async function listMachineSkills(home = os.homedir()): Promise<FoundSkill[]> {
  const byName = new Map<string, FoundSkill>();
  for (const location of MACHINE_SKILL_HOMES) {
    const dir = path.join(home, location.path);
    for (const name of await entriesOf(dir, location.keep)) {
      const real = await realpath(path.join(dir, name)).catch(() => null);
      if (real === null) continue;
      const info = await stat(path.join(real, "SKILL.md")).catch(() => null);
      if (info === null || !info.isFile()) continue;
      const found = { name, path: real, home: `~/${location.path}`, mtime: Math.round(info.mtimeMs) };
      const current = byName.get(name);
      if (current === undefined || found.mtime > current.mtime) byName.set(name, found);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type CleanupResult = { backup: string | null; moved: Array<{ id: string; count: number }>; errors: string[] };

/**
 * Moves every skill out of the CLI folders into one dated backup folder.
 * Folders the CLI owns (`~/.claude/skills/synced`, `~/.codex/skills/.system`)
 * and hidden entries stay. Nothing is deleted.
 */
export async function cleanupSkillHomes(dryRun: boolean, home = os.homedir()): Promise<CleanupResult> {
  const backup = path.join(home, ".agents", "skills-backups", `cleanup-${stamp()}`);
  const moved: CleanupResult["moved"] = [];
  const errors: string[] = [];
  for (const location of MACHINE_SKILL_HOMES) {
    const dir = path.join(home, location.path);
    const names = await entriesOf(dir, location.keep);
    if (names.length === 0) continue;
    moved.push({ id: location.id, count: names.length });
    if (dryRun) continue;
    const dest = path.join(backup, location.id);
    await mkdir(dest, { recursive: true });
    for (const name of names) {
      const from = path.join(dir, name);
      const to = path.join(dest, name);
      try {
        await rename(from, to);
      } catch {
        try {
          const info = await stat(from);
          await cp(from, to, { recursive: info.isDirectory(), verbatimSymlinks: true });
          await rm(from, { recursive: true, force: true });
        } catch (cause) {
          errors.push(`${location.path}/${name}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
        }
      }
    }
    // A git working copy keeps its .git; move it too so the folder is empty for every CLI.
    if (await exists(path.join(dir, ".git"))) {
      await rename(path.join(dir, ".git"), path.join(dest, ".git")).catch((cause: unknown) => {
        errors.push(`${location.path}/.git: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
      });
    }
  }
  if (!dryRun) {
    // Tells installers (Lane Stack and others) to publish skills to the hub
    // instead of copying them back into the CLI folders.
    await mkdir(path.join(home, ".agents"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", HUB_MARKER),
      "Skills on this machine live on the BB hub. Installers: publish with `bb tools skills-publish <folder>` instead of copying into ~/.agents/skills or ~/.claude/skills.\n",
    ).catch((cause: unknown) => errors.push(`${HUB_MARKER}: ${String(cause)}`));
  }
  if (!dryRun && moved.length > 0) {
    await writeFile(
      path.join(backup, "README.txt"),
      "Skills moved out of CLI folders by Agent Tools: the canon now lives on the BB hub.\n" +
        "Each subfolder is one CLI folder (agents = ~/.agents/skills, claude = ~/.claude/skills, ...).\n",
    ).catch(() => undefined);
  }
  return { backup: dryRun || moved.length === 0 ? null : backup, moved, errors };
}
