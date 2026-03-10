import { registerAssetType } from "../asset-type-handler";
import { agentHandler } from "./agent-handler";
import { commandHandler } from "./command-handler";
import { knowledgeHandler } from "./knowledge-handler";
import { scriptHandler } from "./script-handler";
import { skillHandler } from "./skill-handler";
import { toolHandler } from "./tool-handler";

/**
 * Register all built-in asset type handlers.
 * Called once from ensureHandlersRegistered in asset-type-handler.ts.
 */
export function registerBuiltinHandlers(): void {
  registerAssetType(toolHandler);
  registerAssetType(skillHandler);
  registerAssetType(commandHandler);
  registerAssetType(agentHandler);
  registerAssetType(knowledgeHandler);
  registerAssetType(scriptHandler);
}
