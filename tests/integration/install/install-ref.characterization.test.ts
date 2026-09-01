/**
 * Pins the install-ref grammar indirectly through the public
 * `RegistryProvider.search()` seam. Each search hit's `installRef` is built
 * from the registry bundle's source and ref.
 *
 * Registry-provided refs are constrained to fetch-based source kinds:
 *   npm    -> `npm:<ref>`
 *   local  -> `file:<ref>`
 *   github -> `github:<ref>`
 *   git    -> omitted (operators may still add a trusted Git URL directly)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveRegistryProviderFactory } from "../../../src/registry/factory";
import type { RegistryProvider } from "../../../src/registry/providers/types";
import { buildInstallRef } from "../../../src/registry/resolve";
import { type Cleanup, sandboxXdgCacheHome } from "../../_helpers/sandbox";

// Trigger self-registration of the static-index provider.
import "../../../src/registry/providers/static-index";

// ── Fixture: one stash per install-source kind ───────────────────────────────
// Each stash shares the token "pinme" so a single search() returns all four.

const FIXTURE_INDEX = {
  version: 3,
  updatedAt: "2026-04-25T00:00:00Z",
  stashes: [
    {
      id: "npm:pinme-pkg",
      name: "pinme-npm",
      description: "pinme",
      ref: "pinme-pkg",
      source: "npm",
      tags: ["pinme"],
    },
    {
      id: "git:pinme-git",
      name: "pinme-git",
      description: "pinme",
      ref: "https://example.com/pinme.git",
      source: "git",
      tags: ["pinme"],
    },
    {
      id: "local:pinme-local",
      name: "pinme-local",
      description: "pinme",
      ref: "/abs/path/to/pinme",
      source: "local",
      tags: ["pinme"],
    },
    {
      id: "github:owner/pinme",
      name: "pinme-github",
      description: "pinme",
      ref: "owner/pinme",
      source: "github",
      tags: ["pinme"],
    },
  ],
};

const servers: Array<{ stop: (force: boolean) => void }> = [];

function serveJson(body: unknown): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}/index.json`,
    close: () => server.stop(true),
  };
}

function makeProvider(url: string, name = "official"): RegistryProvider {
  const factory = resolveRegistryProviderFactory("static-index");
  if (!factory) throw new Error("static-index provider not registered");
  return factory({ url, name });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = cacheResult.cleanup;
});

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* already stopped */
    }
  }
  servers.length = 0;
  envCleanup();
  envCleanup = () => {};
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildInstallRef behavior contract (via RegistryProvider.search installRef)", () => {
  async function installRefFor(id: string): Promise<string | undefined> {
    const srv = serveJson(FIXTURE_INDEX);
    const provider = makeProvider(srv.url);
    const result = await provider.search({ query: "pinme", limit: 10 });
    return result.hits.find((h) => h.id === id)?.installRef;
  }

  test('source "npm" -> "npm:<ref>"', async () => {
    expect(await installRefFor("npm:pinme-pkg")).toBe("npm:pinme-pkg");
  });

  test('registry source "git" is omitted while direct operator Git remains available', async () => {
    expect(await installRefFor("git:pinme-git")).toBeUndefined();
    expect(buildInstallRef("git", "https://example.com/pinme.git")).toBe("git+https://example.com/pinme.git");
  });

  test('source "local" -> "file:<ref>"', async () => {
    expect(await installRefFor("local:pinme-local")).toBe("file:/abs/path/to/pinme");
  });

  test('source "github" -> "github:<ref>"', async () => {
    expect(await installRefFor("github:owner/pinme")).toBe("github:owner/pinme");
  });

  test("safe registry source kinds resolve and an ignored Git source emits a warning", async () => {
    const srv = serveJson(FIXTURE_INDEX);
    const provider = makeProvider(srv.url);
    const result = await provider.search({ query: "pinme", limit: 10 });
    const refs = Object.fromEntries(result.hits.map((h) => [h.source, h.installRef]));
    expect(refs).toEqual({
      npm: "npm:pinme-pkg",
      local: "file:/abs/path/to/pinme",
      github: "github:owner/pinme",
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("ignored git:pinme-git because registry-provided git transport refs are not installable"),
    ]);
  });
});
