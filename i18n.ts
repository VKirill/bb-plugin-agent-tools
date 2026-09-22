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
