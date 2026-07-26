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
  /** Vision verifier model (screenshot + question -> yes/no verdict) */
  verifierModel: string;
  /** Hybrid mode: strong cloud model plans/decomposes/validates; local models execute */
  orchestratorEnabled: boolean;
  /** OpenAI-compatible endpoint base URL (e.g. https://openrouter.ai/api/v1) */
  orchestratorBaseUrl: string;
  orchestratorApiKey: string;
  orchestratorModel: string;
  /**
   * Multimodal judge-and-decide model for the stepwise engine (sees a
   * screenshot every step). Empty = fall back to orchestratorModel.
   * NOTE: using this sends page screenshots to the remote provider — the
   * orchestrator requests no-data-retention routing, but it is still remote.
   */
  navigatorModel: string;
  /**
   * Cloud-only mode: run the reader and grounder via the orchestrator
   * endpoint too — no Ollama or local models required. Full page text then
   * leaves the machine for extract/harvest steps (same no-retention routing).
   */
  cloudOnly: boolean;
  /** Text model for cloud page reading; empty = orchestratorModel */
  cloudReaderModel: string;
  /**
   * Model for the STRATEGIC tier — kickoff interpretation and strategic
   * reviews, the calls where deep reasoning beats speed (live 2026-07-21:
   * the cheap navigator stated the winning per-item plan and never executed
   * it; reviews fixated on a single-source constraint the objective never
   * had). Empty = orchestratorModel. The per-step navigator stays on
   * navigatorModel. If this model is text-only, review screenshots are
   * dropped automatically on retry.
   */
  strategistModel: string;
  /**
   * PII guard (cloud-only mode): detectable identifiers (emails, phone
   * numbers, card numbers, SSNs) in outgoing TEXT are replaced with stable
   * tokens; the real values stay in a local vault and are substituted back
   * at typing time. Screenshots are not covered by this layer.
   */
  piiGuard: boolean;
  /**
   * Comma-separated host/path fragments that require the user's explicit
   * go-ahead before the agent works there (screenshots of such pages would
   * go to the cloud model).
   */
  sensitiveSites: string;
  /**
   * What a run does when it hits a human-verification wall (CAPTCHA,
   * Cloudflare challenge). The agent NEVER solves one itself — that is
   * enforced in code, not by this setting. 'wait' (default): pause on the
   * challenge page, surface the agent window, and auto-resume once the user
   * clears it. 'stop': give up on that route immediately and report.
   */
  captchaBehavior: 'wait' | 'stop';
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
  // Dedicated VQA model for step verification: Holo is a grounding specialist,
  // not a yes/no judge. 3B keeps all three local models resident on 18GB.
  verifierModel: 'qwen2.5vl:3b',
  orchestratorEnabled: true,
  orchestratorBaseUrl: 'https://openrouter.ai/api/v1',
  orchestratorApiKey: '',
  orchestratorModel: 'z-ai/glm-5.2',
  // User decision 2026-07-22: strongest OPEN-WEIGHTS multimodal model as the
  // per-step navigator — judgment quality saves steps and wall-clock, and
  // cost is not the constraint (no OpenAI/Anthropic models by policy;
  // GLM 5.2 is text-only so it cannot judge screenshots — its vision
  // sibling is z-ai/glm-4.6v). Budget alternate: xiaomi/mimo-v2.5
  // ($0.14/$0.28 per 1M, the 2026-07-15 pick, most-validated in the stack).
  navigatorModel: 'qwen/qwen3.5-122b-a10b',
  // Cloud-only by default (user decision 2026-07-20): a fresh install works
  // with just an API key — no Ollama required. Local hybrid is opt-in.
  cloudOnly: true,
  // Same model as the navigator: cheapest serious option for input-heavy
  // page reading, and already the most-validated model in the stack
  cloudReaderModel: 'xiaomi/mimo-v2.5',
  piiGuard: true,
  // Empty = orchestratorModel (GLM 5.2 by default): the strategic tier runs
  // on the strongest configured reasoning model, per the user's standing
  // decision (2026-07-21) to spend model quality generously where reasoning
  // failed, while the cheap multimodal navigator keeps the per-step load
  strategistModel: '',
  sensitiveSites:
    'bank, banking, paypal, venmo, wise.com, health, medical, clinic, insurance, medicare, centrelink, .gov, ato., irs.',
  captchaBehavior: 'wait',
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
