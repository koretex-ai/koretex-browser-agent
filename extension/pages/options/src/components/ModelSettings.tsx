import { useState, useEffect, useCallback } from 'react';
import { chatSettingsStore, DEFAULT_CHAT_SETTINGS } from '@extension/storage';

/** Which settings tab this render shows — the component stays mounted across
 * tab switches so unsaved edits survive; inactive sections are just hidden. */
export type ModelSettingsSection = 'cloud' | 'local' | 'privacy';

interface ModelSettingsProps {
  isDarkMode?: boolean;
  section: ModelSettingsSection;
}

type ConnectionStatus =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; models: string[] }
  | { state: 'error'; message: string };

export const ModelSettings = ({ isDarkMode = false, section }: ModelSettingsProps) => {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CHAT_SETTINGS.baseUrl);
  const [model, setModel] = useState(DEFAULT_CHAT_SETTINGS.model);
  const [grounderModel, setGrounderModel] = useState(DEFAULT_CHAT_SETTINGS.grounderModel);
  const [orchestratorEnabled, setOrchestratorEnabled] = useState(DEFAULT_CHAT_SETTINGS.orchestratorEnabled);
  const [orchestratorBaseUrl, setOrchestratorBaseUrl] = useState(DEFAULT_CHAT_SETTINGS.orchestratorBaseUrl);
  const [orchestratorApiKey, setOrchestratorApiKey] = useState(DEFAULT_CHAT_SETTINGS.orchestratorApiKey);
  const [orchestratorModel, setOrchestratorModel] = useState(DEFAULT_CHAT_SETTINGS.orchestratorModel);
  const [navigatorModel, setNavigatorModel] = useState(DEFAULT_CHAT_SETTINGS.navigatorModel);
  const [cloudOnly, setCloudOnly] = useState(DEFAULT_CHAT_SETTINGS.cloudOnly);
  const [cloudReaderModel, setCloudReaderModel] = useState(DEFAULT_CHAT_SETTINGS.cloudReaderModel);
  const [piiGuard, setPiiGuard] = useState(DEFAULT_CHAT_SETTINGS.piiGuard);
  const [sensitiveSites, setSensitiveSites] = useState(DEFAULT_CHAT_SETTINGS.sensitiveSites);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>({ state: 'idle' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chatSettingsStore.getSettings().then(settings => {
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
      setGrounderModel(settings.grounderModel);
      setOrchestratorEnabled(settings.orchestratorEnabled);
      setOrchestratorBaseUrl(settings.orchestratorBaseUrl);
      setOrchestratorApiKey(settings.orchestratorApiKey);
      setOrchestratorModel(settings.orchestratorModel);
      setNavigatorModel(settings.navigatorModel);
      setCloudOnly(settings.cloudOnly);
      // Profiles saved before the default existed hold '' — show the default
      setCloudReaderModel(settings.cloudReaderModel || DEFAULT_CHAT_SETTINGS.cloudReaderModel);
      setPiiGuard(settings.piiGuard);
      setSensitiveSites(settings.sensitiveSites);
    });
  }, []);

  const testConnection = useCallback(async (url: string) => {
    setConnection({ state: 'testing' });
    try {
      const response = await fetch(`${url}/api/tags`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const models: string[] = (data.models ?? []).map((m: { name: string }) => m.name);
      setAvailableModels(models);
      setConnection({ state: 'ok', models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnection({ state: 'error', message: `Cannot reach Ollama at ${url} (${message})` });
    }
  }, []);

  // Probe Ollama once on mount with the stored URL
  useEffect(() => {
    chatSettingsStore.getSettings().then(settings => testConnection(settings.baseUrl));
  }, [testConnection]);

  const handleSave = async () => {
    await chatSettingsStore.updateSettings({
      baseUrl: baseUrl.replace(/\/$/, ''),
      model,
      grounderModel,
      orchestratorEnabled,
      orchestratorBaseUrl: orchestratorBaseUrl.replace(/\/$/, ''),
      orchestratorApiKey: orchestratorApiKey.trim(),
      orchestratorModel: orchestratorModel.trim(),
      navigatorModel: navigatorModel.trim(),
      cloudOnly,
      cloudReaderModel: cloudReaderModel.trim(),
      piiGuard,
      sensitiveSites: sensitiveSites.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputClass = `w-full rounded-md border p-2 text-sm ${
    isDarkMode ? 'border-[#3D3D3D]/50 bg-[#141414] text-gray-200' : 'border-gray-300 bg-white text-gray-800'
  }`;
  const labelClass = `mb-1 block text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`;
  const hintClass = `mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`;
  const headingClass = `text-lg font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`;
  const introClass = `text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`;

  return (
    <section>
      {/* ---- CLOUD ---- */}
      <div className={section === 'cloud' ? 'space-y-6' : 'hidden'}>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h2 className={headingClass}>Cloud</h2>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orchestratorEnabled}
                onChange={e => setOrchestratorEnabled(e.target.checked)}
                className="size-4 accent-[#E8E8E8]"
              />
              <span className={isDarkMode ? 'text-gray-300' : 'text-gray-700'}>Enabled</span>
            </label>
          </div>
          <p className={introClass}>
            Works with any OpenAI-compatible endpoint — paste your API key below and you&apos;re set (OpenRouter by
            default). PRIVACY: the navigator model receives a SCREENSHOT of the active tab every step — including
            whatever is visible in your logged-in sessions. All cloud calls request no-data-retention routing, but the
            images do leave your machine.
          </p>
        </div>

        <div>
          <label htmlFor="orch-key" className={labelClass}>
            API key
          </label>
          <input
            id="orch-key"
            type="password"
            value={orchestratorApiKey}
            onChange={e => setOrchestratorApiKey(e.target.value)}
            placeholder="sk-or-…"
            autoComplete="off"
            className={inputClass}
          />
          <p className={hintClass}>
            The only required field — get one at openrouter.ai, or use any compatible provider.
          </p>
        </div>

        <div>
          <label htmlFor="orch-url" className={labelClass}>
            OpenAI-compatible endpoint
          </label>
          <input
            id="orch-url"
            type="text"
            value={orchestratorBaseUrl}
            onChange={e => setOrchestratorBaseUrl(e.target.value)}
            placeholder={DEFAULT_CHAT_SETTINGS.orchestratorBaseUrl}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="orch-model" className={labelClass}>
            Orchestrator model
          </label>
          <input
            id="orch-model"
            type="text"
            value={orchestratorModel}
            onChange={e => setOrchestratorModel(e.target.value)}
            placeholder={DEFAULT_CHAT_SETTINGS.orchestratorModel}
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              { label: 'GLM-5.2 (recommended)', value: 'z-ai/glm-5.2' },
              { label: 'DeepSeek V4 Flash (budget)', value: 'deepseek/deepseek-v4-flash' },
              { label: 'Kimi K2.6', value: 'moonshotai/kimi-k2.6' },
            ].map(preset => (
              <button
                key={preset.value}
                type="button"
                onClick={() => setOrchestratorModel(preset.value)}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  orchestratorModel === preset.value
                    ? 'border-[#E8E8E8] text-[#E8E8E8]'
                    : isDarkMode
                      ? 'border-[#3D3D3D]/50 text-gray-400 hover:text-gray-200'
                      : 'border-gray-300 text-gray-500 hover:text-gray-700'
                }`}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="navigator-model" className={labelClass}>
            Navigator model (multimodal — judges each step from a screenshot)
          </label>
          <input
            id="navigator-model"
            type="text"
            value={navigatorModel}
            onChange={e => setNavigatorModel(e.target.value)}
            placeholder={DEFAULT_CHAT_SETTINGS.navigatorModel}
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              { label: 'MiMo-V2.5 (recommended)', value: 'xiaomi/mimo-v2.5' },
              { label: 'Qwen3.5-122B', value: 'qwen/qwen3.5-122b-a10b' },
              { label: 'GLM-4.6V', value: 'z-ai/glm-4.6v' },
              { label: 'GPT-5.6 Luna (control)', value: 'openai/gpt-5.6-luna' },
            ].map(preset => (
              <button
                key={preset.value}
                type="button"
                onClick={() => setNavigatorModel(preset.value)}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  navigatorModel === preset.value
                    ? 'border-[#E8E8E8] text-[#E8E8E8]'
                    : isDarkMode
                      ? 'border-[#3D3D3D]/50 text-gray-400 hover:text-gray-200'
                      : 'border-gray-300 text-gray-500 hover:text-gray-700'
                }`}>
                {preset.label}
              </button>
            ))}
          </div>
          <p className={hintClass}>
            This is the model that sees screenshots. Leave empty to use the orchestrator model (it must then be
            multimodal).
          </p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              Cloud-only mode
            </h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={cloudOnly}
                onChange={e => setCloudOnly(e.target.checked)}
                className="size-4 accent-[#E8E8E8]"
              />
              <span className={isDarkMode ? 'text-gray-300' : 'text-gray-700'}>Enabled</span>
            </label>
          </div>
          <p className={introClass}>
            Everything runs through the endpoint above — no Ollama required (the default). Turn off to read pages and
            ground clicks with the local models from the Local tab; full page text then stays on your machine.
          </p>
          {cloudOnly && (
            <div className="mt-4">
              <label htmlFor="cloud-reader" className={labelClass}>
                Cloud reader model
              </label>
              <input
                id="cloud-reader"
                type="text"
                value={cloudReaderModel}
                onChange={e => setCloudReaderModel(e.target.value)}
                placeholder={DEFAULT_CHAT_SETTINGS.cloudReaderModel}
                className={inputClass}
              />
              <p className={hintClass}>
                Bulk-reads page text for extract/harvest steps — the default works well; any cheap text model can be
                substituted. Click grounding uses the navigator model.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ---- LOCAL ---- */}
      <div className={section === 'local' ? 'space-y-6' : 'hidden'}>
        <div>
          <h2 className={`mb-1 ${headingClass}`}>Local models</h2>
          <p className={introClass}>
            Used when Cloud-only mode (Cloud tab) is off: page reading and click grounding run on your machine through
            Ollama, and full page text never leaves it.
          </p>
        </div>

        <div>
          <label htmlFor="ollama-url" className={labelClass}>
            Ollama URL
          </label>
          <div className="flex gap-2">
            <input
              id="ollama-url"
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_CHAT_SETTINGS.baseUrl}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => testConnection(baseUrl.replace(/\/$/, ''))}
              className="shrink-0 rounded-md bg-[#E8E8E8] px-3 py-1 text-sm font-medium text-[#000000] transition-colors hover:bg-[#FFFFFF]">
              Test
            </button>
          </div>
          {connection.state === 'testing' && (
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Connecting…</p>
          )}
          {connection.state === 'ok' && (
            <p className="mt-1 text-sm text-[#E8E8E8]">
              Connected — {connection.models.length} model{connection.models.length === 1 ? '' : 's'} available
            </p>
          )}
          {connection.state === 'error' && <p className="mt-1 text-sm text-red-500">{connection.message}</p>}
        </div>

        <div>
          <label htmlFor="chat-model" className={labelClass}>
            Local reader model
          </label>
          {availableModels.length > 0 ? (
            <select id="chat-model" value={model} onChange={e => setModel(e.target.value)} className={inputClass}>
              {!availableModels.includes(model) && <option value={model}>{model} (not installed)</option>}
              {availableModels.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="chat-model"
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder={DEFAULT_CHAT_SETTINGS.model}
              className={inputClass}
            />
          )}
          <p className={hintClass}>
            Bulk-reads page text for extract/harvest steps — full pages never leave your machine, only compact digests
            do. Also answers plain chat when the cloud orchestrator is off.
          </p>
        </div>

        <div>
          <label htmlFor="grounder-model" className={labelClass}>
            Vision grounder model
          </label>
          {availableModels.length > 0 ? (
            <select
              id="grounder-model"
              value={grounderModel}
              onChange={e => setGrounderModel(e.target.value)}
              className={inputClass}>
              {!availableModels.includes(grounderModel) && (
                <option value={grounderModel}>{grounderModel} (not installed)</option>
              )}
              {availableModels.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="grounder-model"
              type="text"
              value={grounderModel}
              onChange={e => setGrounderModel(e.target.value)}
              placeholder={DEFAULT_CHAT_SETTINGS.grounderModel}
              className={inputClass}
            />
          )}
          <p className={hintClass}>
            Turns element descriptions (&quot;the Post button inside the composer&quot;) into click coordinates from a
            screenshot — how clicks land on canvas UIs and ambiguous labels. Runs locally; grounding never goes to the
            cloud.
          </p>
        </div>
      </div>

      {/* ---- PRIVACY ---- */}
      <div className={section === 'privacy' ? 'space-y-6' : 'hidden'}>
        <div>
          <h2 className={`mb-1 ${headingClass}`}>Privacy</h2>
          <p className={introClass}>
            Controls over what leaves your machine when cloud models are in use. All cloud calls already request
            no-data-retention routing (providers that neither train on nor store prompts).
          </p>
        </div>

        <div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={piiGuard}
              onChange={e => setPiiGuard(e.target.checked)}
              className="size-4 accent-[#E8E8E8]"
            />
            <span className={isDarkMode ? 'text-gray-300' : 'text-gray-700'}>PII guard (recommended)</span>
          </label>
          <p className={hintClass}>
            In cloud-only mode: emails, phone numbers, card numbers and SSNs in outgoing text are replaced with tokens
            before leaving your machine; the real values are substituted back locally when the agent types them. Does
            not cover screenshots or names in ordinary page content.
          </p>
        </div>

        <div>
          <label htmlFor="sensitive-sites" className={labelClass}>
            Sensitive sites (ask before working there)
          </label>
          <input
            id="sensitive-sites"
            type="text"
            value={sensitiveSites}
            onChange={e => setSensitiveSites(e.target.value)}
            placeholder={DEFAULT_CHAT_SETTINGS.sensitiveSites}
            className={inputClass}
          />
          <p className={hintClass}>
            Comma-separated URL fragments. On a matching site the agent pauses and asks before continuing, because
            screenshots of it would go to the cloud model.
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-[#E8E8E8] px-4 py-2 text-sm font-medium text-[#000000] transition-colors hover:bg-[#FFFFFF]">
          Save
        </button>
        {saved && <span className="text-sm text-[#E8E8E8]">Saved</span>}
      </div>
    </section>
  );
};
