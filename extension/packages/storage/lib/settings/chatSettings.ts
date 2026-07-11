import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Settings for the local models served by Ollama plus the optional cloud
// orchestrator (any OpenAI-compatible endpoint; defaults to OpenRouter)
export interface ChatSettingsConfig {
  baseUrl: string;
  /** Planner/chat model (text) */
  model: string;
  /** Vision grounder model (screenshot -> click coordinates) */
  grounderModel: string;
  /** Hybrid mode: strong cloud model plans/decomposes/validates; local models execute */
  orchestratorEnabled: boolean;
  /** OpenAI-compatible endpoint base URL (e.g. https://openrouter.ai/api/v1) */
  orchestratorBaseUrl: string;
  orchestratorApiKey: string;
  orchestratorModel: string;
}

export type ChatSettingsStorage = BaseStorage<ChatSettingsConfig> & {
  updateSettings: (settings: Partial<ChatSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<ChatSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettingsConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
  grounderModel: 'hf.co/mradermacher/Holo1.5-3B-GGUF:Q4_K_M',
  orchestratorEnabled: true,
  orchestratorBaseUrl: 'https://openrouter.ai/api/v1',
  orchestratorApiKey: '',
  orchestratorModel: 'z-ai/glm-5.2',
};

const storage = createStorage<ChatSettingsConfig>('chat-settings', DEFAULT_CHAT_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const chatSettingsStore: ChatSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<ChatSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_CHAT_SETTINGS;
    await storage.set({
      ...currentSettings,
      ...settings,
    });
  },
  async getSettings() {
    const settings = await storage.get();
    return {
      ...DEFAULT_CHAT_SETTINGS,
      ...settings,
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_CHAT_SETTINGS);
  },
};
