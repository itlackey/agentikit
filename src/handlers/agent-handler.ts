import type { AssetTypeHandler, ShowInput } from "../asset-type-handler";
import { getRenderer } from "../file-context";
import type { ShowResponse } from "../stash-types";
import { showInputToRenderContext } from "./handler-bridge";
import { isMarkdownFile, markdownAssetPath, markdownCanonicalName } from "./markdown-helpers";

export const agentHandler: AssetTypeHandler = {
  typeName: "agent",
  stashDir: "agents",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("agent-md")!;
    const ctx = showInputToRenderContext(input, "agent-md");
    return renderer.buildShowResponse(ctx);
  },

  defaultUsageGuide: [
    "Read the .md file and dispatch an agent using the content of the file. Use modelHint/toolPolicy when present to run the agent with compatible settings.",
    "Use with `akm show <openRef>` to get the full prompt payload.",
  ],
};
