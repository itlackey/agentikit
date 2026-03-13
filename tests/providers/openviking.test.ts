import { afterAll, describe, expect, test } from "bun:test";
import { resolveProviderFactory } from "../../src/provider-registry";

// Trigger self-registration
import "../../src/providers/openviking";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_RESPONSE = {
  status: "ok",
  result: [
    { uri: "viking://memories/project-context", name: "project-context", score: 0.95, type: "memories" },
    { uri: "viking://skills/code-review", name: "code-review", score: 0.88, type: "skills" },
    { uri: "viking://resources/api-docs", name: "api-docs", score: 0.72, type: "resources" },
  ],
  time: 0.042,
};

const EMPTY_RESPONSE = { status: "ok", result: [], time: 0.001 };
const ERROR_RESPONSE = { status: "error", error: "Something went wrong" };

// ── Helpers ─────────────────────────────────────────────────────────────────

const servers: Array<{ stop: (force: boolean) => void }> = [];

function serveJson(body: unknown, statusCode = 200): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

function getFactory() {
  const factory = resolveProviderFactory("openviking");
  expect(factory).toBeTruthy();
  // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
  return factory!;
}

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* ignore */
    }
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OpenVikingProvider", () => {
  test("self-registers as 'openviking'", () => {
    const factory = resolveProviderFactory("openviking");
    expect(factory).toBeTruthy();
  });

  test("creates a provider with the correct type", () => {
    const factory = getFactory();
    const provider = factory({ url: "http://localhost:1933" });
    expect(provider.type).toBe("openviking");
  });

  test("returns results as asset hits, not installable kit hits", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ url, name: "test-ov" });
      const result = await provider.search({ query: "project context", limit: 10 });

      // OV results are not installable, so hits must be empty
      expect(result.hits).toHaveLength(0);
      expect(result.warnings).toBeUndefined();

      // Results appear as asset hits instead
      const assetHits = result.assetHits ?? [];
      expect(assetHits).toHaveLength(3);

      const first = assetHits[0];
      expect(first.kit.id).toBe("openviking:viking://memories/project-context");
      expect(first.assetName).toBe("project-context");
      expect(first.action).toBe("akm show viking://memories/project-context");
      expect(first.registryName).toBe("test-ov");
      expect(first.score).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  test("returns asset hits with correct asset types", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ url, name: "test-ov" });
      const result = await provider.search({ query: "context", limit: 10 });

      const assetHits = result.assetHits ?? [];
      expect(assetHits).toHaveLength(3);

      const memoryHit = assetHits.find((h) => h.assetName === "project-context");
      expect(memoryHit).toBeDefined();
      expect(memoryHit?.assetType).toBe("memory");

      const skillHit = assetHits.find((h) => h.assetName === "code-review");
      expect(skillHit).toBeDefined();
      expect(skillHit?.assetType).toBe("skill");

      const resourceHit = assetHits.find((h) => h.assetName === "api-docs");
      expect(resourceHit).toBeDefined();
      expect(resourceHit?.assetType).toBe("knowledge");
    } finally {
      close();
    }
  });

  test("returns empty hits for empty response", async () => {
    const { url, close } = serveJson(EMPTY_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ url });
      const result = await provider.search({ query: "nothing", limit: 10 });

      expect(result.hits).toHaveLength(0);
    } finally {
      close();
    }
  });

  test("returns warning on error response", async () => {
    const { url, close } = serveJson(ERROR_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ url, name: "bad-ov" });
      const result = await provider.search({ query: "test", limit: 10 });

      expect(result.hits).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("bad-ov");
    } finally {
      close();
    }
  });

  test("returns warning on HTTP error", async () => {
    const { url, close } = serveJson({ error: "not found" }, 404);
    try {
      const factory = getFactory();
      const provider = factory({ url, name: "error-ov" });
      const result = await provider.search({ query: "test", limit: 10 });

      expect(result.hits).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("error-ov");
    } finally {
      close();
    }
  });

  test("returns warning when server is unreachable", async () => {
    const factory = getFactory();
    const provider = factory({ url: "http://127.0.0.1:19339", name: "offline-ov" });
    const result = await provider.search({ query: "test", limit: 5 });

    expect(result.hits).toHaveLength(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]).toContain("offline-ov");
  });

  test("respects limit", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ url });
      const result = await provider.search({ query: "test", limit: 2 });

      expect(result.hits).toHaveLength(0);
      const assetHits = result.assetHits ?? [];
      expect(assetHits.length).toBeLessThanOrEqual(2);
    } finally {
      close();
    }
  });

  test("uses text search when searchType is 'text'", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        return new Response(JSON.stringify(FIXTURE_RESPONSE), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({
        url: `http://localhost:${server.port}`,
        options: { searchType: "text" },
      });
      await provider.search({ query: "test", limit: 10 });

      expect(capturedPath).toBe("/api/v1/search/grep");
    } finally {
      server.stop(true);
    }
  });

  test("uses semantic search by default", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        return new Response(JSON.stringify(FIXTURE_RESPONSE), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ url: `http://localhost:${server.port}` });
      await provider.search({ query: "test", limit: 10 });

      expect(capturedPath).toBe("/api/v1/search/find");
    } finally {
      server.stop(true);
    }
  });
});
