import characterConsoleModule from './character-console.js';
import actionConsoleModule from './action-console.js';
import frameworkLabModule from './framework-lab.js';
import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * The first module in the list is mounted as the default home page unless the user pins another default.
 */
export const REGISTERED_MODULES = [
  characterConsoleModule,
  actionConsoleModule,
  frameworkLabModule,
  aiConsoleModule,
];
