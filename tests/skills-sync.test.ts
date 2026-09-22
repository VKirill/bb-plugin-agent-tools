import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitBinSearchDirs } from "../i18n.ts";

async function resolveGitBin(): Promise<string | null> {
  const { stat } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  for (const dir of gitBinSearchDirs(process.env.PATH ?? "", homedir())) {
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

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// D2 must exercise the function that the real host handler invokes. Build the
// host entry, then import its named exports instead of testing a duplicate helper.
await execFileAsync("bb", ["plugin", "build", "."], { cwd: pluginRoot });
const hostModule = await import(
  `${pathToFileURL(path.join(pluginRoot, "dist", "host.js")).href}?skills-sync-test=${Date.now()}`
);
const { runGit, syncSkillsCanon } = hostModule;

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv });
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const folder = path.join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), body);
}

async function hashDir(dir: string): Promise<string> {
  const sha = createHash("sha1");
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      const full = path.join(current, name);
      const info = await stat(full);
      const next = rel === "" ? name : `${rel}/${name}`;
      if (info.isDirectory()) {
        await walk(full, next);
        continue;
      }
      sha.update(`${next}:`);
      sha.update(await readFile(full));
    }
  };
  await walk(dir, "");
  return sha.digest("hex");
}

async function createUntrackedConflictFixture(root: string): Promise<{
  remote: string;
  local: string;
  beforeHash: string;
}> {
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const local = path.join(root, "local");
  await execFileAsync("git", ["init", "--bare", remote], { env: gitEnv });
  await execFileAsync("git", ["clone", remote, seed], { env: gitEnv });
  await git(seed, ["checkout", "-b", "main"]);
  await writeSkill(seed, "safe", "safe on both\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "base"]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env: gitEnv });

  await execFileAsync("git", ["clone", remote, local], { env: gitEnv });

  await writeSkill(seed, "incoming", "incoming from remote\n");
  await writeSkill(seed, "overlap", "overlap from remote\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "remote extras"]);
  await git(seed, ["push"]);

  await mkdir(path.join(local, "overlap"), { recursive: true });
  await writeFile(path.join(local, "overlap", "ORIGINAL.md"), "local original\n");
  await writeFile(path.join(local, "overlap", "SKILL.md"), "local skill must survive\n");
  await writeFile(path.join(local, "overlap", "SOURCE.md"), "local source\n");
  return {
    remote,
    local,
    beforeHash: await hashDir(path.join(local, "overlap")),
  };
}

test("ветка skills_sync на git-фикстуре: rebase отменён, недостающие докачаны, своё не тронуто, push → ok:false", async () => {
  const gitBin = await resolveGitBin();
  assert.ok(gitBin, "git должен быть на машине теста");
  const root = await mkdtemp(path.join(tmpdir(), "skills-sync-"));
  try {
    const { remote, local, beforeHash } = await createUntrackedConflictFixture(root);

    const result = await syncSkillsCanon(local, remote, {
      gitBin,
      hostname: "fixture",
      runGit: async (bin, args) => {
        if (args.includes("push") && !args.includes("--rebase")) {
          throw Object.assign(new Error("Command failed: git push"), {
            stderr: "fatal: unable to access remote",
          });
        }
        return runGit(bin, args);
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /push не выполнен/);
    assert.equal(await exists(path.join(local, ".git", "rebase-merge")), false);
    assert.equal(await exists(path.join(local, ".git", "rebase-apply")), false);
    assert.equal(await exists(path.join(local, "incoming", "SKILL.md")), true);
    assert.equal(await readFile(path.join(local, "incoming", "SKILL.md"), "utf8"), "incoming from remote\n");
    assert.equal(await hashDir(path.join(local, "overlap")), beforeHash);
    assert.equal(await readFile(path.join(local, "overlap", "SKILL.md"), "utf8"), "local skill must survive\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ветка skills_sync возвращает ok:true только после сведения истории и push", async () => {
  const gitBin = await resolveGitBin();
  assert.ok(gitBin, "git должен быть на машине теста");
  const root = await mkdtemp(path.join(tmpdir(), "skills-sync-success-"));
  try {
    const { remote, local, beforeHash } = await createUntrackedConflictFixture(root);
    const result = await syncSkillsCanon(local, remote, {
      gitBin,
      hostname: "fixture",
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(await exists(path.join(local, ".git", "rebase-merge")), false);
    assert.equal(await exists(path.join(local, ".git", "rebase-apply")), false);
    assert.equal(await readFile(path.join(local, "incoming", "SKILL.md"), "utf8"), "incoming from remote\n");
    assert.equal(await hashDir(path.join(local, "overlap")), beforeHash);

    const verification = path.join(root, "verification");
    await execFileAsync("git", ["clone", remote, verification], { env: gitEnv });
    assert.equal(await readFile(path.join(verification, "incoming", "SKILL.md"), "utf8"), "incoming from remote\n");
    assert.equal(await readFile(path.join(verification, "overlap", "SKILL.md"), "utf8"), "local skill must survive\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("неудачный pull без untracked-ветки возвращает ok:false и не доходит до push", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-sync-pull-fail-"));
  try {
    await mkdir(path.join(root, ".git"));
    const calls: string[][] = [];
    const result = await syncSkillsCanon(root, "ssh://example/repo.git", {
      gitBin: "/usr/bin/git",
      runGit: async (_bin, args) => {
        calls.push(args);
        if (args.includes("get-url")) return { stdout: "ssh://example/repo.git\n", stderr: "" };
        if (args.includes("pull")) {
          throw Object.assign(new Error("pull failed"), { stderr: "fatal: network unavailable" });
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network unavailable/);
    assert.equal(calls.some((args) => args.includes("push")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("неудачный checkout недостающей папки возвращает ok:false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-sync-checkout-fail-"));
  try {
    await mkdir(path.join(root, ".git"));
    const result = await syncSkillsCanon(root, "ssh://example/repo.git", {
      gitBin: "/usr/bin/git",
      runGit: async (_bin, args) => {
        if (args.includes("get-url")) return { stdout: "ssh://example/repo.git\n", stderr: "" };
        if (args.includes("pull")) {
          throw Object.assign(new Error("pull failed"), {
            stderr:
              "error: The following untracked working tree files would be overwritten by merge:\n" +
              "\tincoming/SKILL.md\nPlease move or remove them before you merge.\nAborting\n",
          });
        }
        if (args.includes("fetch")) return { stdout: "", stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args.includes("ls-tree")) return { stdout: "incoming\n", stderr: "" };
        if (args.includes("checkout")) {
          throw Object.assign(new Error("checkout failed"), { stderr: "fatal: checkout failed" });
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /checkout failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
