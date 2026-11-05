import { test } from "node:test";
import assert from "node:assert/strict";
import { isUiLangChoice, resolveUiLang, type UiLangEnv } from "../i18n.ts";

const env = (over: Partial<UiLangEnv> = {}): UiLangEnv => ({
  htmlLang: "",
  pkLang: null,
  russifierOff: false,
  chromeLabels: [],
  ...over,
});

test("явный выбор важнее окружения страницы", () => {
  assert.equal(resolveUiLang("ru", env({ htmlLang: "en" })), "ru");
  assert.equal(resolveUiLang("en", env({ htmlLang: "ru-RU" })), "en");
});

test("auto читает lang документа", () => {
  assert.equal(resolveUiLang("auto", env({ htmlLang: "ru-RU" })), "ru");
  assert.equal(resolveUiLang("auto", env({ htmlLang: "en" })), "en");
});

test("auto читает data-pk-lang, когда lang пуст или английский", () => {
  assert.equal(resolveUiLang("auto", env({ htmlLang: "en", pkLang: "ru" })), "ru");
  assert.equal(resolveUiLang("auto", env({ pkLang: "en" })), "en");
});

test("auto ловит кириллицу в подписях хрома при включённом Русификаторе", () => {
  const envRu = env({ htmlLang: "en", chromeLabels: ["New thread", "Настройки", "Search"] });
  assert.equal(resolveUiLang("auto", envRu), "ru");
});

test("выключенный Русификатор не считается", () => {
  const envOff = env({
    htmlLang: "en",
    russifierOff: true,
    chromeLabels: ["Настройки", "Ещё"],
  });
  assert.equal(resolveUiLang("auto", envOff), "en");
});

test("кириллица только после двенадцати первых подписей не считается", () => {
  const labels = Array.from({ length: 12 }, () => "button");
  labels.push("Настройки");
  assert.equal(resolveUiLang("auto", env({ chromeLabels: labels })), "en");
});

test("пустое окружение даёт английский", () => {
  assert.equal(resolveUiLang("auto", env()), "en");
});

test("isUiLangChoice принимает только auto/ru/en", () => {
  assert.equal(isUiLangChoice("auto"), true);
  assert.equal(isUiLangChoice("ru"), true);
  assert.equal(isUiLangChoice("en"), true);
  assert.equal(isUiLangChoice("RU"), false);
  assert.equal(isUiLangChoice(""), false);
  assert.equal(isUiLangChoice(null), false);
  assert.equal(isUiLangChoice(undefined), false);
  assert.equal(isUiLangChoice(1), false);
});
