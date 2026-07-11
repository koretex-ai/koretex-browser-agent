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
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>({ state: 'idle' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chatSettingsStore.getSettings().then(settings => {
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
      setGrounderModel(settings.grounderModel);
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
    await chatSettingsStore.updateSettings({ baseUrl: baseUrl.replace(/\/$/, ''), model, grounderModel });
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
