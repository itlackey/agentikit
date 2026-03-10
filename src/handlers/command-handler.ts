import type { AssetTypeHandler, ShowInput } from "../asset-type-handler";
import { getRenderer } from "../file-context";
import type { ShowResponse } from "../stash-types";
import { showInputToRenderContext } from "./handler-bridge";
import { isMarkdownFile, markdownAssetPath, markdownCanonicalName } from "./markdown-helpers";

export const commandHandler: AssetTypeHandler = {
  typeName: "command",
  stashDir: "commands",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("command-md")!;
    const ctx = showInputToRenderContext(input, "command-md");
    return renderer.buildShowResponse(ctx);
  },

  defaultUsageGuide: [
    "Read the .md file, fill $ARGUMENTS placeholders, and run it in the current repo context.",
    "Use `akm show <openRef>` to retrieve the command template body.",
    "When `agent` is specified, dispatch the command to that agent.",
  ],
};
