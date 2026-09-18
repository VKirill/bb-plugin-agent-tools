// Full-trust entry: runs on every enrolled machine, reads each CLI's MCP
// config and writes the ones the catalogue asks for. Writes are atomic
// (temp file + rename) and always leave a timestamped backup behind.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readFile, writeFile, rename, stat, chmod, mkdir, readdir, unlink, copyFile, cp, symlink, lstat, readlink, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENTS, EXTRA_CLI_BINS, type AgentConfigFile } from "./agents.js";
import { hostContract, type DetectedAgent, type McpServer, type OpenCodeScan, type OpenCodeApplyResult, type HostCliPluginsScan, type OpenCodeOp, type SkillsScan } from "./contract.js";
import { fromDialect, mergeEntry, toDialect } from "./normalize.js";
import { readServers, removeServer, upsertServer } from "./toml-mcp.js";
import { locationPolicy, planFanOut, type FanOutOp, type FanOutState, type SkillActionMode } from "./skills.js";
import { probeServer } from "./probe.js";
import { parseOpenCodeText, applyOpenCodeOps } from "./opencode.js";

const BACKUP_PREFIX = ".bak-bb-mcp-";

/**
 * Мусор, который не считается содержимым скилла: следы сборки и редактора.
 * Иначе `__pycache__` и `.bak` делают версии «расходящимися» на пустом месте.
 */
function isSkillJunk(name: string): boolean {
  if (name === "__pycache__" || name === "node_modules" || name === ".git") return true;
  if (name === ".DS_Store" || name === ".backup.json") return true;
  return name.endsWith(".pyc") || name.endsWith(".bak") || name.endsWith(".tmp");
}

const FINGERPRINT_MAX_FILES = 500;
/** Отпечаток всей папки скилла: содержимое всех файлов (без .git/node_modules)
 *  и самая свежая правка среди них — скрипты и референсы меняют «новизну» наравне с SKILL.md. */
async function fingerprintDir(dir: string): Promise<{ hash: string; mtime: number } | null> {
  const sha = createHash("sha1");
  let newest = 0;
  let count = 0;
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
      const text = await readFile(full).catch(() => null);
      sha.update(`${relPath}:${info.size}:`);
      if (text !== null) sha.update(text);
    }
  };
  await walk(dir, "", 0);
  if (count === 0) return null;
  return { hash: sha.digest("hex").slice(0, 12), mtime: newest };
}
const BACKUPS_KEPT = 5;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const home = os.homedir();
const runGit = promisify(execFile);

function expand(relative: string): string {
  return path.join(home, relative);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(): string[] {
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = [
    expand(".local/bin"),
    expand(".bun/bin"),
    expand(".npm-global/bin"),
    expand("bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/snap/bin",
  ];
  return [...new Set([...fromPath, ...extra])];
}

async function findBin(names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    for (const dir of searchDirs()) {
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

/** JSON with // and /* *​/ comments; returns null when the text has comments. */
function stripComments(text: string): { json: string; hadComments: boolean } {
  let out = "";
  let hadComments = false;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      hadComments = true;
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      hadComments = true;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return { json: out, hadComments };
}

interface LoadedConfig {
  readonly file: AgentConfigFile;
  readonly absolute: string;
  readonly text: string | null;
  readonly servers: McpServer[];
  readonly writable: boolean;
  readonly warning: string | null;
}

async function loadConfig(file: AgentConfigFile): Promise<LoadedConfig> {
  const absolute = expand(file.path);
  let text: string;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_CONFIG_BYTES) {
      return { file, absolute, text: null, servers: [], writable: false, warning: "файл слишком большой" };
    }
    text = await readFile(absolute, "utf8");
  } catch {
    return { file, absolute, text: null, servers: [], writable: true, warning: null };
  }

  if (file.format === "toml") {
    const tables = readServers(text, file.pointer);
    const servers: McpServer[] = [];
    for (const [name, raw] of Object.entries(tables)) {
      const parsed = fromDialect(file.style, name, raw);
      if (parsed !== null) servers.push(parsed);
    }
    return { file, absolute, text, servers, writable: true, warning: null };
  }

  const { json, hadComments } = stripComments(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json === "" ? "{}" : json);
  } catch (cause) {
    return {
      file,
      absolute,
      text,
      servers: [],
      writable: false,
      warning: `не удалось разобрать: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const bucket = (parsed as Record<string, unknown> | null)?.[file.pointer];
  const servers: McpServer[] = [];
  if (bucket !== null && typeof bucket === "object" && !Array.isArray(bucket)) {
    for (const [name, raw] of Object.entries(bucket as Record<string, unknown>)) {
      const server = fromDialect(file.style, name, raw);
      if (server !== null) servers.push(server);
    }
  }
  return {
    file,
    absolute,
    text,
    servers,
    writable: !hadComments,
    warning: hadComments ? "в файле есть комментарии — плагин его не перезаписывает" : null,
  };
}

/** Pick the config that exists; fall back to the canonical candidate. */
async function pickConfig(files: readonly AgentConfigFile[]): Promise<LoadedConfig> {
  const loaded = await Promise.all(files.map(loadConfig));
  return loaded.find((entry) => entry.text !== null) ?? loaded[0]!;
}

async function backup(absolute: string): Promise<string | null> {
  if (!(await exists(absolute))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${absolute}${BACKUP_PREFIX}${stamp}`;
  await copyFile(absolute, target);
  const dir = path.dirname(absolute);
  const base = path.basename(absolute);
  const siblings = (await readdir(dir))
    .filter((name) => name.startsWith(`${base}${BACKUP_PREFIX}`))
    .sort();
  for (const stale of siblings.slice(0, Math.max(0, siblings.length - BACKUPS_KEPT))) {
    await unlink(path.join(dir, stale)).catch(() => {});
  }
  return target;
}

async function writeAtomic(absolute: string, contents: string): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true });
  let mode = 0o600;
  try {
    mode = (await stat(absolute)).mode & 0o777;
  } catch {
    // new file keeps the private default
  }
  const temp = `${absolute}.bb-mcp-${process.pid}.tmp`;
  await writeFile(temp, contents, { mode });
  await chmod(temp, mode);
  await rename(temp, absolute);
}

