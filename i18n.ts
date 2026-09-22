// Два языка интерфейса. Ключ словаря — сам русский текст: так строка на месте
// читается без словаря, а пропущенный перевод не ломает экран, а показывает
// русский оригинал. Сам словарь подключает потребитель (`setDictionary`), чтобы
// этот модуль оставался без зависимостей и проверялся тестами напрямую.

export type Lang = "ru" | "en";

export const LANGS: Lang[] = ["ru", "en"];

export function isLang(value: unknown): value is Lang {
  return value === "ru" || value === "en";
}

let current: Lang = "ru";
let dictionary: Record<string, string> = {};

/** Подключить словарь переводов. Вызывается один раз при загрузке. */
export function setDictionary(next: Record<string, string>): void {
  dictionary = next;
}

export function setLang(next: Lang): void {
  current = next;
}

export function getLang(): Lang {
  return current;
}

/** Перевод по русскому оригиналу. Нет перевода — возвращаем оригинал. */
export function t(ru: string): string {
  if (current === "ru") return ru;
  return dictionary[ru] ?? ru;
}

/**
 * Перевод для языка, заданного явно: сервер отвечает CLI и на языке настройки,
 * не трогая язык текущего процесса.
 */
export function tl(lang: Lang, ru: string): string {
  if (lang === "ru") return ru;
  return dictionary[ru] ?? ru;
}

