// Состояния скиллов по результатам скана папок одной машины. Чистые функции —
// ничего не читает с диска, покрывается тестами.
import type { SkillState } from "./contract.js";

export interface SkillLocationScan {
  id: string;
  path: string;
  exists: boolean;
  /** Дом CLI на машине есть, а папки скиллов пока нет — раскатка её создаст. */
  parentExists?: boolean;
  entries: {
    name: string;
    kind: "dir" | "symlink";
    target: string | null;
    hash: string | null;
    mtime: number | null;
    hasSkillMd: boolean;
  }[];
}

export interface SkillRow {
  name: string;
  locationId: string;
  state: SkillState;
  hash: string | null;
  mtime: number | null;
  canonicalMtime: number | null;
}

export type SkillActionMode = "adopt" | "link" | "take" | "delete" | "unlink";

export interface SkillAction {
  mode: SkillActionMode;
  label: string;
  /** Ручное действие: в «Применить все правила» не попадает — решение за человеком. */
  manual?: true;
}

/**
 * Что делать со скиллами в каждой папке. Живых домов два — канон
 * `~/.agents/skills` и `~/.claude/skills` (Claude Code читает только свой дом,
 * поэтому там симлинки).
 * - `canon` — сам канон;
 * - `link` — CLI читает только свою папку: копия заменяется симлинком в канон;
 * - `native` — CLI сам читает канон: копия просто удаляется, симлинк не нужен;
 * - `own` — свой дом со своим реестром: реальные папки не трогаем вовсе;
 * - `drop` — папку не используем вовсе: убираем и копии, и ссылки.
 */
export type LocationPolicy = "canon" | "link" | "native" | "own" | "drop";

export const LOCATION_POLICY: Record<string, LocationPolicy> = {
  agents: "canon",
  claude: "link",
  // BB держит свой реестр скиллов и заносит в него только реальные папки
  // ~/.bb/skills — симлинк оттуда просто исчезает из списка bb-user, и скилл
  // пропадает из сессий BB. Поэтому эту папку правила не трогают.
  bb: "own",
  qwen: "link",
  codex: "native",
  cursor: "native",
  opencode: "native",
  // Antigravity/Gemini: скиллы здесь не держим, канон и .claude закрывают всё.
  "gemini-config": "drop",
};

export function locationPolicy(locationId: string): LocationPolicy {
  return LOCATION_POLICY[locationId] ?? "link";
}

/** Путь папки в домашнем каталоге — для интерфейса и CLI-вывода. */
export const LOCATION_PATH: Record<string, string> = {
  agents: "~/.agents/skills",
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
  "gemini-config": "~/.gemini/config/skills",
  bb: "~/.bb/skills",
  opencode: "~/.config/opencode/skills",
  cursor: "~/.cursor/skills",
  qwen: "~/.qwen/skills",
};

export function locationPath(locationId: string): string {
  return LOCATION_PATH[locationId] ?? locationId;
}

/** Детерминированное действие по строке: null — правила нет (расходятся с равной датой). */
export function resolveRowAction(row: SkillRow): SkillAction | null {
  const policy = locationPolicy(row.locationId);
  // Дом со своим реестром разбирает сам его хозяин: автоматических правил нет.
  if (policy === "own" && row.state !== "stray-link") return null;
  const leavesLink = policy === "link";
  if (row.state === "stray-link") return { mode: "unlink", label: "Убрать ссылку" };
  // Дубль реестра BB: убирать или нет — зависит от того, запускает ли человек
  // этот CLI вне BB, поэтому правило не автоматическое.
  if (row.state === "bb-registry") return { mode: "unlink", label: "Убрать ссылку", manual: true };
  if (row.state === "only-here") {
    return { mode: "adopt", label: leavesLink ? "За канон" : "Перенести в канон" };
  }
  if (row.state === "copy") {
    return leavesLink
      ? { mode: "link", label: "Симлинк" }
      : { mode: "delete", label: "Удалить" };
  }
  if (row.state === "diverged") {
    if (row.mtime !== null && row.canonicalMtime !== null && row.mtime > row.canonicalMtime) {
      return { mode: "take", label: "В канон (копия новее)" };
    }
    if (row.mtime !== null && row.canonicalMtime !== null && row.canonicalMtime > row.mtime) {
      return {
        mode: "link",
        label: leavesLink ? "Заменить копию (канон новее)" : "Удалить копию (канон новее)",
      };
    }
    return null;
  }
  return null;
}

/**
 * Канон — папка "agents". Каждый скилл в остальных папках получает состояние:
 * симлинк в канон — "linked", симлинк наружу — "linked-external", реальная
 * копия — "copy" или "diverged" (по хешу папки скилла), без канона — "only-here".
 * В папке с политикой "drop" любая ссылка — "stray-link": её надо убрать.
 * Особый случай: канон сам ссылается на реальную папку (симлинк в ~/.bb/skills
 * и т.п.) — тогда эта реальная папка помечается "canonical-source": переносить
 * её нельзя, получится петля симлинков.
 */