function applyToJson(
  text: string | null,
  file: AgentConfigFile,
  action: "upsert" | "remove",
  server: McpServer,
): string {
  const source = text === null || text.trim() === "" ? "{}" : stripComments(text).json;
  const document = JSON.parse(source) as Record<string, unknown>;
  const bucket =
    document[file.pointer] !== null &&
    typeof document[file.pointer] === "object" &&
    !Array.isArray(document[file.pointer])
      ? (document[file.pointer] as Record<string, unknown>)
      : {};
  if (action === "remove") delete bucket[server.name];
  else bucket[server.name] = mergeEntry(bucket[server.name], toDialect(file.style, server));
  document[file.pointer] = bucket;
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Папки скиллов, которые читают CLI. Канон — первый: живой дом, остальные — алиасы/дома CLI. */
const SKILL_LOCATIONS = [
  { id: "agents", path: ".agents/skills" },
  { id: "claude", path: ".claude/skills" },
  { id: "codex", path: ".codex/skills" },
  { id: "gemini-config", path: ".gemini/config/skills" },
  { id: "bb", path: ".bb/skills" },
  { id: "opencode", path: ".config/opencode/skills" },
  { id: "cursor", path: ".cursor/skills" },
  { id: "qwen", path: ".qwen/skills" },
] as const;

const SKILL_BACKUP_ROOT = ".agents/skills-backups";
const SKILL_FANOUT_STATE = ".agents/skills-fanout.json";

/** Метка времени снимка: пригодна и для имени папки, и для показа в списке. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readFanOutState(): Promise<FanOutState> {
  const text = await readFile(expand(SKILL_FANOUT_STATE), "utf8").catch(() => null);
  if (text === null) return { entries: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = (parsed as { entries?: FanOutState["entries"] })?.entries;
    return { entries: entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

/**
 * Снимок папки скилла в архив. Снимаем перед каждой перезаписью и удалением —
 * это единственная страховка человека от того, что правило выбрало не ту версию.
 */
async function backupSkillDir(
  source: string,
  name: string,
  locationId: string,
  reason: string,
): Promise<string | null> {
  const info = await lstat(source).catch(() => null);
  if (info === null || info.isSymbolicLink()) return null;
  const dest = path.join(expand(SKILL_BACKUP_ROOT), name, stamp());
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, dereference: true });
  const fingerprint = await fingerprintDir(dest);
  await writeFile(
    path.join(dest, ".backup.json"),
    `${JSON.stringify({ name, at: new Date().toISOString(), reason, locationId, machine: os.hostname(), hash: fingerprint?.hash ?? null }, null, 2)}\n`,
  );
  return dest;
}

