import titleScreenModule from './title-screen.js';
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
import facilitiesHubModule from './facilities-hub.js';
import compendiumStudioModule from './compendium-studio.js';
import actionConsoleModule from './action-console.js';
import frameworkLabModule from './framework-lab.js';
import aiConsoleModule from './ai-console.js';

/**
 * Central pluggable module registry.
 * 5 zero-duplication bottom tabs: port-hub (互动) / character-console (档案) /
 * sortie-console (出征) / supply-workshop (工坊) / port-facilities-hub (设施).
 */
export const REGISTERED_MODULES = [
  portHubModule,
  characterConsoleModule,
  sortieConsoleModule,
  supplyWorkshopModule,
  facilitiesHubModule,
  compendiumStudioModule,
  actionConsoleModule,
  portFormationModule,
  portDormitoryModule,
  portDockyardModule,
  portExpeditionModule,
  titleScreenModule,
  frameworkLabModule,
  aiConsoleModule,
];
