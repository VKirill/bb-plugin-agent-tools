import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { getLang, t, tp, applyUiLang, setUiLangChoice, type UiLangChoice } from "./i18n";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";

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
    async (patch: { provider?: string; model?: string; auto?: boolean; projectId?: string; hubOnly?: boolean }) => {
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
            <p className="text-xs text-muted-foreground">
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
