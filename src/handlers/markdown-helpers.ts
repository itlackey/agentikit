import path from "node:path";
import { toPosix } from "../common";

/**
 * Shared file-system helpers for markdown-based asset types
 * (command, agent, knowledge).
 */

export function isMarkdownFile(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === ".md";
}

export function markdownCanonicalName(typeRoot: string, filePath: string): string | undefined {
  return toPosix(path.relative(typeRoot, filePath));
}

export function markdownAssetPath(typeRoot: string, name: string): string {
  return path.join(typeRoot, name);
}
