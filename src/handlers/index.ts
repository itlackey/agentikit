import { registerAssetType } from "../asset-type-handler"
import { toolHandler } from "./tool-handler"
import { skillHandler } from "./skill-handler"
import { commandHandler } from "./command-handler"
import { agentHandler } from "./agent-handler"
import { knowledgeHandler } from "./knowledge-handler"
import { scriptHandler } from "./script-handler"

/**
 * Register all built-in asset type handlers.
 * This must be called (imported) before any handler lookups.
 */
registerAssetType(toolHandler)
registerAssetType(skillHandler)
registerAssetType(commandHandler)
registerAssetType(agentHandler)
registerAssetType(knowledgeHandler)
registerAssetType(scriptHandler)

export { toolHandler } from "./tool-handler"
export { skillHandler } from "./skill-handler"
export { commandHandler } from "./command-handler"
export { agentHandler } from "./agent-handler"
export { knowledgeHandler } from "./knowledge-handler"
export { scriptHandler } from "./script-handler"
