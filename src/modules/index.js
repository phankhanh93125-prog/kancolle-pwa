import portHubModule from './port-hub.js';
import {
  portDormitoryModule,
  portDockyardModule,
  portFormationModule,
  portExpeditionModule,
} from './port-facilities.js';
import sortieConsoleModule from './sortie-console.js';
import characterConsoleModule from './character-console.js';
import supplyWorkshopModule from './supply-workshop.js';
import compendiumStudioModule from './compendium-studio.js';
import actionConsoleModule from './action-console.js';
import frameworkLabModule from './framework-lab.js';
import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * Top-level pages appear in the horizontal nav strip; dedicated full-screen facility pages (`isSubpage: true`)
 * are opened from the Port Hub facility grid and return via their unified `← 返回港区` top bar.
 */
export const REGISTERED_MODULES = [
  portHubModule,
  sortieConsoleModule,
  characterConsoleModule,
  supplyWorkshopModule,
  compendiumStudioModule,
  actionConsoleModule,
  portFormationModule,
  portDormitoryModule,
  portDockyardModule,
  portExpeditionModule,
  frameworkLabModule,
  aiConsoleModule,
];
