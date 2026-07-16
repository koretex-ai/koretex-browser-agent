import { useState, useEffect, useCallback } from 'react';
import { chatSettingsStore, DEFAULT_CHAT_SETTINGS } from '@extension/storage';

interface ModelSettingsProps {
  isDarkMode?: boolean;
}

type ConnectionStatus =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; models: string[] }
  | { state: 'error'; message: string };

export const ModelSettings = ({ isDarkMode = false }: ModelSettingsProps) => {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CHAT_SETTINGS.baseUrl);
  const [model, setModel] = useState(DEFAULT_CHAT_SETTINGS.model);
  const [grounderModel, setGrounderModel] = useState(DEFAULT_CHAT_SETTINGS.grounderModel);
  const [orchestratorEnabled, setOrchestratorEnabled] = useState(DEFAULT_CHAT_SETTINGS.orchestratorEnabled);
  const [orchestratorBaseUrl, setOrchestratorBaseUrl] = useState(DEFAULT_CHAT_SETTINGS.orchestratorBaseUrl);
  const [orchestratorApiKey, setOrchestratorApiKey] = useState(DEFAULT_CHAT_SETTINGS.orchestratorApiKey);
  const [orchestratorModel, setOrchestratorModel] = useState(DEFAULT_CHAT_SETTINGS.orchestratorModel);
  const [navigatorModel, setNavigatorModel] = useState(DEFAULT_CHAT_SETTINGS.navigatorModel);
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
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputClass = `w-full rounded-md border p-2 text-sm ${
    isDarkMode ? 'border-[#1F7A4A]/50 bg-[#12251A] text-gray-200' : 'border-gray-300 bg-white text-gray-800'
  }`;
  const labelClass = `mb-1 block text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`;

  return (
    <section className="space-y-6">
      <div>
        <h2 className={`mb-1 text-lg font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Local model</h2>
        <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          The chat runs entirely on your machine through Ollama. Nothing leaves your computer.
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
            className="shrink-0 rounded-md bg-[#2BE87D] px-3 py-1 text-sm font-medium text-[#06130C] transition-colors hover:bg-[#59F09C]">
            Test
          </button>
        </div>
        {connection.state === 'testing' && (
          <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Connecting…</p>
        )}
        {connection.state === 'ok' && (
          <p className="mt-1 text-sm text-[#2BE87D]">
            Connected — {connection.models.length} model{connection.models.length === 1 ? '' : 's'} available
          </p>
        )}
        {connection.state === 'error' && <p className="mt-1 text-sm text-red-500">{connection.message}</p>}
      </div>

      <div>
        <label htmlFor="chat-model" className={labelClass}>
          Chat model
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
        <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Locates elements on screenshots when they are missing from the DOM (used as a fallback).
        </p>
      </div>

      <div className={`border-t pt-6 ${isDarkMode ? 'border-[#1F7A4A]/40' : 'border-gray-200'}`}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            Cloud orchestrator
          </h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={orchestratorEnabled}
              onChange={e => setOrchestratorEnabled(e.target.checked)}
              className="size-4 accent-[#2BE87D]"
            />
            <span className={isDarkMode ? 'text-gray-300' : 'text-gray-700'}>Enabled</span>
          </label>
        </div>
        <p className={`mb-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          A cloud navigator judges each step&apos;s outcome and decides the next one; local models still do the
          clicking, typing, and bulk reading. PRIVACY: the navigator model receives a SCREENSHOT of the active tab
          every step — including whatever is visible in your logged-in sessions. All cloud calls request
          no-data-retention routing (providers that neither train on nor store prompts), but the images do leave your
          machine. Without an API key the agent runs fully local and screenshots never leave.
        </p>

        <div className="space-y-4">
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
                      ? 'border-[#2BE87D] text-[#2BE87D]'
                      : isDarkMode
                        ? 'border-[#1F7A4A]/50 text-gray-400 hover:text-gray-200'
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
                      ? 'border-[#2BE87D] text-[#2BE87D]'
                      : isDarkMode
                        ? 'border-[#1F7A4A]/50 text-gray-400 hover:text-gray-200'
                        : 'border-gray-300 text-gray-500 hover:text-gray-700'
                  }`}>
                  {preset.label}
                </button>
              ))}
            </div>
            <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              This is the model that sees screenshots. Leave empty to use the orchestrator model (it must then be
              multimodal).
            </p>
          </div>

        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-[#2BE87D] px-4 py-2 text-sm font-medium text-[#06130C] transition-colors hover:bg-[#59F09C]">
          Save
        </button>
        {saved && <span className="text-sm text-[#2BE87D]">Saved</span>}
      </div>
    </section>
  );
};
