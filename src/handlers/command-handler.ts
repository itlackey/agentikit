import { parseFrontmatter, toStringOrUndefined } from "../frontmatter"
import { isMarkdownFile, markdownCanonicalName, markdownAssetPath } from "./markdown-helpers"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse } from "../stash-types"

export const commandHandler: AssetTypeHandler = {
  typeName: "command",
  stashDir: "commands",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const parsedMd = parseFrontmatter(input.content)
    return {
      type: "command",
      name: input.name,
      path: input.path,
      description: toStringOrUndefined(parsedMd.data.description),
      template: parsedMd.content,
    }
  },

  defaultUsageGuide: [
    "Read the .md file, fill placeholders, and run it in the current repo context.",
    "Use `akm show <openRef>` to retrieve the command template body.",
  ],
}
