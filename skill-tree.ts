// Дерево папки скилла на диске: что считается мусором, как копировать без него
// и как его видит host-daemon BB. BB переносит скилл в сессию целиком (ничего
// не пропуская) и отказывает всему скиллу, если дерево больше лимитов, — так
// `node_modules` внутри одного скилла ломает старт любого чата.
import { cp, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Мусор, который не считается содержимым скилла: зависимости, следы сборки и
 * редактора. Не копируется ни в один дом, не пакуется в архив для сервера BB.
 */
export function isSkillJunk(name: string): boolean {
  if (SKILL_JUNK_DIRS.includes(name)) return true;
  if (name === ".DS_Store" || name === ".backup.json") return true;
  return name.endsWith(".pyc") || name.endsWith(".bak") || name.endsWith(".tmp");
}

export const SKILL_JUNK_DIRS = ["node_modules", ".git", "__pycache__", ".venv", "venv", ".next", ".turbo", ".cache"];

/** Шаблоны для `tar --exclude` — тот же список, что и isSkillJunk. */
export const SKILL_TAR_EXCLUDES = [...SKILL_JUNK_DIRS, ".DS_Store", ".backup.json", "*.pyc", "*.bak", "*.tmp"];

/** Копия скилла без мусора; симлинки разворачиваются в файлы (BB их не принимает). */
export async function copySkillTree(source: string, dest: string): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    dereference: true,
    filter: (item) => item === source || !isSkillJunk(path.basename(item)),
  });
}

export interface BbTreeMeasure {
  /** Байты всех файлов, как их считает BB (мусор тоже). */
  bytes: number;
  files: number;
  depth: number;
  /** Симлинки внутри дерева, относительные пути (первые несколько). */
  symlinks: string[];
  /** Папки-мусор внутри дерева (node_modules и т.п.), относительные пути. */
  junk: string[];
}

/** Замер дерева скилла по правилам host-daemon BB; обход обрывается далеко за лимитами. */
export async function measureBbTree(dir: string): Promise<BbTreeMeasure> {
  const result: BbTreeMeasure = { bytes: 0, files: 0, depth: 0, symlinks: [], junk: [] };
  const stopAt = { files: 20_000, bytes: 1024 * 1024 * 1024 };
  const walk = async (current: string, rel: string, depth: number): Promise<void> => {
    if (result.files > stopAt.files || result.bytes > stopAt.bytes) return;
    result.depth = Math.max(result.depth, depth);
    for (const item of await readdir(current).catch(() => [] as string[])) {
      const full = path.join(current, item);
      const relPath = rel === "" ? item : `${rel}/${item}`;
      const info = await lstat(full).catch(() => null);
      if (info === null) continue;
      if (info.isSymbolicLink()) {
        if (result.symlinks.length < 5) result.symlinks.push(relPath);
        continue;
      }
      if (info.isDirectory()) {
        if (SKILL_JUNK_DIRS.includes(item) && result.junk.length < 5) result.junk.push(relPath);
        await walk(full, relPath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      result.files += 1;
      result.bytes += info.size;
    }
  };
  await walk(dir, "", 0);
  return result;
}
