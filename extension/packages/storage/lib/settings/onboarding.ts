import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Whether the first-run onboarding tour has been completed (or dismissed).
// The side panel shows the tour automatically while this is false; after
// that it is only reachable from the "?" header button.
export type OnboardingStorage = BaseStorage<boolean> & {
  markSeen: () => Promise<void>;
};

const storage = createStorage<boolean>('onboarding-seen', false);

export const onboardingStore: OnboardingStorage = {
  ...storage,
  markSeen: async () => {
    await storage.set(true);
  },
};
