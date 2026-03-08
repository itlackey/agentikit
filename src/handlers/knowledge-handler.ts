import fs from "node:fs"
import { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "../markdown"
import { isMarkdownFile, markdownCanonicalName, markdownAssetPath } from "./markdown-helpers"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse } from "../stash-types"
import type { StashEntry } from "../metadata"

export const knowledgeHandler: AssetTypeHandler = {
  typeName: "knowledge",
  stashDir: "knowledge",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const v = input.view ?? { mode: "full" }
    switch (v.mode) {
      case "toc": {
        const toc = parseMarkdownToc(input.content)
        return { type: "knowledge", name: input.name, path: input.path, content: formatToc(toc) }
      }
      case "frontmatter": {
        const fm = extractFrontmatterOnly(input.content)
        return { type: "knowledge", name: input.name, path: input.path, content: fm ?? "(no frontmatter)" }
      }
      case "section": {
        const section = extractSection(input.content, v.heading)
        if (!section) {
          return {
            type: "knowledge",
            name: input.name,
            path: input.path,
            content: `Section "${v.heading}" not found in ${input.name}. Try --view toc to discover available headings.`,
          }
        }
        return { type: "knowledge", name: input.name, path: input.path, content: section.content }
      }
      case "lines": {
        return { type: "knowledge", name: input.name, path: input.path, content: extractLineRange(input.content, v.start, v.end) }
      }
      default: {
        return { type: "knowledge", name: input.name, path: input.path, content: input.content }
      }
    }
  },

  defaultUsageGuide: [
    "Use `akm show <openRef>` to read the document; start with `--view toc` for large files.",
    "Use `--view section` or `--view lines` to load only the part you need.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string): void {
    try {
      const mdContent = fs.readFileSync(file, "utf8")
      const toc = parseMarkdownToc(mdContent)
      if (toc.headings.length > 0) entry.toc = toc.headings
    } catch {
      // Non-fatal: skip TOC if file can't be read
    }
  },
}