export function computeSkillRows(
  canonicalPath: string,
  locations: SkillLocationScan[],
): SkillRow[] {
  const canonical = locations.find((item) => item.id === "agents");
  // имя → хеш скилла в каноне (учитываем и симлинки канона) и путь-цель канон-симлинка.
  const canonicalHashes = new Map<string, string | null>();
  const canonicalMtimes = new Map<string, number | null>();
  const canonicalTargets = new Set<string>();
  for (const entry of canonical?.entries ?? []) {
    if (!entry.hasSkillMd) continue;
    canonicalHashes.set(entry.name, entry.hash);
    canonicalMtimes.set(entry.name, entry.mtime);
    if (entry.kind === "symlink" && entry.target !== null) canonicalTargets.add(entry.target);
  }
  const rows: SkillRow[] = [];
  const prefix = canonicalPath.endsWith("/") ? canonicalPath : `${canonicalPath}/`;
  // Дом скиллов BB: ссылки сюда — это те же скиллы, которые BB и так подставляет
  // в свои сессии, поэтому в списке провайдера они выглядят вторым экземпляром.
  const bbHome = locations.find((item) => item.id === "bb")?.path ?? null;
  const bbPrefix = bbHome === null ? null : bbHome.endsWith("/") ? bbHome : `${bbHome}/`;
  for (const location of locations) {
    if (location.id === "agents" || !location.exists) continue;
    const policy = locationPolicy(location.id);
    for (const entry of location.entries) {
      let state: SkillState;
      if (entry.kind === "symlink") {
        state =
          policy === "drop"
            ? "stray-link"
            : entry.target !== null && entry.target.startsWith(prefix)
              ? "linked"
              : bbPrefix !== null && entry.target !== null && entry.target.startsWith(bbPrefix)
                ? "bb-registry"
                : "linked-external";
      } else if (!entry.hasSkillMd) {
        continue; // мусор без SKILL.md не скилл
      } else if (canonicalTargets.has(`${location.path}/${entry.name}`)) {
        state = "canonical-source";
      } else if (!canonicalHashes.has(entry.name)) {
        state = "only-here";
      } else {
        state = canonicalHashes.get(entry.name) === entry.hash ? "copy" : "diverged";
      }
      rows.push({
        name: entry.name,
        locationId: location.id,
        state,
        hash: entry.hash,
        mtime: entry.mtime,
        canonicalMtime: canonicalMtimes.get(entry.name) ?? null,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.locationId.localeCompare(b.locationId));
}

// ---------------------------------------------------------------------------
// Раскатка канона по домам CLI: канон — источник правды, дома получают его
// копии и ссылки.

/**
 * Что раскатка уже разложила по домам в прошлый раз. Нужна, чтобы отличить
 * новый скилл в доме («его ещё не раскатывали») от удалённого человеком
 * («раскатывали, а теперь его нет»).
 */
export interface FanOutState {
  entries: Record<string, { hash: string | null; mirrored?: boolean }>;
}

export type FanOutOpKind =
  /** Поставить в доме симлинк на канон (Claude Code читает только свою папку). */
  | "link"
  /** Положить в доме реальную копию канона (BB заносит в реестр только папки). */
  | "mirror"
  /** Убрать из дома то, чего в каноне больше нет. */
  | "drop"
  /** Забрать в канон скилл, которого там ещё нет. */
  | "pull"
  /** Человек удалил скилл в доме — убрать его из канона, и удаление разъедется. */
  | "retire";

export interface FanOutOp {
  kind: FanOutOpKind;
  locationId: string;
  name: string;
  /** Человеческая причина — идёт в журнал бэкапов и в отчёт. */
  reason: string;
}

export interface FanOutPlan {
  ops: FanOutOp[];
  /** Имена канона после применения плана — это и есть следующее состояние. */
  nextState: FanOutState;
  /** Имена, которые уже отдаёт плагин-маркетплейс: их не дублируем. */
  skippedByPlugin: string[];
}

export interface FanOutInput {
  canonicalPath: string;
  locations: SkillLocationScan[];
  /** Имена скиллов, которые CLI и так получает из плагинов-маркетплейсов. */
  pluginNames: string[];
  state: FanOutState;
}

interface Entry {
  name: string;
  kind: "dir" | "symlink";
  target: string | null;
  hash: string | null;
  mtime: number | null;
  hasSkillMd: boolean;
}

function skillEntries(location: SkillLocationScan | undefined): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const entry of location?.entries ?? []) {
    if (!entry.hasSkillMd) continue;
    map.set(entry.name, entry);
  }
  return map;
}

function withSlash(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

/**
 * План приведения домов к канону. Правила владельца: при расхождении побеждает
 * более свежая правка, удаление разъезжается по всем машинам, а имена, которые
 * отдаёт плагин-маркетплейс, в дома не дублируются.
 */
export function planFanOut(input: FanOutInput): FanOutPlan {
  const { canonicalPath, locations, state } = input;
  const plugins = new Set(input.pluginNames);
  const canonical = skillEntries(locations.find((item) => item.id === "agents"));
  const ops: FanOutOp[] = [];
  const skippedByPlugin: string[] = [];
  const retired = new Set<string>();
  const pulled = new Set<string>();

  // Дом BB — единственный, где человек заводит и удаляет скиллы руками через
  // интерфейс, поэтому только он может забрать скилл в канон и увести в архив.
  const bb = locations.find((item) => item.id === "bb");
  const bbEntries = skillEntries(bb);
  const bbPrefix = bb === undefined ? null : withSlash(bb.path);

  for (const [name, canon] of canonical) {
    // Канон уже ссылается в дом BB: там и лежит настоящая папка, зеркалить нечего.
    const sourceInBb =
      canon.kind === "symlink" && bbPrefix !== null && canon.target?.startsWith(bbPrefix) === true;
    const mirror = bbEntries.get(name);
    // Плагин-маркетплейс уже отдаёт этот скилл в сессии BB — зеркало было бы
    // вторым экземпляром того же в списке навыков.
    const fromPlugin = plugins.has(name);
    if (fromPlugin && !skippedByPlugin.includes(name)) skippedByPlugin.push(name);
    if (bb !== undefined && bb.exists && !sourceInBb && !fromPlugin) {
      if (mirror === undefined) {
        // «Удалён человеком» — только если этот скилл мы туда раскладывали.
        // Скилл, который раньше пропускали (его отдавал плагин), просто не
        // зеркалили: его отсутствие ничего не значит и канон трогать нельзя.
        if (state.entries[name]?.mirrored === true) {
          ops.push({ kind: "retire", locationId: "bb", name, reason: "удалён в BB" });
          retired.add(name);
        } else {
          ops.push({ kind: "mirror", locationId: "bb", name, reason: "нет в доме BB" });
        }
      } else if (mirror.hash !== canon.hash) {
        const canonNewer = (canon.mtime ?? 0) >= (mirror.mtime ?? 0);
        if (canonNewer) {
          ops.push({ kind: "mirror", locationId: "bb", name, reason: "канон новее" });
        } else {
          ops.push({ kind: "pull", locationId: "bb", name, reason: "правка в BB новее" });
        }
      }
    }
    if (retired.has(name)) continue;

    for (const location of locations) {
      if (location.id === "agents" || location.id === "bb") continue;
      if (!location.exists && location.parentExists !== true) continue;
      if (locationPolicy(location.id) !== "link") continue;
      if (fromPlugin) continue;
      const here = skillEntries(location).get(name);
      if (here === undefined) {
        ops.push({ kind: "link", locationId: location.id, name, reason: "нет в доме" });
        continue;
      }
      // Реальная копия — это разбор правил вкладки «Скиллы», не дело раскатки.
      if (here.kind !== "symlink") continue;
      const target = here.target ?? "";
      if (!target.startsWith(withSlash(canonicalPath)) && target !== `${canonicalPath}/${name}`) {
        ops.push({ kind: "link", locationId: location.id, name, reason: "ссылка мимо канона" });
      }
    }
  }

  // Скиллы дома BB, которых в каноне нет: новый — забираем, знакомый — значит
  // канон его потерял (например, удаление приехало синком), убираем зеркало.
  for (const [name, entry] of bbEntries) {
    if (canonical.has(name)) continue;
    if (entry.kind === "symlink") continue;
    if (state.entries[name]?.mirrored === true) {
      ops.push({ kind: "drop", locationId: "bb", name, reason: "убран из канона" });
    } else {
      ops.push({ kind: "pull", locationId: "bb", name, reason: "новый скилл BB" });
      pulled.add(name);
    }
  }

  // Ссылки на скиллы, которых в каноне больше нет.
  for (const location of locations) {
    if (location.id === "agents" || !location.exists) continue;
    if (locationPolicy(location.id) !== "link") continue;
    for (const entry of location.entries) {
      if (entry.kind !== "symlink") continue;
      const target = entry.target;
      // Ссылка без цели — битая: канон, на который она смотрела, уже удалён.
      const pointsToCanon =
        target === null ||
        target.startsWith(withSlash(canonicalPath)) ||
        target === `${canonicalPath}/${entry.name}`;
      if (!pointsToCanon) continue;
      if (canonical.has(entry.name) && !retired.has(entry.name)) continue;
      ops.push({ kind: "drop", locationId: location.id, name: entry.name, reason: "нет в каноне" });
    }
  }

  const nextNames = new Set<string>([...canonical.keys(), ...pulled]);
  for (const name of retired) nextNames.delete(name);
  const entries: FanOutState["entries"] = {};
  for (const name of [...nextNames].sort()) {
    // Помним не только содержимое, но и факт «мы это зеркалили в дом BB»:
    // иначе смена правил выглядит как удаление скилла человеком.
    const mirrored =
      bb !== undefined &&
      bb.exists &&
      !plugins.has(name) &&
      canonical.get(name)?.kind !== "symlink";
    entries[name] = {
      hash: canonical.get(name)?.hash ?? bbEntries.get(name)?.hash ?? null,
      mirrored,
    };
  }

  return { ops, nextState: { entries }, skippedByPlugin };
}
