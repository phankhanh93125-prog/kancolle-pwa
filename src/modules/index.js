import portHubModule from './port-hub.js';
import sortieConsoleModule from './sortie-console.js';
import characterConsoleModule from './character-console.js';
import supplyWorkshopModule from './supply-workshop.js';
import actionConsoleModule from './action-console.js';
import frameworkLabModule from './framework-lab.js';
import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * The first module (port-hub) is mounted as the default home page unless the user pins another default.
 */
export const REGISTERED_MODULES = [
  portHubModule,
  sortieConsoleModule,
  characterConsoleModule,
  supplyWorkshopModule,
  actionConsoleModule,
  frameworkLabModule,
  aiConsoleModule,
];
