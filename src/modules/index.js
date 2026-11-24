import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * Add new modules here so ModuleManager registers them automatically on boot.
 */
export const REGISTERED_MODULES = [
  aiConsoleModule,
];
