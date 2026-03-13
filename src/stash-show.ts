import { fetchWithRetry } from "./common";
import { loadConfig, type RegistryConfigEntry } from "./config";
import { NotFoundError, UsageError } from "./errors";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";
import { resolveSourcesForOrigin } from "./origin-resolve";
import { parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import { buildEditHint, findSourceForPath, isEditable, resolveStashSources } from "./stash-source";
import type { KnowledgeView, ShowResponse } from "./stash-types";

export function isVikingRef(ref: string): boolean {
  return ref.trim().startsWith("viking://");
}

export async function agentikitShowRemote(input: { ref: string }): Promise<ShowResponse> {
  const uri = input.ref.trim();
  const config = loadConfig();
  const baseUrl = resolveOVBaseUrl(config.registries);
  if (!baseUrl) {
    throw new UsageError(
      "No OpenViking registry configured. Run: akm registry add http://localhost:1933 --name openviking --provider openviking",
    );
  }

  const headers: Record<string, string> = {};
  const ovRegistry = config.registries?.find((r) => r.provider === "openviking");
  const apiKey = (ovRegistry?.options?.apiKey as string) ?? undefined;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Fetch metadata and content in parallel
  const [statResult, contentResult] = await Promise.all([
    fetchOVJson(`${baseUrl}/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`, headers),
    fetchOVJson(`${baseUrl}/api/v1/content/read?uri=${encodeURIComponent(uri)}&offset=0&limit=-1`, headers),
  ]);

  const stat = (typeof statResult === "object" && statResult !== null ? statResult : {}) as Record<string, unknown>;
  const uriPath = uri.replace(/^viking:\/\//, "");
  const name = (stat.name as string) ?? uriPath.split("/").pop() ?? "unknown";
  const ovType = (stat.type as string) ?? inferTypeFromUri(uri);
  const assetType = mapOVType(ovType);
  // content/read returns result as a raw string
  const content = typeof contentResult === "string" ? contentResult : "";

  return {
    type: assetType,
    name,
    path: uri,
    action: `Remote content from OpenViking — ${uri}`,
    content,
    description: (stat.abstract as string) ?? undefined,
    editable: false,
  };
}

function resolveOVBaseUrl(registries?: RegistryConfigEntry[]): string | undefined {
  const entry = registries?.find((r) => r.provider === "openviking" && r.enabled !== false);
  return entry?.url?.replace(/\/+$/, "");
}

async function fetchOVJson(url: string, headers: Record<string, string>): Promise<unknown> {
  try {
    const response = await fetchWithRetry(url, { headers }, { timeout: 10_000, retries: 1 });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    if (data.status !== "ok") return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

function inferTypeFromUri(uri: string): string {
  const path = uri.replace(/^viking:\/\//, "");
  const firstSegment = path.split("/")[0];
  const typeMap: Record<string, string> = {
    memories: "memory",
    skills: "skill",
    resources: "knowledge",
    agents: "agent",
    commands: "command",
    scripts: "script",
    knowledge: "knowledge",
  };
  return typeMap[firstSegment] ?? "knowledge";
}

function mapOVType(ovType: string): string {
  const map: Record<string, string> = {
    memory: "memory",
    memories: "memory",
    skill: "skill",
    skills: "skill",
    resource: "knowledge",
    resources: "knowledge",
    knowledge: "knowledge",
    agent: "agent",
    agents: "agent",
    command: "command",
    commands: "command",
    script: "script",
    scripts: "script",
  };
  return map[ovType] ?? "knowledge";
}

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref);
  const displayType = parsed.type;
  const config = loadConfig();
  const allSources = resolveStashSources();
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allStashDirs = searchSources.map((s) => s.path);

  let assetPath: string | undefined;
  let lastError: Error | undefined;
  for (const dir of allStashDirs) {
    try {
      assetPath = resolveAssetPath(dir, parsed.type, parsed.name);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw lastError ?? new NotFoundError(`Stash asset not found for ref: ${displayType}:${parsed.name}`);
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allStashDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(`Could not determine stash root for asset: ${displayType}:${parsed.name}`);
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const match = runMatchers(fileCtx);
  if (!match) {
    throw new UsageError(
      `Could not display asset "${displayType}:${parsed.name}" — unsupported file type or unrecognized layout`,
    );
  }

  match.meta = { ...match.meta, name: parsed.name, view: input.view };
  const renderer = getRenderer(match.renderer);
  if (!renderer) {
    throw new UsageError(`Renderer "${match.renderer}" not found for asset: ${displayType}:${parsed.name}`);
  }

  const renderCtx = buildRenderContext(fileCtx, match, allStashDirs);
  const response = renderer.buildShowResponse(renderCtx);
  const editable = isEditable(assetPath, config);
  return {
    ...response,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  };
}
