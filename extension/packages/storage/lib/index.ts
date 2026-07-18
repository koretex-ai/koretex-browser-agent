export type { BaseStorage } from './base/types';
export * from './settings';
export * from './chat';
export * from './trajectory';
export * from './recipes';
export * from './skills';
export * from './schedules';
export * from './runstate';
export * from './prompt/favorites';

// Re-export the favorites instance for direct use
export { default as favoritesStorage } from './prompt/favorites';
