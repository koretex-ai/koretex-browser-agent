import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { CustomSkillRecord, SkillStorage } from './types';

const skillsStorage = createStorage<CustomSkillRecord[]>('customSkills', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

export const skillStore: SkillStorage = {
  getAll: async () => skillsStorage.get(),

  upsert: async record => {
    await skillsStorage.set(prev => {
      const now = Date.now();
      const existing = prev.find(skill => skill.name === record.name);
      if (!existing) return [...prev, { ...record, createdAt: now, updatedAt: now }];
      return prev.map(skill =>
        skill === existing ? { ...record, createdAt: existing.createdAt, updatedAt: now } : skill,
      );
    });
  },

  remove: async name => {
    await skillsStorage.set(prev => prev.filter(skill => skill.name !== name));
  },

  replaceAll: async records => {
    await skillsStorage.set(records);
  },
};
