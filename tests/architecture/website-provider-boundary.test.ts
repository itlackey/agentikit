// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #744 — website provider boundary.
 *
 * The website provider registry must be safe to import from the future
 * provider-aware core source-entry leaf. Before #744, the provider imported
 * website-ingest, which imported the snapshot-fetcher registry and X fetcher.
 * Adding the future X -> secret-reader -> source-entries -> providers/index
 * edges therefore produced the seven-participant latent P3 cycle measured in
 * docs/architecture/reviews/env-secret-access.md §8.
 *
 * The runtime half of the seam is equally important: removing the static edge
 * must not remove website refresh. The provider's sync() delegates to the
 * injected mirror capability while preserving force/private-host/secret
 * plumbing.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { buildImportGraph } from "../../scripts/lint-import-cycles";
import type { EnsureWebsiteMirror, WebsiteMirrorOptions } from "../../src/sources/provider";
import { resolveSourceProviderFactory } from "../../src/sources/provider-factory";
import "../../src/sources/providers/website";
import * as websiteIngest from "../../src/sources/snapshot-fetchers/website-ingest";

const PROVIDERS_INDEX = "src/sources/providers/index.ts";
const WEBSITE_PROVIDER = "src/sources/providers/website.ts";
const WEBSITE_INGEST = "src/sources/snapshot-fetchers/website-ingest.ts";
const X_FETCHER = "src/sources/snapshot-fetchers/x.ts";
const VIRTUAL_SECRET_READER = "src/core/__p3-env-secret-read.ts";
const VIRTUAL_SOURCE_ENTRIES = "src/core/__p3-source-entries.ts";

function reaches(graph: Map<string, Set<string>>, start: string, target: string): boolean {
  const pending = [...(graph.get(start) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

function cycleParticipants(graph: Map<string, Set<string>>): string[] {
  return [...graph.keys()].filter((node) => reaches(graph, node, node)).sort();
}

describe("website provider import boundary", () => {
  test("the simulated P3 core-leaf registration edge has zero cycle participants", () => {
    const graph = buildImportGraph();

    // Simulate only the deferred P3 edges documented in §8. The production
    // graph remains untouched; this probe asks whether providers/index can be
    // imported by that future core leaf without closing a cycle through X.
    graph.set(VIRTUAL_SECRET_READER, new Set([VIRTUAL_SOURCE_ENTRIES]));
    graph.set(VIRTUAL_SOURCE_ENTRIES, new Set([PROVIDERS_INDEX]));
    const xFetcherEdges = graph.get(X_FETCHER);
    expect(xFetcherEdges).toBeDefined();
    xFetcherEdges?.add(VIRTUAL_SECRET_READER);

    expect(cycleParticipants(graph)).toEqual([]);
    expect(graph.get(WEBSITE_PROVIDER)).not.toContain(WEBSITE_INGEST);
  });

  test("sync delegates mirror refresh through the injected capability", async () => {
    const staticMirrorSpy = spyOn(websiteIngest, "ensureWebsiteMirror").mockResolvedValue({
      rootDir: "/tmp/static-root",
      stashDir: "/tmp/static-stash",
      manifestPath: "/tmp/static-manifest.json",
    });
    const calls: Array<{ config: unknown; options: WebsiteMirrorOptions | undefined }> = [];
    const injectedMirror: EnsureWebsiteMirror = async (config, options) => {
      calls.push({ config, options });
      return {
        rootDir: "/tmp/injected-root",
        stashDir: "/tmp/injected-stash",
        manifestPath: "/tmp/injected-manifest.json",
      };
    };
    const secrets = { resolveSecret: () => "test-token" };
    const config = {
      type: "website",
      name: "docs",
      url: "http://127.0.0.1:9/docs",
    } as never;

    try {
      const provider = resolveSourceProviderFactory("website")?.(config);
      await provider?.sync?.({
        force: true,
        secrets,
        ensureWebsiteMirror: injectedMirror,
      });

      expect(staticMirrorSpy).toHaveBeenCalledTimes(0);
      expect(calls).toEqual([
        {
          config,
          options: {
            requireStashDir: true,
            force: true,
            resolveSecret: secrets.resolveSecret,
            allowPrivateHosts: true,
          },
        },
      ]);
    } finally {
      staticMirrorSpy.mockRestore();
    }
  });

  test("sync fails explicitly when its mirror capability was not composed", async () => {
    const config = {
      type: "website",
      name: "docs",
      url: "http://127.0.0.1:9/docs",
    } as never;
    const provider = resolveSourceProviderFactory("website")?.(config);

    await expect(provider?.sync?.({ force: true })).rejects.toThrow(
      "Website provider sync requires an injected ensureWebsiteMirror capability",
    );
  });
});
