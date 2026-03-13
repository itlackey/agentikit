import path from "node:path";
import { toPosix } from "./common";

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
}

const markdownSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => path.extname(fileName).toLowerCase() === ".md",
  toCanonicalName: (typeRoot, filePath) => {
    const rel = toPosix(path.relative(typeRoot, filePath));
    // Strip .md extension from canonical names (agent:code-reviewer, not agent:code-reviewer.md)
    return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  },
  toAssetPath: (typeRoot, name) => {
    // Accept both with and without .md extension
    const withExt = name.endsWith(".md") ? name : `${name}.md`;
    return path.join(typeRoot, withExt);
  },
};

/** All recognized script extensions for the script asset type */
export const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".ts",
  ".js",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".rb",
  ".go",
  ".pl",
  ".php",
  ".lua",
  ".r",
  ".swift",
  ".kt",
  ".kts",
]);

const scriptSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
  toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
};

const ASSET_SPECS_INTERNAL: Record<string, AssetSpec> = {
  skill: {
    stashDir: "skills",
    isRelevantFile: (fileName) => fileName === "SKILL.md",
    toCanonicalName: (typeRoot, filePath) => {
      const relDir = toPosix(path.dirname(path.relative(typeRoot, filePath)));
      if (!relDir || relDir === ".") return undefined;
      return relDir;
    },
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name, "SKILL.md"),
  },
  command: { stashDir: "commands", ...markdownSpec },
  agent: { stashDir: "agents", ...markdownSpec },
  knowledge: { stashDir: "knowledge", ...markdownSpec },
  script: { stashDir: "scripts", ...scriptSpec },
  memory: { stashDir: "memories", ...markdownSpec },
};

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

export function registerAssetType(type: string, spec: AssetSpec): void {
  ASSET_SPECS_INTERNAL[type] = spec;
  TYPE_DIRS[type] = spec.stashDir;
  ASSET_TYPES = getAssetTypes();
}

export function getAssetTypes(): string[] {
  return Object.keys(ASSET_SPECS_INTERNAL);
}

export let ASSET_TYPES: string[] = getAssetTypes();

export const TYPE_DIRS: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_SPECS_INTERNAL).map(([type, spec]) => [type, spec.stashDir]),
);

export function isRelevantAssetFile(assetType: string, fileName: string): boolean {
  return ASSET_SPECS[assetType]?.isRelevantFile(fileName) ?? false;
}

export function deriveCanonicalAssetName(assetType: string, typeRoot: string, filePath: string): string | undefined {
  return ASSET_SPECS[assetType]?.toCanonicalName(typeRoot, filePath);
}

export function deriveCanonicalAssetNameFromStashRoot(
  assetType: string,
  stashRoot: string,
  filePath: string,
): string | undefined {
  const relPath = toPosix(path.relative(stashRoot, filePath));
  const firstSegment = relPath.split("/").filter(Boolean)[0];
  const typeRoot = firstSegment === TYPE_DIRS[assetType] ? path.join(stashRoot, firstSegment) : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function resolveAssetPathFromName(assetType: string, typeRoot: string, name: string): string {
  const spec = ASSET_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}
