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
