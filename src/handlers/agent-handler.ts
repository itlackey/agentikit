import { parseFrontmatter, toStringOrUndefined } from "../frontmatter"
import { isMarkdownFile, markdownCanonicalName, markdownAssetPath } from "./markdown-helpers"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse } from "../stash-types"

export const agentHandler: AssetTypeHandler = {
  typeName: "agent",
  stashDir: "agents",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const parsedMd = parseFrontmatter(input.content)
    return {
      type: "agent",
      name: input.name,
      path: input.path,
      description: toStringOrUndefined(parsedMd.data.description),
      prompt: "Dispatching prompt must include the agent's full prompt content verbatim; summaries are non-compliant. \n\n"
        + parsedMd.content,
      toolPolicy: parsedMd.data.tools,
      modelHint: parsedMd.data.model,
    }
  },

  defaultUsageGuide: [
    "Read the .md file and dispatch and agent using the content of the file. Use modelHint/toolPolicy when present to run the agent with compatible settings.",
    "Use with `akm show <openRef>` to get the full prompt payload.",
  ],
}
