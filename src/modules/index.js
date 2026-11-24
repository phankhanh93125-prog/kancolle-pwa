import frameworkLabModule from './framework-lab.js';
import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * The first module in the list is mounted as the default home page on fresh load.
 */
export const REGISTERED_MODULES = [
  frameworkLabModule,
  aiConsoleModule,
];