/** Размер и число файлов снимка — чтобы список архива был информативным. */
async function measureDir(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const item of await readdir(current).catch(() => [] as string[])) {
      const full = path.join(current, item);
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      if (info.isDirectory()) await walk(full, depth + 1);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

/**
 * Имена скиллов, которые сессии и так получают из плагинов. Плагины лежат в
 * разных корнях и на разной глубине (маркетплейсы Claude Code, плагины BB,
 * кэш Codex), поэтому ищем папки `skills` обходом с ограничением глубины.
 */
async function pluginSkillNames(): Promise<string[]> {
  const roots = [
    expand(".claude/plugins"),
    expand(".bb/plugins"),
    expand(".codex/plugins"),
    expand(".local/share/bb-server-runtime"),
  ];
  const names = new Set<string>();
  const skip = new Set(["node_modules", ".git", "dist", "build", ".cache", "test", "tests"]);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (!item.isDirectory() || skip.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.name === "skills") {
        for (const child of await readdir(full).catch(() => [] as string[])) {
          if (child.startsWith(".")) continue;
          if (await exists(path.join(full, child, "SKILL.md"))) names.add(child);
        }
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return [...names].sort();
}

/** Один скан всех домов скиллов: им пользуются и вкладка «Скиллы», и раскатка. */
async function scanSkills(signal?: AbortSignal): Promise<SkillsScan> {
  const locations: SkillsScan["locations"] = [];
  const canonicalDir = expand(".agents/skills");
  const seenReal = new Set<string>();
  for (const location of SKILL_LOCATIONS) {
    signal?.throwIfAborted();
    const dir = expand(location.path);
    const real = await realpathOrNull(dir);
    if (real !== null) {
      if (seenReal.has(real)) {
        locations.push({ id: location.id, path: dir, exists: true, parentExists: false, entries: [] });
        continue;
      }
      seenReal.add(real);
    }
    const entries: SkillsScan["locations"][number]["entries"] = [];
    if (real !== null) {
      const names = (await readdir(dir).catch(() => [] as string[])).sort();
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const full = path.join(dir, name);
        const info = await lstat(full).catch(() => null);
        if (info === null) continue;
        const isSymlink = info.isSymbolicLink();
        // У битой ссылки realpath не работает — тогда читаем саму ссылку,
        // иначе «указывает в канон, которого больше нет» выглядит как ссылка в никуда.
        const resolved = isSymlink
          ? ((await realpathOrNull(full)) ?? (await readlink(full).catch(() => null)))
          : null;
        const hasSkillMd = await exists(path.join(full, "SKILL.md"));
        const fingerprint = hasSkillMd ? await fingerprintDir(full) : null;
        entries.push({
          name,
          kind: isSymlink ? "symlink" : "dir",
          target: resolved,
          hash: fingerprint?.hash ?? null,
          mtime: fingerprint?.mtime ?? null,
          hasSkillMd,
        });
      }
    }
    locations.push({
      id: location.id,
      path: dir,
      exists: real !== null,
      // Папка скиллов может отсутствовать, хотя сам CLI на машине есть —
      // тогда раскатка её создаст, а не пройдёт мимо.
      parentExists: real === null && (await exists(path.dirname(dir))),
      entries,
    });
  }
  return { canonicalPath: canonicalDir, pluginNames: await pluginSkillNames(), locations };
}

/** Относительные пути всех файлов скилла — для проверки «не потеряем ли файлы». */
async function skillFileSet(dir: string): Promise<Set<string>> {
  const files = new Set<string>();
  const walk = async (current: string, rel: string, depth: number): Promise<void> => {
    if (depth > 6 || files.size > 2000) return;
    for (const item of await readdir(current).catch(() => [] as string[])) {
      if (isSkillJunk(item)) continue;
      const full = path.join(current, item);
      const relPath = rel === "" ? item : `${rel}/${item}`;
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      if (info.isDirectory()) await walk(full, relPath, depth + 1);
      else if (info.isFile()) files.add(relPath);
    }
  };
  await walk(dir, "", 0);
  return files;
}

/**
 * Замена версии допустима, только если новая содержит все файлы старой. Иначе
 * это не «свежая правка», а другая ветка работы: дату сравнивать бессмысленно,
 * нужен человек. Возвращает список файлов, которые пропали бы.
 */
async function wouldLoseFiles(loser: string, winner: string): Promise<string[]> {
  const [mine, theirs] = await Promise.all([skillFileSet(loser), skillFileSet(winner)]);
  return [...mine].filter((file) => !theirs.has(file)).sort();
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

async function adoptSkill(
  locationId: string,
  name: string,
  mode: SkillActionMode,
): Promise<{ ok: boolean; error: string | null }> {
  const canonicalDir = expand(".agents/skills");
  const canonicalName = path.join(canonicalDir, name);
  const location = SKILL_LOCATIONS.find((item) => item.id === locationId);
  if (location === undefined) return { ok: false, error: "неизвестная папка" };
  if (locationId === "agents") return { ok: false, error: "скилл уже в каноне" };
  const policy = locationPolicy(locationId);
  // Папка со своим реестром (BB) — только руками её хозяина: замена реальной
  // папки симлинком выкидывает скилл из реестра bb-user.
  if (policy === "own") {
    return { ok: false, error: "у этой папки свой реестр — плагин её не меняет" };
  }
  // Симлинк на месте копии нужен там, где CLI читает исключительно свою папку
  // (Claude Code). Codex/Cursor/OpenCode читают канон сами, а папку Gemini мы
  // не используем вовсе — там ничего не остаётся.
  const leavesLink = policy === "link";
  const original = path.join(expand(location.path), name);
  const info = await lstat(original).catch(() => null);
  if (info === null) return { ok: false, error: "скилл не найден в папке" };
  if (info.isSymbolicLink()) {
    if (mode !== "unlink") return { ok: false, error: "это уже симлинк" };
    // Ссылку разрешено убирать в папке, которую мы не используем, и в случае
    // дубля реестра BB (ссылка ведёт в ~/.bb/skills — эти скиллы BB подставляет сам).
    const target = await realpathOrNull(original);
    const bbHome = expand(".bb/skills");
    const isBbRegistry = target !== null && (target === bbHome || target.startsWith(`${bbHome}/`));
    if (policy !== "drop" && !isBbRegistry) {
      return { ok: false, error: "ссылку в этой папке убирать нельзя — её читает CLI" };
    }
    await unlink(original);
    return { ok: true, error: null };
  }
  if (mode === "unlink") return { ok: false, error: "это не ссылка, а реальная папка" };
  if (!await exists(path.join(original, "SKILL.md"))) {
    return { ok: false, error: "в папке нет SKILL.md" };
  }
  if (mode === "delete" && leavesLink) {
    return { ok: false, error: "этот CLI не читает ~/.agents/skills — нужен симлинк" };
  }
  await mkdir(canonicalDir, { recursive: true });
  if (mode === "delete") {
    await rm(original, { recursive: true, force: true });
    return { ok: true, error: null };
  }
  if (mode === "take") {
    if (await exists(canonicalName)) {
      const backupRoot = expand(".agents/skills-backups");
      await mkdir(backupRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(canonicalName, path.join(backupRoot, `${name}.${stamp}`));
    }
    await rename(original, canonicalName);
    if (leavesLink) await symlink(canonicalName, original);
    return { ok: true, error: null };
  }
  if (mode === "adopt") {
    if (await exists(canonicalName)) {
      return { ok: false, error: "в каноне уже есть скилл с этим именем" };
    }
    await rename(original, canonicalName);
  } else {
    if (!await exists(canonicalName)) {
      return { ok: false, error: "в каноне нет такого скилла" };
    }
    const backupRoot = expand(".agents/skills-backups");
    await mkdir(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(original, path.join(backupRoot, `${name}.${stamp}`));
  }
  if (leavesLink) await symlink(canonicalName, original);
  return { ok: true, error: null };
}

async function scanOpenCode(): Promise<OpenCodeScan> {
  const binPath = await findBin(["opencode"]);
  const candidates = [
    expand(".config/opencode/opencode.json"),
    expand(".config/opencode/opencode.jsonc"),
  ];

  let foundPath: string | null = null;
  let text: string | null = null;
  let writable = true;
  let warning: string | null = null;

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        foundPath = candidate;
        text = await readFile(candidate, "utf8");
        const { hadComments } = stripComments(text);
        if (hadComments) {
          writable = false;
          warning = "в файле есть комментарии — плагин его не перезаписывает";
        }
        break;
      }
    } catch {
      // try next
    }
  }

  if (foundPath === null) {
    return {
      installed: binPath !== null,
      binPath,
      configPath: candidates[0] ?? null,
      configExists: false,
      writable: false,
      model: null,
      smallModel: null,
      enabledProviders: [],
      providers: {},
      plugins: [],
      warning: null,
    };
  }

  const { json } = stripComments(text ?? "{}");
  const parsed = parseOpenCodeText(json);

  return {
    installed: binPath !== null || text !== null,
    binPath,
    configPath: foundPath,
    configExists: true,
    writable,
    model: parsed.model,
    smallModel: parsed.smallModel,
    enabledProviders: parsed.enabledProviders,
    providers: parsed.providers,
    plugins: parsed.plugins,
    warning,
  };
}

async function applyOpenCode(
  ops: OpenCodeOp[],
  dryRun: boolean,
): Promise<OpenCodeApplyResult> {
  const candidates = [
    expand(".config/opencode/opencode.json"),
    expand(".config/opencode/opencode.jsonc"),
  ];

  let targetPath: string | null = null;
  let text: string | null = null;
  let hadComments = false;

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        targetPath = candidate;
        text = await readFile(candidate, "utf8");
        hadComments = stripComments(text).hadComments;
        break;
      }
    } catch {
      // try next
    }
  }

  if (targetPath === null) {
    return { ok: false, backups: [], error: "конфиг OpenCode не найден", scan: null };
  }

  if (hadComments) {
    return { ok: false, backups: [], error: "в файле есть комментарии — плагин его не перезаписывает", scan: null };
  }

  const { json } = stripComments(text ?? "{}");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json === "" ? "{}" : json);
  } catch (cause) {
    return {
      ok: false,
      backups: [],
      error: `ошибка разбора JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      scan: null,
    };
  }

  const updatedDoc = applyOpenCodeOps(doc, ops);
  const newText = JSON.stringify(updatedDoc, null, 2) + "\n";
  const backups: string[] = [];

  if (!dryRun && newText !== text) {
    const savedBackup = await backup(targetPath);
    if (savedBackup !== null) backups.push(savedBackup);
    await writeAtomic(targetPath, newText);
  }

  const scan = await scanOpenCode();
  return { ok: true, backups, error: null, scan };
}

async function scanHostCliPlugins(): Promise<HostCliPluginsScan> {
  const plugins: HostCliPluginsScan["plugins"] = [];

  // 1. Claude Code plugins
  const claudeInstalledPath = expand(".claude/plugins/installed_plugins.json");
  const claudeSettingsPath = expand(".claude/settings.json");
  try {
    const raw = JSON.parse(await readFile(claudeInstalledPath, "utf8"));
    let enabledMap: Record<string, boolean> = {};
    try {
      enabledMap = JSON.parse(await readFile(claudeSettingsPath, "utf8")).enabledPlugins ?? {};
    } catch {}

    for (const [id, installs] of Object.entries(raw.plugins ?? {})) {
      const first = Array.isArray(installs) ? installs[0] : null;
      const [name, marketplace] = id.split("@");
      plugins.push({
        id,
        agent: "claude-code",
        name: name ?? id,
        marketplace: marketplace ?? null,
        version: typeof first?.version === "string" ? first.version : null,
        scope: typeof first?.scope === "string" ? first.scope : "user",
        enabled: enabledMap[id] !== false,
        installPath: typeof first?.installPath === "string" ? first.installPath : null,
      });
    }
  } catch {}

  // 2. OpenCode plugins
  for (const cName of [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc"]) {
    const cPath = expand(cName);
    try {
      const text = await readFile(cPath, "utf8");
      const { json } = stripComments(text);
      const doc = JSON.parse(json === "" ? "{}" : json);
      if (Array.isArray(doc.plugin)) {
        for (const item of doc.plugin) {
          if (typeof item !== "string") continue;
          const parts = item.split("@");
          const name = parts[0]!.replace(/^\.\/plugins\//, "").replace(/\.ts$/, "");
          plugins.push({
            id: item,
            agent: "opencode",
            name,
            marketplace: null,
            version: parts[1] ?? null,
            scope: item.startsWith(".") ? "local" : "npm",
            enabled: true,
            installPath: item.startsWith(".") ? path.join(path.dirname(cPath), item) : null,
          });
        }
      }
      break;
    } catch {}
  }

  // 3. Codex plugins
  const codexPath = expand(".codex/config.toml");
  try {
    const text = await readFile(codexPath, "utf8");
    const re = /\[plugins\."([^"]+)"\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]!;
      const [name, source] = id.split("@");
      plugins.push({
        id,
        agent: "codex",
        name: name ?? id,
        marketplace: source ?? null,
        version: null,
        scope: source ?? "bundled",
        enabled: true,
        installPath: null,
      });
    }
  } catch {}

  return { plugins };
}

export default experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      scan: async (_input, ctx) => {
        const agents: DetectedAgent[] = [];
        for (const agent of AGENTS) {
          ctx.signal.throwIfAborted();
          const binPath = agent.bins.length === 0 ? null : await findBin(agent.bins);
          const config = await pickConfig(agent.configs);
          const installed = agent.gateway === true ? config.text !== null : binPath !== null;
          agents.push({
            kind: agent.kind,
            label: agent.label,
            installed,
            binPath,
            configPath: config.absolute,
            configExists: config.text !== null,
            writable: config.writable,
            gateway: agent.gateway === true,
            servers: config.servers,
            warning: config.warning,
          });
        }
        const otherClis: { bin: string; path: string }[] = [];
        for (const bin of EXTRA_CLI_BINS) {
          const found = await findBin([bin]);
          if (found !== null) otherClis.push({ bin, path: found });
        }
        return {
          hostname: os.hostname(),
          platform: process.platform,
          home,
          scannedAt: Date.now(),
          agents,
          otherClis,
        };
      },

      probe: async ({ targets, timeoutMs }, ctx) => {
        const results: {
          kind: string;
          name: string;
          ok: boolean;
          tools: number | null;
          error: string | null;
          durationMs: number;
          checkedAt: number;
        }[] = [];
        // Проверяем по одному: параллельный запуск десятка MCP-серверов
        // заметно нагружает машину пользователя.
        for (const target of targets) {
          ctx.signal.throwIfAborted();
          const agent = AGENTS.find((candidate) => candidate.kind === target.kind);
          const started = Date.now();
          if (agent === undefined) {
            results.push({
              ...target,
              ok: false,
              tools: null,
              error: "неизвестный агент",
              durationMs: 0,
              checkedAt: started,
            });
            continue;
          }
          const config = await pickConfig(agent.configs);
          const server = config.servers.find((candidate) => candidate.name === target.name);
          if (server === undefined) {
            results.push({
              ...target,
              ok: false,
              tools: null,
              error: "сервер не найден в конфиге",
              durationMs: 0,
              checkedAt: started,
            });
            continue;
          }
          const outcome = await probeServer(server, timeoutMs);
          results.push({
            ...target,
            ...outcome,
            durationMs: Date.now() - started,
            checkedAt: started,
          });
        }
        return { results };
      },

      skills_scan: async (_input, ctx) => scanSkills(ctx.signal),

      skills_adopt: async ({ locationId, name, mode }) => adoptSkill(locationId, name, mode),

      skills_adopt_bulk: async ({ ops }, ctx) => {
        const results: { name: string; ok: boolean; error: string | null }[] = [];
        for (const op of ops) {
          ctx.signal.throwIfAborted();
          const outcome = await adoptSkill(op.locationId, op.name, op.mode);
          results.push({ name: op.name, ok: outcome.ok, error: outcome.error });
        }
        return { results };
      },

      /**
       * Синк канона с git-remote из настроек плагина. Если ~/.agents/skills ещё
       * не репозиторий — мигрирует: прежнее содержимое возвращается в клон,
       * локальные симлинки уходят в .gitignore. Дальше pull --rebase + commit+push.
       */
      /**
       * Раскатка канона по домам: Claude Code получает симлинки, BB — реальное
       * зеркало (его реестр видит только папки), всё заменяемое и пропадающее
       * уходит в архив. Возвращает то, что сделала, по операциям.
       */
      skills_fanout: async ({ pluginNames, dryRun }, ctx) => {
        const scan = await scanSkills(ctx.signal);
        const state = await readFanOutState();
        // "*" — владелец попросил раскатать канон целиком, без исключений по
        // плагинам; пустой список — считаем плагинные имена сами.
        const names = pluginNames.includes("*")
          ? []
          : pluginNames.length > 0
            ? pluginNames
            : scan.pluginNames;
        const plan = planFanOut({
          canonicalPath: scan.canonicalPath,
          locations: scan.locations,
          pluginNames: names,
          state,
        });
        const results: (FanOutOp & { ok: boolean; error: string | null })[] = [];
        const canonDir = scan.canonicalPath;
        for (const op of plan.ops) {
          ctx.signal.throwIfAborted();
          const location = scan.locations.find((item) => item.id === op.locationId);
          if (location === undefined) {
            results.push({ ...op, ok: false, error: "папка не найдена" });
            continue;
          }
          const here = path.join(location.path, op.name);
          const canon = path.join(canonDir, op.name);
          if (dryRun) {
            results.push({ ...op, ok: true, error: null });
            continue;
          }
          try {
            if (op.kind === "link") {
              const info = await lstat(here).catch(() => null);
              if (info !== null && !info.isSymbolicLink()) throw new Error("на месте реальная папка");
              if (info !== null) await unlink(here);
              await mkdir(location.path, { recursive: true });
              await symlink(canon, here);
            } else if (op.kind === "mirror") {
              const lost = await wouldLoseFiles(here, canon);
              if (lost.length > 0) {
                throw new Error(
                  `в доме есть файлы, которых нет в каноне (${lost.slice(0, 3).join(", ")}${lost.length > 3 ? "…" : ""}) — нужен ручной разбор`,
                );
              }
              await backupSkillDir(here, op.name, op.locationId, `заменено каноном: ${op.reason}`);
              await rm(here, { recursive: true, force: true });
              await mkdir(location.path, { recursive: true });
              await cp(canon, here, { recursive: true, dereference: true });
            } else if (op.kind === "pull") {
              const lost = await wouldLoseFiles(canon, here);
              if (lost.length > 0) {
                throw new Error(
                  `в каноне есть файлы, которых нет в новой версии (${lost.slice(0, 3).join(", ")}${lost.length > 3 ? "…" : ""}) — нужен ручной разбор`,
                );
              }
              await backupSkillDir(canon, op.name, "agents", `заменено версией из ${op.locationId}: ${op.reason}`);
              await rm(canon, { recursive: true, force: true });
              await cp(here, canon, { recursive: true, dereference: true });
            } else if (op.kind === "retire") {
              await backupSkillDir(canon, op.name, "agents", `удалён в ${op.locationId}: ${op.reason}`);
              await rm(canon, { recursive: true, force: true });
            } else {
              const info = await lstat(here).catch(() => null);
              if (info === null) throw new Error("уже нет");
              if (info.isSymbolicLink()) await unlink(here);
              else {
                await backupSkillDir(here, op.name, op.locationId, `убрано из дома: ${op.reason}`);
                await rm(here, { recursive: true, force: true });
              }
            }
            results.push({ ...op, ok: true, error: null });
          } catch (cause) {
            results.push({ ...op, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
          }
        }
        if (!dryRun) {
          await writeFile(
            expand(SKILL_FANOUT_STATE),
            `${JSON.stringify({ at: new Date().toISOString(), entries: plan.nextState.entries }, null, 2)}\n`,
          );
        }
        return { ops: results, skippedByPlugin: plan.skippedByPlugin };
      },

      /**
       * Архив снимков: и новый вид (<имя>/<время>/), и старый плоский
       * (<имя>.<время>) — ничего из уже накопленного не теряем.
       */
      skills_backups_list: async () => {
        const root = expand(SKILL_BACKUP_ROOT);
        const canonDir = expand(".agents/skills");
        const backups: {
          id: string;
          name: string;
          at: string;
          reason: string;
          locationId: string;
          hash: string | null;
          files: number;
          bytes: number;
          unique: boolean;
        }[] = [];
        const seenHashes = new Set<string>();
        const collect = async (dir: string, id: string, name: string, at: string): Promise<void> => {
          const meta = await readFile(path.join(dir, ".backup.json"), "utf8")
            .then((text) => JSON.parse(text) as { at?: string; reason?: string; locationId?: string })
            .catch(() => null);
          const fingerprint = await fingerprintDir(dir);
          const size = await measureDir(dir);
          const canonHash = (await fingerprintDir(path.join(canonDir, name)))?.hash ?? null;
          const hash = fingerprint?.hash ?? null;
          const duplicate = hash !== null && (hash === canonHash || seenHashes.has(`${name}:${hash}`));
          if (hash !== null) seenHashes.add(`${name}:${hash}`);
          backups.push({
            id,
            name,
            at: meta?.at ?? at,
            reason: meta?.reason ?? "снято перед заменой",
            locationId: meta?.locationId ?? "—",
            hash,
            files: size.files,
            bytes: size.bytes,
            unique: !duplicate,
          });
        };
        for (const entry of (await readdir(root).catch(() => [] as string[])).sort().reverse()) {
          if (entry.startsWith(".")) continue;
          const full = path.join(root, entry);
          const info = await stat(full).catch(() => null);
          if (info === null || !info.isDirectory()) continue;
          if (await exists(path.join(full, "SKILL.md"))) {
            // Старый плоский снимок: «<имя>.<время>».
            const cut = entry.indexOf(".");
            const name = cut === -1 ? entry : entry.slice(0, cut);
            const at = cut === -1 ? "" : entry.slice(cut + 1);
            await collect(full, entry, name, at);
            continue;
          }
          for (const child of (await readdir(full).catch(() => [] as string[])).sort().reverse()) {
            const nested = path.join(full, child);
            if (!await exists(path.join(nested, "SKILL.md"))) continue;
            await collect(nested, `${entry}/${child}`, entry, child);
          }
        }
        return { backups: backups.slice(0, 500) };
      },

      /** Вернуть снимок в канон. То, что лежит там сейчас, само уходит в архив. */
      skills_backup_restore: async ({ id }) => {
        if (id.includes("..") || path.isAbsolute(id)) {
          return { ok: false, error: "недопустимый снимок", message: null };
        }
        const source = path.join(expand(SKILL_BACKUP_ROOT), id);
        if (!await exists(path.join(source, "SKILL.md"))) {
          return { ok: false, error: "снимок не найден", message: null };
        }
        const name = id.includes("/") ? id.slice(0, id.indexOf("/")) : id.slice(0, id.indexOf(".") === -1 ? undefined : id.indexOf("."));
        const canon = path.join(expand(".agents/skills"), name);
        const previous = await backupSkillDir(canon, name, "agents", "заменено восстановлением из архива");
        await rm(canon, { recursive: true, force: true });
        await cp(source, canon, { recursive: true, dereference: true });
        await rm(path.join(canon, ".backup.json"), { force: true });
        return {
          ok: true,
          error: null,
          message: previous === null ? `${name}: восстановлен` : `${name}: восстановлен, прежняя версия в архиве`,
        };
      },

      skills_sync: async ({ remote }) => {
        const dir = expand(".agents/skills");
        const messages: string[] = [];
        if (!await exists(path.join(dir, ".git"))) {
          // Первый синк на этой машине: канон ещё не репозиторий. Клонируем во
          // временную папку и сводим с тем, что уже лежит локально, — ничего
          // не затирая: чужое доливаем, своё оставляем, расхождения называем.
          await mkdir(dir, { recursive: true });
          const snapshot = expand(`.agents/skills-migrate-${stamp()}`);
          await cp(dir, snapshot, { recursive: true, dereference: true });
          const temp = expand(`.agents/skills-clone-${stamp()}`);
          await rm(temp, { recursive: true, force: true });
          await runGit("git", ["clone", remote, temp]);
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
            const mine = await fingerprintDir(local);
            const theirs = await fingerprintDir(incoming);
            if (mine !== null && theirs !== null && mine.hash !== theirs.hash) diverged.push(name);
          }
          await rename(path.join(temp, ".git"), path.join(dir, ".git"));
          await rm(temp, { recursive: true, force: true });
          messages.push(
            `миграция: снимок в ${snapshot}, добавлено из репозитория ${added}` +
              (diverged.length === 0 ? "" : `, расходятся (оставлено своё): ${diverged.join(", ")}`),
          );
        } else {
          const origin = await runGit("git", ["-C", dir, "remote", "get-url", "origin"])
            .then((r) => r.stdout.trim())
            .catch(() => "");
          if (origin !== remote) {
            if (origin === "") await runGit("git", ["-C", dir, "remote", "add", "origin", remote]);
            else await runGit("git", ["-C", dir, "remote", "set-url", "origin", remote]);
          }
          await runGit("git", ["-C", dir, "pull", "--rebase", "--autostash"]);
        }
        const ignorePath = path.join(dir, ".gitignore");
        const ignore = await readFile(ignorePath, "utf8").catch(() => "");
        const lines = new Set(ignore.split("\n").map((line) => line.trim()));
        let ignoreDirty = false;
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          if (name.startsWith(".")) continue;
          const isLink = await lstat(path.join(dir, name)).then((i) => i.isSymbolicLink()).catch(() => false);
          if (!isLink) continue;
          const line = `/${name}`;
          if (!lines.has(line)) {
            lines.add(line);
            ignoreDirty = true;
          }
        }
        if (ignoreDirty) await writeFile(ignorePath, `${[...lines].join("\n")}\n`);
        await runGit("git", ["-C", dir, "add", "-A"]);
        const status = await runGit("git", ["-C", dir, "status", "--porcelain"]);
        let committed = false;
        if (status.stdout.trim() !== "") {
          await runGit("git", ["-C", dir, "commit", "-m", `skills sync ${os.hostname()}`]);
          committed = true;
        }
        const push = await runGit("git", ["-C", dir, "push"]).then(
          () => "pushed",
          (cause) => (String(cause.stderr ?? cause.message).includes("up-to-date") ? "up-to-date" : Promise.reject(cause)),
        );
        const tail = `${committed ? "commit + " : ""}${push}`;
        return { ok: true, error: null, message: [...messages, tail].join("; ") };
      },

      apply: async ({ ops, dryRun }, ctx) => {
        const results: {
          kind: string;
          action: "upsert" | "remove";
          name: string;
          ok: boolean;
          error: string | null;
        }[] = [];
        const backups: string[] = [];
        const byKind = new Map<string, typeof ops>();
        for (const op of ops) {
          const list = byKind.get(op.kind) ?? [];
          list.push(op);
          byKind.set(op.kind, list);
        }

        for (const [kind, kindOps] of byKind) {
          ctx.signal.throwIfAborted();
          const agent = AGENTS.find((candidate) => candidate.kind === kind);
          if (agent === undefined) {
            for (const op of kindOps) {
              results.push({ kind, action: op.action, name: op.server.name, ok: false, error: "неизвестный агент" });
            }
            continue;
          }
          const config = await pickConfig(agent.configs);
          if (!config.writable) {
            for (const op of kindOps) {
              results.push({
                kind,
                action: op.action,
                name: op.server.name,
                ok: false,
                error: config.warning ?? "файл недоступен для записи",
              });
            }
            continue;
          }

          let text = config.text;
          const applied: typeof kindOps = [];
          try {
            for (const op of kindOps) {
              if (config.file.format === "toml") {
                const current = readServers(text ?? "", config.file.pointer)[op.server.name];
                const values = mergeEntry(current, toDialect(config.file.style, op.server));
                text =
                  op.action === "remove"
                    ? removeServer(text ?? "", op.server.name, config.file.pointer)
                    : upsertServer(text ?? "", op.server.name, values, config.file.pointer);
              } else {
                text = applyToJson(text, config.file, op.action, op.server);
              }
              applied.push(op);
            }
            if (!dryRun && text !== null && text !== config.text) {
              const saved = await backup(config.absolute);
              if (saved !== null) backups.push(saved);
              await writeAtomic(config.absolute, text);
            }
            for (const op of applied) {
              results.push({ kind, action: op.action, name: op.server.name, ok: true, error: null });
            }
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            for (const op of kindOps) {
              results.push({ kind, action: op.action, name: op.server.name, ok: false, error: message });
            }
          }
        }
        return { results, backups };
      },

      opencode_scan: async () => scanOpenCode(),

      opencode_apply: async ({ ops, dryRun }) => applyOpenCode(ops, dryRun),

      plugins_scan: async () => scanHostCliPlugins(),
    },
});