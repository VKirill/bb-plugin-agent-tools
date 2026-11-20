import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { getLang, t, tp, applyUiLang, setUiLangChoice, type UiLangChoice } from "./i18n";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type HubOnlyLast = {
  at: number;
  imported: number;
  moved: number;
  rejected: number;
  skipped: Array<{ hostName: string; reason: string }>;
};

type Settings = {
  provider: string;
  model: string;
  auto: boolean;
  projectId: string;
  hubOnly: boolean;
  suggest: {
    engine: "jev" | "gemini";
    inject: boolean;
    tools: boolean;
    jevKeySet: boolean;
    jevKeyEnv: string;
    jevModel: string;
    geminiKeySet: boolean;
    geminiKeyEnv: string;
    geminiModel: string;
    envSecrets: Array<{ name: string; service: string }> | null;
  };
  uiLang: UiLangChoice;
  hubOnlyLast: HubOnlyLast | null;
  providers: Array<{ id: string; label: string; available: boolean }>;
  projects: Array<{ id: string; name: string }>;
};

type ModelOption = { id: string; label: string; description: string };

function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <div>
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const selectClass = "at-raised h-9 w-full max-w-md rounded-[8px] border border-input bg-background px-2.5 text-sm";

export function SettingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void rpc
      .call("skills_settings", null)
      .then(setSettings)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);

  const provider = settings?.provider ?? "";
  useEffect(() => {
    if (provider === "") return;
    setModels([]);
    setModelsError(null);
    void rpc
      .call("skills_provider_models", { providerId: provider })
      .then((result) => {
        setModels(result.models);
        setModelsError(result.error);
      })
      .catch((cause: unknown) => setModelsError(cause instanceof Error ? cause.message : String(cause)));
  }, [provider, rpc]);

  const save = useCallback(
    async (patch: Parameters<typeof rpc.call<"skills_settings_set">>[1]) => {
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        setSettings(await rpc.call("skills_settings_set", patch));
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  const saveUiLang = useCallback(
    async (choice: UiLangChoice) => {
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        const result = await rpc.call("ui_language_set", { choice });
        setUiLangChoice(result.choice);
        applyUiLang();
        setSettings((previous) => (previous === null ? previous : { ...previous, uiLang: result.choice }));
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  if (settings === null) {
    return <div className="at-card mt-4 p-6 text-sm text-muted-foreground">{error ?? t("Загрузка…")}</div>;
  }

  const engine = settings.suggest.engine;
  const keyEnv = engine === "gemini" ? settings.suggest.geminiKeyEnv : settings.suggest.jevKeyEnv;
  const keySet = (engine === "gemini" ? settings.suggest.geminiKeySet : settings.suggest.jevKeySet) || keyEnv !== "";
  const engineModel = engine === "gemini" ? settings.suggest.geminiModel : settings.suggest.jevModel;

  const modelKnown = models.some((item) => item.id === settings.model);
  const selectedModel = models.find((item) => item.id === settings.model);

  return (
    <div className="mt-3 max-w-4xl space-y-4">
      {error === null ? null : (
        <div role="alert" className="at-card flex items-start gap-2 px-3 py-2 text-sm at-text-danger">
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <section className="at-panel">
        <div className="at-panel-head">
          <h2 className="text-sm font-medium">{t("Язык интерфейса")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("На каком языке показывать страницы плагина.")}
          </p>
        </div>
        <div className="at-panel-body p-4">
          <Field label={t("Язык")} hint={t("«Как в BB» учитывает Русификатор и тему Pokecut.")}>
            <div role="group" aria-label={t("Язык интерфейса")} className="at-seg">
              {(
                [
                  ["auto", t("Как в BB")],
                  ["ru", "Русский"],
                  ["en", "English"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={settings.uiLang === value}
                  disabled={busy}
                  className="at-seg-item h-7 rounded-[6px] px-3 text-xs"
                  onClick={() => void saveUiLang(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </section>

      <section className="at-panel">
        <div className="at-panel-head">
          <h2 className="text-sm font-medium">{t("Подбор навыков")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Перед каждым сообщением пользователя модель выбирает один подходящий навык хаба и подсказывает его агенту. Работает с любым провайдером BB.")}
          </p>
        </div>
        <div className="at-panel-body space-y-5 p-4">
          <Field label={t("Подбирать навык в каждом ходе")} hint={t("Ход начинается на 1–3 секунды позже. Подсказку видит только агент, в чате её нет.")}>
            <Switch
              className="at-switch"
              checked={settings.suggest.inject}
              disabled={busy}
              aria-label={t("Подбирать навык в каждом ходе")}
              onCheckedChange={(suggestInject) => void save({ suggestInject })}
            />
            {settings.suggest.inject && !keySet ? (
              <p className="mt-1 text-xs at-text-warning">{t("Ключ выбранной модели не задан — подбор не работает.")}</p>
            ) : null}
          </Field>

          <Field label={t("Модель-подборщик")} hint={t("Jev — быстрый и дешёвый, пороги измерены на нём. Gemini — альтернатива от Google.")}>
            <div role="group" aria-label={t("Модель-подборщик")} className="at-seg">
              {(
                [
                  ["jev", "TypeSafe Jev"],
                  ["gemini", "Google Gemini"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={engine === value}
                  disabled={busy}
                  className="at-seg-item h-7 rounded-[6px] px-3 text-xs"
                  onClick={() => void save({ suggestEngine: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          <SecretField
            key={engine}
            id="at-suggest-key"
            label={engine === "gemini" ? t("Ключ Google Gemini") : t("Ключ TypeSafe (Jev)")}
            hint={engine === "gemini" ? t("Ключ Gemini API из Google AI Studio (aistudio.google.com).") : t("Секретный ключ API TypeSafe (typesafe.ai).")}
            keySet={engine === "gemini" ? settings.suggest.geminiKeySet : settings.suggest.jevKeySet}
            keyEnv={keyEnv}
            envSecrets={settings.suggest.envSecrets}
            match={engine === "gemini" ? /gemini|google/iu : /jev|typesafe|openlux/iu}
            busy={busy}
            onSave={(value) => void save(engine === "gemini" ? { geminiApiKey: value } : { jevApiKey: value })}
            onPickEnv={(name) => void save(engine === "gemini" ? { geminiApiKeyEnv: name } : { jevApiKeyEnv: name })}
          />

          <Field label={t("Модель")} hint={engine === "gemini" ? t("По умолчанию gemini-3.5-flash-lite.") : t("По умолчанию jev-1.14.0.")} htmlFor="at-suggest-model">
            <Input
              key={`${engine}:${engineModel}`}
              id="at-suggest-model"
              className="h-9 max-w-md"
              defaultValue={engineModel}
              disabled={busy}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== engineModel) void save(engine === "gemini" ? { geminiModel: value } : { jevModel: value });
              }}
            />
          </Field>

          <Field label={t("Инструменты skills_find и skill_read")} hint={t("Агент сам ищет и читает навыки хаба. Подсказка тогда ссылается на skill_read.")}>
            <Switch
              className="at-switch"
              checked={settings.suggest.tools}
              disabled={busy}
              aria-label={t("Инструменты skills_find и skill_read")}
              onCheckedChange={(suggestTools) => void save({ suggestTools })}
            />
          </Field>
        </div>
      </section>

      <section className="at-panel">
        <div className="at-panel-head">
          <h2 className="text-sm font-medium">{t("Классификатор навыков")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Новые навыки без категории по одному уходят в скрытый тред BB с этой моделью; она выбирает или создаёт категорию.")}
          </p>
        </div>
        <div className="at-panel-body space-y-5 p-4">
          <Field label={t("Провайдер")} hint={t("Агент BB, в котором работает тред классификатора.")} htmlFor="at-cls-provider">
            <select
              id="at-cls-provider"
              className={selectClass}
              value={settings.provider}
              disabled={busy}
              onChange={(event) => void save({ provider: event.target.value, model: "" })}
            >
              {settings.providers.some((item) => item.id === settings.provider) ? null : (
                <option value={settings.provider}>{settings.provider}</option>
              )}
              {settings.providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.label}
                  {item.available ? "" : ` (${t("недоступен")})`}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("Модель")} hint={t("Подойдёт быстрая и недорогая: задача — выбрать категорию по описанию.")} htmlFor="at-cls-model">
            <select
              id="at-cls-model"
              className={selectClass}
              value={settings.model}
              disabled={busy}
              onChange={(event) => void save({ model: event.target.value })}
            >
              <option value="">{t("Модель провайдера по умолчанию")}</option>
              {settings.model !== "" && !modelKnown ? <option value={settings.model}>{settings.model}</option> : null}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            {selectedModel?.description ? <p className="mt-1 text-xs text-muted-foreground">{selectedModel.description}</p> : null}
            {modelsError !== null ? <p className="mt-1 text-xs at-text-warning">{modelsError}</p> : null}
            {models.length === 0 && modelsError === null ? (
              <p className="mt-1 text-xs text-muted-foreground">{t("Загрузка моделей…")}</p>
            ) : null}
          </Field>

          <Field label={t("Проект треда")} hint={t("Где создаётся скрытый тред. Пусто — личный проект.")} htmlFor="at-cls-project">
            <select
              id="at-cls-project"
              className={selectClass}
              value={settings.projectId}
              disabled={busy}
              onChange={(event) => void save({ projectId: event.target.value })}
            >
              <option value="">{t("Личный проект")}</option>
              {settings.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("Раскладывать автоматически")} hint={t("Раз в час новые навыки уходят классификатору. Выключено — только по кнопке «Разложить новые».")}>
            <Switch
              className="at-switch"
              checked={settings.auto}
              disabled={busy}
              aria-label={t("Раскладывать автоматически")}
              onCheckedChange={(auto) => void save({ auto })}
            />
          </Field>
        </div>
      </section>

      <section className="at-panel">
        <div className="at-panel-head">
          <h2 className="text-sm font-medium">{t("Навыки на машинах")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Канон навыков — хаб BB: он отдаёт навыки в каждую сессию на любой машине.")}
          </p>
        </div>
        <div className="at-panel-body space-y-5 p-4">
          <Field
            label={
              <span className="inline-flex items-center">
                {t("Только на хабе")}
                <span className="at-pill at-pill-warning at-label-badge">{t("Эксперимент")}</span>
              </span>
            }
            hint={t("Раз в час плагин переносит на хаб навыки, которых там нет, и убирает копии с машин в архив на той же машине. Сессии получают навыки только с хаба. Выключено — папки навыков на машинах не меняются.")}
          >
            <Switch
              className="at-switch"
              checked={settings.hubOnly}
              disabled={busy}
              aria-label={t("Только на хабе")}
              onCheckedChange={(hubOnly) => void save({ hubOnly })}
            />
          </Field>
          {settings.hubOnlyLast === null ? null : (
            <p className="text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
              {tp(
                "Последний прогон: {0} · перенесено {1} · убрано {2} · отклонено {3}",
                new Date(settings.hubOnlyLast.at).toLocaleString(getLang() === "ru" ? "ru-RU" : "en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
                settings.hubOnlyLast.imported,
                settings.hubOnlyLast.moved,
                settings.hubOnlyLast.rejected,
              )}
              {settings.hubOnlyLast.skipped.length > 0
                ? tp(
                    " · пропущено: {0}",
                    settings.hubOnlyLast.skipped.map((item) => `${item.hostName} (${item.reason})`).join("; "),
                  )
                : ""}
            </p>
          )}
        </div>
      </section>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {busy ? t("Сохранение…") : saved ? t("Сохранено") : ""}
      </p>
    </div>
  );
}

/**
 * The key comes from one source: typed in (write-only, the page never receives
 * it) or an Env Catalog record picked by name (the server reads the value).
 */
function SecretField(props: {
  id: string;
  label: string;
  hint: string;
  keySet: boolean;
  keyEnv: string;
  envSecrets: Array<{ name: string; service: string }> | null;
  match: RegExp;
  busy: boolean;
  onSave: (value: string) => void;
  onPickEnv: (name: string) => void;
}) {
  const [value, setValue] = useState("");
  const secrets = props.envSecrets ?? [];
  // Records that look like this engine's key first.
  const likely = secrets.filter((item) => props.match.test(`${item.name} ${item.service}`));
  const rest = secrets.filter((item) => !likely.includes(item));
  const label = (item: { name: string; service: string }) => (item.service !== "" ? `${item.name} · ${item.service}` : item.name);
  return (
    <Field label={props.label} hint={props.hint} htmlFor={props.id}>
      <div className="grid max-w-md gap-2">
        {props.envSecrets === null ? null : (
          <select
            aria-label={t("Источник ключа")}
            className={selectClass}
            value={props.keyEnv}
            disabled={props.busy}
            onChange={(event) => props.onPickEnv(event.target.value)}
          >
            <option value="">{t("Вписать ключ вручную")}</option>
            {props.keyEnv !== "" && !secrets.some((item) => item.name === props.keyEnv) ? (
              <option value={props.keyEnv}>{tp("{0} (нет в Env Catalog)", props.keyEnv)}</option>
            ) : null}
            {likely.length > 0 ? (
              <optgroup label={t("Подходящие")}>
                {likely.map((item) => (
                  <option key={item.name} value={item.name}>
                    {label(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {rest.length > 0 ? (
              <optgroup label={t("Остальные в Env Catalog")}>
                {rest.map((item) => (
                  <option key={item.name} value={item.name}>
                    {label(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        )}
        {props.keyEnv !== "" ? null : (
          <div className="flex gap-2">
            <Input
              id={props.id}
              type="password"
              className="h-9"
              value={value}
              placeholder={props.keySet ? t("Ключ сохранён — введите новый, чтобы заменить") : t("Вставьте ключ")}
              disabled={props.busy}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0"
              disabled={props.busy || value.trim() === ""}
              onClick={() => {
                props.onSave(value.trim());
                setValue("");
              }}
            >
              {t("Сохранить")}
            </Button>
            {props.keySet ? (
              <Button type="button" variant="ghost" className="h-9 shrink-0" disabled={props.busy} onClick={() => props.onSave("")}>
                {t("Удалить")}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {props.keyEnv !== "" ? tp("Ключ берётся из Env Catalog: {0}", props.keyEnv) : props.keySet ? t("Ключ задан") : t("Ключа нет")}
      </p>
    </Field>
  );
}
