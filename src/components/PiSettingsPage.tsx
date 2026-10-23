/**
 * Settings → Pi (DS §4.11): what a new Pi session starts with, how the selected pane holds a message
 * that arrives while a turn runs, its context switches, and where Pi's own keys are changed. The file
 * rows are Pi's `settings.json`, which the server writes for the keys the web owns; the session rows
 * are the pane's live RPC commands. A pane the terminal owns has no RPC, so its rows are drawn disabled
 * and say where they are changed instead. A control only moves once Pi or the file has answered: a
 * refusal leaves it as it was and puts the server's sentence under its label.
 *
 * The Scoped models dialog is this page's (DS §4.11): it holds Pi's model list and the file already,
 * and `/scoped-models` in the message box asks for it through lib/piScopedModels.ts.
 */
import { useEffect, useState, type ReactNode } from "react";

import { ApiError, fetchPiNativeState, fetchPiSettings, savePiSettings, sendPiRpc, type PiSettingsFile } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { takeScopedModelsRequest } from "../lib/piScopedModels.ts";
import { useSettings } from "../lib/settings.ts";
import { piModels, type PickerModel } from "./PiModelPicker.tsx";
import { ScopedModelsDialog } from "./ScopedModelsDialog.tsx";
import { THINKING_LEVELS, thinkingLevelLabel } from "./PiThinkingMenu.tsx";
import { Segmented, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

export interface PiSettingsPageProps {
  /** the selected Pi pane, whose Pi the session rows command; null: no Pi pane is selected */
  pane: { paneId: string; name: string; machineId: string } | null;
  /** Settings → Shortcuts, which holds the read-only list of Pi's keys */
  onOpenShortcuts: () => void;
}

/** How Pi takes a message that arrives while a turn runs (`set_steering_mode`, `set_follow_up_mode`). */
type Delivery = "one-at-a-time" | "all";

/** The session-level rows, as `get_state` reports them. */
interface PiSessionSettings {
  steeringMode: Delivery;
  followUpMode: Delivery;
  autoCompaction: boolean;
  autoRetry: boolean;
}

const deliveryOf = (value: unknown): Delivery | null => value === "all" || value === "one-at-a-time" ? value : null;

/** Pi's `get_state` answer, or null when it is not the shape this page draws. */
function sessionSettings(state: unknown): PiSessionSettings | null {
  const fields = (state ?? {}) as Record<string, unknown>;
  const steeringMode = deliveryOf(fields["steeringMode"]);
  const followUpMode = deliveryOf(fields["followUpMode"]);
  if (steeringMode === null || followUpMode === null) return null;
  // shortcut: `get_state` names no auto-retry flag (docs/rpc-commands.md), so that switch starts from Pi's
  // documented default, on, and from what this page set; a flag Pi adds later is read where it appears
  return { steeringMode, followUpMode, autoCompaction: fields["autoCompactionEnabled"] === true, autoRetry: fields["autoRetryEnabled"] !== false };
}

/** The server's or Pi's own sentence for a refused write, without the URL and status around it. */
const reason = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

/** An option's key, and back: an id keeps its own colons (`…-v1:0`, `…:free`), so split at the first one. */
const modelKey = (provider: string, id: string): string => `${provider}:${id}`;
const modelParts = (key: string): { provider: string; id: string } => {
  const at = key.indexOf(":");
  return at === -1 ? { provider: key, id: "" } : { provider: key.slice(0, at), id: key.slice(at + 1) };
};

export function PiSettingsPage({ pane, onOpenShortcuts }: PiSettingsPageProps) {
  const t = useT();
  const { settings, update } = useSettings();
  const [file, setFile] = useState<PiSettingsFile | null>(null);
  const [models, setModels] = useState<PickerModel[]>([]);
  const [session, setSession] = useState<PiSessionSettings | null>(null);
  /** the Scoped models dialog; `/scoped-models` asked for it, and the row's Edit… opens it the same way */
  const [editing, setEditing] = useState(() => takeScopedModelsRequest());
  /** the scoped list was just written: the row says so until the dialog is opened again */
  const [scopedSaved, setScopedSaved] = useState(false);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  /** the terminal owns the pane's Pi: no RPC, so its rows only say where they are changed */
  const [terminal, setTerminal] = useState(false);
  const [failure, setFailure] = useState<{ row: string; message: string } | null>(null);
  /** why the session rows are disabled while the terminal does not own the pane: Pi is still connecting,
   * it has gone, or it answered with an error */
  const [sessionNotice, setSessionNotice] = useState<{ mode: "connecting" | "lost" } | { error: string } | null>(null);
  // a select is the DOM's once opened: a write that changed nothing re-mounts it on the value that stands
  const [attempt, setAttempt] = useState(0);
  const machineId = pane?.machineId ?? "local";

  useEffect(() => {
    if (pane === null) return;
    let live = true;
    setFile(null);
    setModels([]);
    setSession(null);
    setReadFailure(null);
    setFailure(null);
    setTerminal(false);
    setSessionNotice(null);
    void fetchPiSettings(machineId).then(
      (next) => { if (live) setFile(next); },
      (error: unknown) => { if (live) setReadFailure(reason(error)); },
    );
    void fetchPiNativeState(pane.paneId, machineId).then(async (state) => {
      if (!live) return;
      // only a pane whose Pi the terminal owns has no RPC; a pane still connecting or gone is waited for
      if (state === null) { setTerminal(true); return; }
      if (state.mode !== "native") { setSessionNotice({ mode: state.mode === "lost" ? "lost" : "connecting" }); return; }
      const [values, listed] = await Promise.allSettled([
        sendPiRpc(pane.paneId, { type: "get_state" }, machineId),
        sendPiRpc(pane.paneId, { type: "get_available_models" }, machineId),
      ]);
      if (!live) return;
      if (values.status === "fulfilled") setSession(sessionSettings(values.value));
      else setSessionNotice({ error: reason(values.reason) });
      if (listed.status === "fulfilled") setModels(piModels(listed.value));
    }, (error: unknown) => { if (live) setSessionNotice({ error: reason(error) }); });
    return () => { live = false; };
  }, [machineId, pane]);

  const refused = (row: string, error: unknown): void => {
    setFailure({ row, message: t("Couldn't change {setting}: {reason}", { setting: row, reason: reason(error) }) });
    setAttempt((count) => count + 1);
  };

  /** One write of Pi's file: the answer is the file as it now is, and only then does the row move. */
  const writeFile = async (row: string, changes: Record<string, string | readonly string[]>): Promise<void> => {
    try {
      setFile(await savePiSettings(changes, machineId));
      setFailure(null);
    } catch (error) {
      refused(row, error);
    }
  };

  /** One session command: the page takes the values only once Pi answered, so a refusal changes nothing.
   * The row it changes is merged into whatever the page holds by then: a slower earlier answer must not
   * put back the row a later one already moved. */
  const writeSession = async (row: string, change: (current: PiSessionSettings) => PiSessionSettings, command: { type: string } & Record<string, unknown>): Promise<void> => {
    if (pane === null) return;
    try {
      await sendPiRpc(pane.paneId, command, machineId);
      setSession((current) => current && change(current));
      setFailure(null);
    } catch (error) {
      refused(row, error);
    }
  };

  /** A row's own sentence, with the reason a write it took was refused under it. The row is named by
   * its own label, which is also what the sentence says the setting is. */
  const described = (row: string, text: ReactNode): ReactNode => <>
    {text}
    {failure?.row === row && <span className="settings-error" role="alert">{failure.message}</span>}
  </>;
  // a Terminal-mode pane's rows are the terminal's: they say there where they are changed
  const hinted = (control: ReactNode): ReactNode => <span title={readOnlyHint}>{control}</span>;

  if (pane === null) return <p className="settings-hint">{t("Select a Pi agent to change its settings.")}</p>;

  const saved = file?.settings ?? {};
  const savedProvider = typeof saved["defaultProvider"] === "string" ? saved["defaultProvider"] : "";
  const savedModel = typeof saved["defaultModel"] === "string" ? saved["defaultModel"] : "";
  const savedThinking = typeof saved["defaultThinkingLevel"] === "string" ? saved["defaultThinkingLevel"] : "";
  const scoped = Array.isArray(saved["enabledModels"]) ? saved["enabledModels"] : null;
  /** what the Scoped models row says under its label: how much of Pi's list is in the cycle */
  const scopedCount = models.length === 0 ? null : scoped === null ? t("Every model is in the cycle") : t("{scoped} of {total} in the cycle", { scoped: scoped.length, total: models.length });
  // the saved model stays an option even while Pi's list is unknown (a Terminal-mode pane has no list)
  const modelOptions = savedModel === "" ? models : models.some((model) => model.id === savedModel && model.provider === savedProvider) ? models : [...models, { provider: savedProvider, id: savedModel, name: savedModel, reasoning: false, images: false, contextWindow: null }];
  const providers = [...new Set(modelOptions.map((model) => model.provider))];
  const readOnlyHint = terminal ? t("Change it in the terminal") : undefined;
  const deliveryOptions = [
    { value: "one-at-a-time" as const, label: t("One at a time") },
    { value: "all" as const, label: t("All at once") },
  ];

  return <>
    <p className="settings-hint">{t("Applies to: {pane}", { pane: pane.name })}</p>
    {readFailure !== null && <p className="settings-hint settings-error" role="alert">{readFailure}</p>}
    {sessionNotice !== null && ("mode" in sessionNotice
      ? <p className="settings-hint" role="status">{sessionNotice.mode === "lost" ? t("Lost the connection to Pi.") : t("Connecting to Pi…")}</p>
      : <p className="settings-hint settings-error" role="alert">{sessionNotice.error}</p>)}

    <SettingsGroup title={t("Model")} note={t("A new Pi session starts with these. A running Pi reads them again with /reload.")}>
      <SettingsRow label={t("Default model")} htmlFor="pi-default-model" description={described(t("Default model"), selectedModelText(modelOptions, savedProvider, savedModel))}>
        <select key={`model-${attempt}`} id="pi-default-model" className="select settings-select" value={modelKey(savedProvider, savedModel)} onChange={(event) => {
          const picked = modelParts(event.target.value);
          void writeFile(t("Default model"), { defaultProvider: picked.provider, defaultModel: picked.id });
        }}>
          {savedModel === "" && <option value=":" disabled>{t("Automatic")}</option>}
          {providers.map((provider) => <optgroup key={provider} label={provider === "" ? t("Other") : provider}>
            {modelOptions.filter((model) => model.provider === provider).map((model) => <option key={modelKey(model.provider, model.id)} value={modelKey(model.provider, model.id)}>{model.name}</option>)}
          </optgroup>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("Default thinking level")} htmlFor="pi-default-thinking" description={described(t("Default thinking level"), "")}>
        <select key={`thinking-${attempt}`} id="pi-default-thinking" className="select settings-select" value={savedThinking === "" ? "medium" : savedThinking} onChange={(event) => void writeFile(t("Default thinking level"), { defaultThinkingLevel: event.target.value })}>
          {THINKING_LEVELS.map((level) => <option key={level} value={level}>{t(thinkingLevelLabel(level))}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("Scoped models")} description={scopedCount === null && !scopedSaved ? undefined : described(t("Scoped models"), <>
        {scopedSaved && <span role="status">{t("Saved as default")} </span>}
        {scopedCount}
      </>)}>
        <button type="button" className="btn" disabled={models.length === 0} onClick={() => { setScopedSaved(false); setEditing(true); }}>{t("Edit…")}</button>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Messages")} note={terminal ? readOnlyHint : undefined}>
      <SettingsRow label={t("Steering delivery")} wide description={described(t("Steering delivery"), t("A message sent while Pi works."))}>
        {hinted(<Segmented label={t("Steering delivery")} value={session?.steeringMode ?? "one-at-a-time"} disabled={terminal || session === null} options={deliveryOptions} onChange={(mode) => {
          void writeSession(t("Steering delivery"), (current) => ({ ...current, steeringMode: mode }), { type: "set_steering_mode", mode });
        }} />)}
      </SettingsRow>
      <SettingsRow label={t("Follow-up delivery")} wide description={described(t("Follow-up delivery"), t("A message sent to run after the turn."))}>
        {hinted(<Segmented label={t("Follow-up delivery")} value={session?.followUpMode ?? "one-at-a-time"} disabled={terminal || session === null} options={deliveryOptions} onChange={(mode) => {
          void writeSession(t("Follow-up delivery"), (current) => ({ ...current, followUpMode: mode }), { type: "set_follow_up_mode", mode });
        }} />)}
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Context")} note={terminal ? readOnlyHint : undefined}>
      <SettingsRow label={t("Compact automatically")} description={described(t("Compact automatically"), t("Compacts when the window is nearly full."))}>
        {hinted(<Toggle label={t("Compact automatically")} checked={session?.autoCompaction === true} disabled={terminal || session === null} onChange={(enabled) => {
          void writeSession(t("Compact automatically"), (current) => ({ ...current, autoCompaction: enabled }), { type: "set_auto_compaction", enabled });
        }} />)}
      </SettingsRow>
      <SettingsRow label={t("Retry on provider errors")} description={described(t("Retry on provider errors"), t("Waits and tries the turn again when a provider fails."))}>
        {hinted(<Toggle label={t("Retry on provider errors")} checked={session?.autoRetry === true} disabled={terminal || session === null} onChange={(enabled) => {
          void writeSession(t("Retry on provider errors"), (current) => ({ ...current, autoRetry: enabled }), { type: "set_auto_retry", enabled });
        }} />)}
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Keys")}>
      <SettingsRow label={t("Pi keys in the message box")} description={t("Ctrl+L model · Ctrl+P next model · Shift+Tab thinking · Ctrl+T thinking blocks · Ctrl+O tool output")}>
        <Toggle label={t("Pi keys in the message box")} checked={settings.piKeys} onChange={(checked) => update({ piKeys: checked })} />
      </SettingsRow>
      <SettingsRow label={t("Shortcut list")} description={t("Your keybindings.json is applied.")}>
        <button type="button" className="btn" onClick={onOpenShortcuts}>{t("View")}</button>
      </SettingsRow>
    </SettingsGroup>
    {editing && <ScopedModelsDialog models={models} scoped={scoped} machineId={machineId} onSaved={(next) => { setFile(next); setScopedSaved(true); }} onClose={() => setEditing(false)} />}
  </>;
}

/** What a row under the model field adds: the model's name and provider once it is known. */
function selectedModelText(models: readonly PickerModel[], provider: string, id: string): string {
  if (id === "") return "";
  const model = models.find((candidate) => candidate.id === id && candidate.provider === provider);
  return model === undefined || model.provider === "" ? id : `${model.name} · ${model.provider}`;
}
