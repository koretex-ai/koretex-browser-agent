/**
 * User-defined SKILLS (site playbooks): the same shape the agent's built-in
 * playbooks use, kept serializable for chrome.storage and for sharing as
 * plain JSON files. A custom skill whose name matches a built-in playbook
 * REPLACES it — users can correct our lore, not just extend it.
 */

export interface CustomSkillRecord {
  /** Unique name (also the override key against built-ins), e.g. "notion" */
  name: string;
  /** Host/path substrings that trigger the skill when the tab matches, e.g. "notion.so" */
  hosts: string[];
  /**
   * Optional regex source (case-insensitive) matched against the task
   * objective — lets the skill fire before the site is even open.
   */
  intent?: string;
  /** The playbook text pinned into the navigator's prompt when triggered */
  guidance: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillStorage {
  getAll: () => Promise<CustomSkillRecord[]>;
  /** Insert or update by name */
  upsert: (record: Omit<CustomSkillRecord, 'createdAt' | 'updatedAt'>) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** Replace the whole set (used by import) */
  replaceAll: (records: CustomSkillRecord[]) => Promise<void>;
}