/** Строки, у которых в переводе меняется порядок слов: `{0}`, `{1}` по позиции. */
export function tp(ru: string, ...values: (string | number)[]): string {
  return t(ru).replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/**
 * «1 сервер / 2 сервера / 5 серверов» по-русски и «1 server / 2 servers»
 * по-английски: формы задаются русскими, перевод берётся из словаря.
 */
export function plural(count: number, forms: [string, string, string]): string {
  if (current === "en") {
    return `${count} ${count === 1 ? t(forms[0]) : t(forms[2])}`;
  }
  const tens = count % 100;
  const ones = count % 10;
  if (tens > 10 && tens < 20) return `${count} ${forms[2]}`;
  if (ones === 1) return `${count} ${forms[0]}`;
  if (ones >= 2 && ones <= 4) return `${count} ${forms[1]}`;
  return `${count} ${forms[2]}`;
}

/** Числа и флаги одного шага «синк канона → раскатка домов» — для CLI и экрана. */
export type RolloutDescription = {
  dryRun: boolean;
  remoteConfigured: boolean;
  canonEmpty: boolean;
  /** Сколько скиллов канона нет хотя бы на одной машине. */
  notOnAllMachines: number;
  synced: number;
  syncFailed: number;
  applied: number;
  failed: number;
  skippedByPlugin: string[];
  errors: string[];
};

/**
 * Текст результата раскатки: один и тот же в CLI и в notice/alert экрана.
 * Живёт рядом с t/tp/plural: node-тесты импортируют i18n.ts, а skills.ts
 * остаётся без runtime-импортов — иначе падают fanout/skills тесты.
 */
export function describeRollout(input: RolloutDescription): string {
  const ops = input.applied + input.failed;
  const lines: string[] = [];
  const intraMachineRemoteHint = t(
    "кнопка раскладывает канон только внутри машины, для переноса задайте git-remote синка в настройках",
  );

  if (input.dryRun && input.remoteConfigured) {
    lines.push(
      tp("Синк канона не выполнялся. План раскладки: {0}, ошибок {1}", input.applied, input.failed),
    );
  } else if (ops === 0 && input.canonEmpty && input.syncFailed === 0 && input.errors.length === 0) {
    lines.push(t("Канон пуст"));
  } else if (input.remoteConfigured) {
    lines.push(
      tp(
        "Канон синхронизирован: машин {0}, ошибок {1}. Разложено: {2}, ошибок {3}",
        input.synced,
        input.syncFailed,
        input.applied,
        input.failed,
      ),
    );
  } else if (ops === 0 && input.notOnAllMachines > 0) {
    lines.push(
      tp(
        "{0} есть не на всех машинах; кнопка раскладывает канон только внутри машины, для переноса задайте git-remote синка в настройках",
        plural(input.notOnAllMachines, ["скилл", "скилла", "скиллов"]),
      ),
    );
  } else if (ops === 0) {
    lines.push(t("Дома уже совпадают с каноном."));
  } else {
    lines.push(`${tp("Разложено: {0}, ошибок: {1}", input.applied, input.failed)}. ${intraMachineRemoteHint}`);
  }

  if (input.skippedByPlugin.length > 0) {
    lines.push(tp("Отдаёт плагин, не дублируем: {0}", input.skippedByPlugin.join(", ")));
  }
  if (input.errors.length > 0) lines.push(input.errors.join("\n"));
  const body = lines.join("\n");
  return input.dryRun ? t("Пробный запуск. ") + body : body;
}

/** Сколько имён канона отсутствуют хотя бы на одной машине сводки. */
export function countSkillsNotOnAllMachines(
  skillCanon: { hosts: { state: string }[] }[],
): number {
  return skillCanon.filter((row) => row.hosts.some((item) => item.state === "missing")).length;
}

/** Лимит текста ошибки host RPC skills_sync — server+host контракт. */
export const SKILLS_SYNC_ERROR_LIMIT = 2000;

/** Таймаут host.call для синка и раскатки канона. */
export const SKILLS_HOST_CALL_TIMEOUT_MS = 25_000;

export type SkillHostRef = {
  id: string;
  name: string;
  status: string;
};

/** Разделить цели раскладки: только connected; остальные — в errors. */
export function partitionSkillHosts<T extends SkillHostRef>(
  hosts: readonly T[],
  hostId: string | null,
): { targets: T[]; disconnected: T[] } {
  const scoped = hosts.filter((item) => hostId === null || item.id === hostId);
  return {
    targets: scoped.filter((item) => item.status === "connected"),
    disconnected: scoped.filter((item) => item.status !== "connected"),
  };
}

/** Текст таймаута без имени машины — имя добавит summarizeCanonSync / fan-out. */
export function formatHostCallTimeout(timeoutMs = SKILLS_HOST_CALL_TIMEOUT_MS): string {
  return tp("машина не ответила за {0} с", Math.max(1, Math.ceil(timeoutMs / 1000)));
}

export function isHostCallTimeout(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /timed out waiting for command result/i.test(text);
}

/** Привести отказ host.call к причине без имени машины. */
export function hostCallFailureReason(
  cause: unknown,
  timeoutMs = SKILLS_HOST_CALL_TIMEOUT_MS,
): string {
  if (isHostCallTimeout(cause)) return formatHostCallTimeout(timeoutMs);
  return cause instanceof Error ? cause.message : String(cause);
}

export function disconnectedHostError(hostName?: string): string {
  const reason = t("машина не на связи");
  return hostName ? `${hostName}: ${reason}` : reason;
}

/**
 * host.call с собственным deadline. Параметр timeoutMs у SDK остаётся первым
 * рубежом, но Promise.race гарантирует ответ даже если транспорт его игнорирует.
 */
export async function callHostTimed<T>(
  call: (timeoutMs: number) => Promise<T>,
  timeoutMs = SKILLS_HOST_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(formatHostCallTimeout(timeoutMs))), timeoutMs);
    });
    return await Promise.race([call(timeoutMs), deadline]);
  } catch (cause) {
    throw new Error(hostCallFailureReason(cause, timeoutMs));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Обрезать stderr git до лимита контракта, не оставляя оборванного хвоста в середине. */
export function clipErrorText(text: string, limit = SKILLS_SYNC_ERROR_LIMIT): string {
  const trimmed = text.replace(/\s+$/u, "").trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

export type SyncHostResult = {
  hostId: string;
  hostName: string;
  ok: boolean;
  error: string | null;
};

/** Собрать ошибки синка по машинам: имя + текст, счётчики, кого не раскатывать. */
export function summarizeCanonSync(results: readonly SyncHostResult[]): {
  synced: number;
  failed: number;
  errors: string[];
  failedHostIds: string[];
  okHostIds: string[];
} {
  let synced = 0;
  let failed = 0;
  const errors: string[] = [];
  const failedHostIds: string[] = [];
  const okHostIds: string[] = [];
  for (const item of results) {
    if (item.ok) {
      synced += 1;
      okHostIds.push(item.hostId);
      continue;
    }
    failed += 1;
    failedHostIds.push(item.hostId);
    const reason = item.error?.trim() ? item.error.trim() : t("ошибка");
    errors.push(`${item.hostName}: ${reason}`);
  }
  return { synced, failed, errors, failedHostIds, okHostIds };
}

/**
 * Раскатка только на машинах, где синк прошёл.
 * Политика: провал синка → на этой машине дома не трогать, иначе разложится устаревший канон.
 */
export function selectFanOutHostIds(
  targetIds: readonly string[],
  failedSyncIds: readonly string[],
): string[] {
  const failed = new Set(failedSyncIds);
  return targetIds.filter((id) => !failed.has(id));
}

/** Каталоги, где host-процесс ищет git, если PATH launchd пуст. */
export function gitBinSearchDirs(envPath: string, homeDir: string, delimiter = ":"): string[] {
  const fromPath = envPath.split(delimiter).filter(Boolean);
  const extra = [
    `${homeDir}/.local/bin`,
    `${homeDir}/.bun/bin`,
    `${homeDir}/.npm-global/bin`,
    `${homeDir}/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/snap/bin",
    "/Library/Developer/CommandLineTools/usr/bin",
    "/Applications/Xcode.app/Contents/Developer/usr/bin",
  ];
  return [...new Set([...fromPath, ...extra])];
}

/** Схема remote без URL и без секретов — чтобы ошибка сказала, чего не хватает. */
export function remoteAccessHint(remote: string): string {
  if (/^git@/i.test(remote) || /^ssh:\/\//i.test(remote)) {
    return "remote: ssh (нужен ключ или ssh-agent в окружении host-процесса)";
  }
  if (/^https:\/\//i.test(remote)) {
    return "remote: https (нужен credential helper или токен в неинтерактивном окружении)";
  }
  if (/^http:\/\//i.test(remote)) {
    return "remote: http (нужен credential helper в неинтерактивном окружении)";
  }
  if (/^file:\/\//i.test(remote) || remote.startsWith("/")) return "remote: file";
  return "remote: неизвестная схема";
}

/** Имена из «untracked working tree files would be overwritten by merge». */
export function parseUntrackedOverwriteNames(stderr: string): string[] {
  const names: string[] = [];
  let inList = false;
  for (const raw of stderr.split("\n")) {
    if (raw.includes("untracked working tree files would be overwritten")) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("Please ") || line.startsWith("Aborting") || line.startsWith("error:")) break;
    names.push(line);
  }
  return names;
}

export function isRebaseConflict(stderr: string): boolean {
  return /could not apply|CONFLICT \(|rebase in progress|Resolve all conflicts|failed to merge/i.test(stderr);
}

/** Текст отказа git для host RPC: stderr, схема remote, путь git. Без секретов. */
export function formatSkillsSyncError(
  cause: unknown,
  remote: string,
  gitBin: string | null,
): string {
  const exec = cause as { stderr?: unknown; message?: unknown };
  const stderr = typeof exec.stderr === "string" ? exec.stderr : "";
  const message = cause instanceof Error ? cause.message : String(cause);
  const body = (stderr.trim() !== "" ? stderr : message).trim();
  const bits: string[] = [];
  if (gitBin === null) {
    bits.push("git не найден (искали /usr/bin/git, /opt/homebrew/bin/git, xcode-select)");
  } else {
    bits.push(`git: ${gitBin}`);
  }
  bits.push(remoteAccessHint(remote));
  const untracked = parseUntrackedOverwriteNames(body);
  if (untracked.length > 0) {
    bits.push(`незакоммиченные файлы оставлены: ${untracked.join(", ")}`);
  }
  if (isRebaseConflict(body)) {
    bits.push("конфликт rebase: репозиторий возвращён к состоянию до pull (git rebase --abort)");
  }
  bits.push(body);
  return clipErrorText(bits.join("\n"));
}
