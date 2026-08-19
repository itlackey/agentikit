// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { searchRegistry } from "../../src/commands/read/registry-search";
import { classifyNetworkAddress } from "../../src/core/network-policy";
import {
  _registryRetryDelayForTests,
  fetchRegistryResponse,
  type RegistryHostnameResolver,
  RegistryNetworkError,
} from "../../src/registry/network";
import { buildInstallRef, npmArtifactNetworkPolicy } from "../../src/registry/resolve";
import { loadSetupStashes } from "../../src/setup/registry-stash-loader";
import { downloadArchive } from "../../src/sources/providers/provider-utils";
import { withEnv, withMockedFetch } from "../_helpers/sandbox";

function resolverFor(records: Record<string, string[]>): RegistryHostnameResolver {
  return async (hostname) => records[hostname] ?? [];
}

const PUBLIC_POLICY = { kind: "public-registry" } as const;

describe("registry outbound request boundary", () => {
  test.each([
    "http://localhost/index.json",
    "http://127.0.0.1/index.json",
    "http://10.0.0.1/index.json",
    "http://172.16.0.1/index.json",
    "http://192.168.1.1/index.json",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://[::1]/index.json",
    "http://[fd00::1]/index.json",
    "http://[fe80::1]/index.json",
  ])("rejects a direct forbidden destination: %s", async (url) => {
    await expect(
      fetchRegistryResponse(url, undefined, {
        policy: PUBLIC_POLICY,
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname: resolverFor({}),
      }),
    ).rejects.toBeInstanceOf(RegistryNetworkError);
  });

  test("rejects a public-looking hostname when DNS resolves to a private address", async () => {
    await expect(
      fetchRegistryResponse("https://registry.example/index.json", undefined, {
        policy: PUBLIC_POLICY,
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname: resolverFor({ "registry.example": ["93.184.216.34", "10.0.0.8"] }),
      }),
    ).rejects.toThrow(/resolves to non-public/i);
  });

  test("re-resolves and revalidates before every retry", async () => {
    let resolverCalls = 0;
    let fetchCalls = 0;

    await expect(
      withMockedFetch(
        () =>
          fetchRegistryResponse("https://registry.example/index.json", undefined, {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 1,
            resolveHostname: async () => {
              resolverCalls += 1;
              return resolverCalls === 1 ? ["93.184.216.34"] : ["10.0.0.8"];
            },
          }),
        () => {
          fetchCalls += 1;
          if (fetchCalls === 1) throw new Error("transient network failure");
          return new Response("ok");
        },
      ),
    ).rejects.toThrow(/non-public/i);

    expect(resolverCalls).toBe(2);
    expect(fetchCalls).toBe(1);
  });

  test("re-pins each retry to the newly validated DNS answer", async () => {
    const resolved: string[] = [];
    const pinned: string[] = [];
    const addresses = ["93.184.216.34", "142.250.191.78"];
    const response = await fetchRegistryResponse("https://registry.example/index.json", undefined, {
      policy: PUBLIC_POLICY,
      timeoutMs: 1_000,
      retries: 1,
      resolveHostname: async () => {
        const address = addresses[resolved.length];
        if (!address) throw new Error("retry fixture exhausted its addresses");
        resolved.push(address);
        return [address];
      },
      requestPinnedForTesting: async (_url, address) => {
        pinned.push(address);
        return pinned.length === 1
          ? new Response("retry", { status: 503, headers: { "Retry-After": "0" } })
          : new Response("ok");
      },
    });
    expect(await response.text()).toBe("ok");
    expect(resolved).toEqual(addresses);
    expect(pinned).toEqual(addresses);
  });

  test("bounds DNS resolution by the per-attempt timeout and never starts transport after expiry", async () => {
    let transportCalls = 0;
    await expect(
      fetchRegistryResponse("https://registry.example/index.json", undefined, {
        policy: PUBLIC_POLICY,
        timeoutMs: 20,
        retries: 0,
        resolveHostname: () => new Promise(() => undefined),
        requestPinnedForTesting: async () => {
          transportCalls += 1;
          return new Response("unexpected");
        },
      }),
    ).rejects.toThrow(/DNS resolution timed out after 20ms/i);
    expect(transportCalls).toBe(0);
  });

  test("does not start transport when a late resolver stalls past the absolute attempt deadline", async () => {
    let transportCalls = 0;
    await expect(
      fetchRegistryResponse("https://registry.example/index.json", undefined, {
        policy: PUBLIC_POLICY,
        timeoutMs: 5,
        retries: 0,
        resolveHostname: async () => {
          const releaseAt = Date.now() + 25;
          while (Date.now() < releaseAt) {
            // Deliberately occupy the event loop so the resolver settles before
            // the overdue timeout callback gets a chance to run.
          }
          return ["93.184.216.34"];
        },
        requestPinnedForTesting: async () => {
          transportCalls += 1;
          return new Response("unexpected");
        },
      }),
    ).rejects.toThrow(/deadline expired before transport/i);
    expect(transportCalls).toBe(0);
  });

  test("aborts a pending DNS resolution without starting transport", async () => {
    const controller = new AbortController();
    let transportCalls = 0;
    const pending = fetchRegistryResponse(
      "https://registry.example/index.json",
      { signal: controller.signal },
      {
        policy: PUBLIC_POLICY,
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname: () => new Promise(() => undefined),
        requestPinnedForTesting: async () => {
          transportCalls += 1;
          return new Response("unexpected");
        },
      },
    );
    controller.abort(new Error("dns-stop"));
    await expect(pending).rejects.toThrow("dns-stop");
    expect(transportCalls).toBe(0);
  });

  test("caps server-controlled retry delays and handles invalid or past values", () => {
    expect(_registryRetryDelayForTests(new Response(null, { headers: { "Retry-After": "999999999" } }), 0)).toBe(
      30_000,
    );
    expect(
      _registryRetryDelayForTests(
        new Response(null, { headers: { "Retry-After": "Fri, 31 Dec 9999 23:59:59 GMT" } }),
        0,
      ),
    ).toBe(30_000);
    expect(
      _registryRetryDelayForTests(
        new Response(null, { headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT" } }),
        0,
      ),
    ).toBe(0);
    const negative = _registryRetryDelayForTests(new Response(null, { headers: { "Retry-After": "-1" } }), 0);
    expect(negative).toBeGreaterThanOrEqual(250);
    expect(negative).toBeLessThanOrEqual(500);
  });

  test("production transport connects to the validated address without resolving the URL host again", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.headers.get("host") ?? "");
        return new Response("pinned");
      },
    });
    try {
      const networkModule = await import("../../src/registry/network");
      const requestPinned = (
        networkModule as typeof networkModule & {
          requestRegistryAddressPinned?: NonNullable<
            Parameters<typeof fetchRegistryResponse>[2]["requestPinnedForTesting"]
          >;
        }
      ).requestRegistryAddressPinned;
      expect(typeof requestPinned).toBe("function");

      const url = `http://registry.test:${server.port}/index.json`;
      const response = await fetchRegistryResponse(url, { headers: { Host: "unrelated.internal" } }, {
        policy: PUBLIC_POLICY,
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname: resolverFor({ "registry.test": ["127.0.0.1"] }),
        allowPrivateHostsForTesting: true,
        requestPinnedForTesting: requestPinned,
      } as Parameters<typeof fetchRegistryResponse>[2]);
      expect(await response.text()).toBe("pinned");
      expect(requests).toEqual([`registry.test:${server.port}`]);
    } finally {
      server.stop(true);
    }
  });

  test("provider requests do not inherit the loopback fixture exception for private hosts", async () => {
    let fetchCalls = 0;
    const result = await withMockedFetch(
      () =>
        searchRegistry("private", {
          registries: [
            { url: "http://10.0.0.8/index.json", provider: "static-index" },
            { url: "http://10.0.0.9", provider: "skills-sh" },
          ],
        }),
      () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    );

    expect(fetchCalls).toBe(0);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.includes("non-public"))).toBe(true);
  });

  test("a registry-derived git ref is rejected before it can become a materializer input", async () => {
    const maliciousIndex = {
      version: 3,
      updatedAt: "2026-08-19T00:00:00.000Z",
      stashes: [
        {
          id: "git:internal",
          name: "internal",
          description: "registry-controlled git transport",
          source: "git",
          ref: "http://169.254.169.254/latest/meta-data",
          tags: ["internal"],
        },
        {
          id: "npm:safe",
          name: "safe internal tool",
          description: "installable neighboring entry",
          source: "npm",
          ref: "safe-package",
          tags: ["internal"],
        },
      ],
    };

    const result = await withMockedFetch(
      () =>
        searchRegistry("internal", {
          registries: [{ url: "https://registry.example/index.json", provider: "static-index" }],
        }),
      () => new Response(JSON.stringify(maliciousIndex), { headers: { "Content-Type": "application/json" } }),
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.installRef).toBe("npm:safe-package");
    expect(result.warnings.join("\n")).toMatch(/registry.*git|git.*registry/i);
    expect(buildInstallRef("git", "http://169.254.169.254/latest/meta-data")).toBe(
      "git+http://169.254.169.254/latest/meta-data",
    );
  });

  test("setup never turns registry homepages or raw Git refs into Git materializer inputs", async () => {
    const entries = await withMockedFetch(
      () => loadSetupStashes("https://registry.example.test/index.json"),
      () =>
        Response.json({
          stashes: [
            {
              id: "itlackey/akm-stash",
              name: "malicious-default",
              source: "npm",
              ref: "safe-package",
              homepage: "http://169.254.169.254/latest/meta-data",
            },
            {
              id: "raw-git",
              name: "raw-git",
              source: "git",
              ref: "http://169.254.169.254/latest/meta-data",
            },
            {
              id: "local",
              name: "local",
              source: "local",
              ref: "/etc",
            },
            {
              id: "github",
              name: "github",
              source: "github",
              ref: "safe-owner/safe-repo",
              homepage: "http://169.254.169.254/latest/meta-data",
            },
          ],
        }),
    );

    expect(entries).toEqual([
      {
        id: "itlackey/akm-stash",
        name: "malicious-default",
        description: "",
        url: "npm:safe-package",
        installType: "npm",
        source: "registry",
        defaultSelected: false,
      },
      {
        id: "github",
        name: "github",
        description: "",
        url: "https://github.com/safe-owner/safe-repo",
        installType: "git",
        source: "registry",
        defaultSelected: false,
      },
    ]);
  });

  test("setup preselects the official ID only when it resolves to its authenticated target", async () => {
    const entries = await withMockedFetch(
      () => loadSetupStashes("https://registry.example.test/index.json"),
      () =>
        Response.json({
          stashes: [
            {
              id: "itlackey/akm-stash",
              name: "official",
              source: "github",
              ref: "itlackey/akm-stash",
            },
          ],
        }),
    );

    expect(entries).toEqual([
      {
        id: "itlackey/akm-stash",
        name: "official",
        description: "",
        url: "https://github.com/itlackey/akm-stash",
        installType: "git",
        source: "registry",
        defaultSelected: true,
      },
    ]);
  });

  test("setup releases a terminal non-OK registry response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("never-ending"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const entries = await withMockedFetch(
      () => loadSetupStashes("https://registry.example.test/index.json"),
      () => new Response(body, { status: 404 }),
    );

    expect(entries[0]?.source).toBe("fallback");
    expect(cancelled).toBe(true);
  });

  test("setup bounds a successful registry response body that never finishes", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });

    const entries = await withMockedFetch(
      () => loadSetupStashes("https://registry.example.test/index.json", 20),
      () => new Response(body, { status: 200 }),
    );

    expect(entries[0]?.source).toBe("fallback");
    expect(cancelled).toBe(true);
  });

  test("rejects embedded credentials on the initial URL and on redirect targets", async () => {
    const options = {
      policy: PUBLIC_POLICY,
      timeoutMs: 1_000,
      retries: 0,
      resolveHostname: resolverFor({ "registry.example": ["93.184.216.34"] }),
    } as const;
    await expect(
      fetchRegistryResponse("https://user:secret@registry.example/index.json", undefined, options),
    ).rejects.toThrow(/embedded credentials/i);

    await expect(
      withMockedFetch(
        () => fetchRegistryResponse("https://registry.example/index.json", undefined, options),
        () => new Response("", { status: 302, headers: { location: "https://user:secret@cdn.example/file" } }),
      ),
    ).rejects.toThrow(/embedded credentials/i);
  });

  test("revalidates a redirect target and refuses a redirect into the private network", async () => {
    const seen: string[] = [];
    await expect(
      withMockedFetch(
        () =>
          fetchRegistryResponse("https://registry.example/index.json", undefined, {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname: resolverFor({ "registry.example": ["93.184.216.34"] }),
          }),
        (url) => {
          seen.push(url);
          return new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } });
        },
      ),
    ).rejects.toThrow(/non-public/i);
    expect(seen).toEqual(["https://registry.example/index.json"]);
  });

  test("strips sensitive headers on a cross-origin redirect and resolves every hop", async () => {
    const seenRequests: Array<Record<string, string>> = [];
    const resolvedHosts: string[] = [];
    const response = await withMockedFetch(
      () =>
        fetchRegistryResponse(
          "https://registry.example/start",
          {
            headers: {
              Authorization: "Bearer registry-secret",
              Cookie: "sid=registry-secret",
              "Proxy-Authorization": "Basic proxy-secret",
              "X-Registry-Client": "keep",
            },
          },
          {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname: async (hostname) => {
              resolvedHosts.push(hostname);
              return ["93.184.216.34"];
            },
          },
        ),
      (url, init) => {
        const headers = new Headers(init?.headers);
        seenRequests.push({
          url,
          authorization: headers.get("authorization") ?? "",
          cookie: headers.get("cookie") ?? "",
          proxyAuthorization: headers.get("proxy-authorization") ?? "",
          client: headers.get("x-registry-client") ?? "",
          redirect: init?.redirect ?? "",
        });
        if (url === "https://registry.example/start") {
          return new Response("", { status: 307, headers: { location: "https://cdn.example/final" } });
        }
        return new Response("ok");
      },
    );
    await response.body?.cancel();

    expect(resolvedHosts).toEqual(["registry.example", "cdn.example"]);
    expect(seenRequests).toEqual([
      {
        url: "https://registry.example/start",
        authorization: "Bearer registry-secret",
        cookie: "sid=registry-secret",
        proxyAuthorization: "Basic proxy-secret",
        client: "keep",
        redirect: "manual",
      },
      {
        url: "https://cdn.example/final",
        authorization: "",
        cookie: "",
        proxyAuthorization: "",
        client: "keep",
        redirect: "manual",
      },
    ]);
  });

  test("preserves headers on a same-origin redirect and treats 304 as a final response", async () => {
    const seenAuthorization: string[] = [];
    let call = 0;
    const response = await withMockedFetch(
      () =>
        fetchRegistryResponse(
          "https://registry.example/start",
          { headers: { Authorization: "Bearer same-origin" } },
          {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname: resolverFor({ "registry.example": ["93.184.216.34"] }),
          },
        ),
      (_url, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
        call += 1;
        if (call === 1) {
          return new Response("", { status: 302, headers: { location: "/next" } });
        }
        return new Response(null, { status: 304 });
      },
    );

    expect(response.status).toBe(304);
    expect(seenAuthorization).toEqual(["Bearer same-origin", "Bearer same-origin"]);
  });

  test.each([
    { status: 301, method: "POST", expectedMethod: "GET", preservesBody: false, preservesBodyHeaders: false },
    { status: 302, method: "POST", expectedMethod: "GET", preservesBody: false, preservesBodyHeaders: false },
    { status: 303, method: "PUT", expectedMethod: "GET", preservesBody: false, preservesBodyHeaders: false },
    { status: 303, method: "HEAD", expectedMethod: "HEAD", preservesBody: false, preservesBodyHeaders: true },
    { status: 307, method: "POST", expectedMethod: "POST", preservesBody: true, preservesBodyHeaders: true },
    { status: 308, method: "POST", expectedMethod: "POST", preservesBody: true, preservesBodyHeaders: true },
  ])("$status applies redirect method/body semantics for $method", async ({
    status,
    method,
    expectedMethod,
    preservesBody,
    preservesBodyHeaders,
  }) => {
    const requests: RequestInit[] = [];
    const response = await withMockedFetch(
      () =>
        fetchRegistryResponse(
          "https://registry.example/start",
          {
            method,
            body: method === "HEAD" ? undefined : "payload",
            headers: {
              "Content-Type": "text/plain",
              "Content-Length": "7",
              "X-Keep": "yes",
            },
          },
          {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname: resolverFor({ "registry.example": ["93.184.216.34"] }),
          },
        ),
      (_url, init) => {
        requests.push(init ?? {});
        return requests.length === 1
          ? new Response("", { status, headers: { location: "/next" } })
          : new Response("ok");
      },
    );
    await response.body?.cancel();

    const redirected = requests[1] ?? {};
    const redirectedHeaders = new Headers(redirected.headers);
    expect(redirected.method).toBe(expectedMethod);
    expect(redirected.body === undefined || redirected.body === null).toBe(!preservesBody);
    expect(redirectedHeaders.get("content-type")).toBe(preservesBodyHeaders ? "text/plain" : null);
    expect(redirectedHeaders.get("content-length")).toBe(preservesBodyHeaders ? "7" : null);
    expect(redirectedHeaders.get("x-keep")).toBe("yes");
  });

  test("wraps an invalid redirect Location as a registry policy error", async () => {
    await expect(
      withMockedFetch(
        () =>
          fetchRegistryResponse("https://registry.example/start", undefined, {
            policy: PUBLIC_POLICY,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname: resolverFor({ "registry.example": ["93.184.216.34"] }),
          }),
        () => new Response("", { status: 302, headers: { location: "http://[invalid" } }),
      ),
    ).rejects.toBeInstanceOf(RegistryNetworkError);
  });

  test("fixed GitHub API policy rejects other origins and all redirects", async () => {
    const resolveHostname = resolverFor({ "api.github.com": ["140.82.114.6"] });
    await expect(
      fetchRegistryResponse("https://github.example/repos/o/r", undefined, {
        policy: { kind: "github-api" },
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname,
      }),
    ).rejects.toThrow(/GitHub API origin/i);

    await expect(
      withMockedFetch(
        () =>
          fetchRegistryResponse(
            "https://api.github.com/repos/o/r",
            { headers: { Authorization: "Bearer github-secret" } },
            {
              policy: { kind: "github-api" },
              timeoutMs: 1_000,
              retries: 0,
              resolveHostname,
            },
          ),
        () => new Response("", { status: 302, headers: { location: "https://example.com/elsewhere" } }),
      ),
    ).rejects.toThrow(/does not permit redirects/i);
  });

  test("explicit npm mirror policy permits its private origin but not a redirect to another private host", async () => {
    const policy = {
      kind: "npm-api",
      registryOrigin: "http://npm.internal:4873",
      allowPrivateRegistryOrigin: true,
    } as const;
    const resolveHostname = resolverFor({
      "npm.internal": ["10.0.0.20"],
      "metadata.internal": ["10.0.0.30"],
    });

    const direct = await withMockedFetch(
      () =>
        fetchRegistryResponse("http://npm.internal:4873/pkg", undefined, {
          policy,
          timeoutMs: 1_000,
          retries: 0,
          resolveHostname,
        }),
      () => new Response("{}"),
    );
    await direct.body?.cancel();

    await expect(
      withMockedFetch(
        () =>
          fetchRegistryResponse("http://npm.internal:4873/pkg", undefined, {
            policy,
            timeoutMs: 1_000,
            retries: 0,
            resolveHostname,
          }),
        () => new Response("", { status: 302, headers: { location: "http://metadata.internal/latest" } }),
      ),
    ).rejects.toThrow(/non-public/i);

    await expect(
      fetchRegistryResponse("http://169.254.169.254/package", undefined, {
        policy: {
          kind: "npm-api",
          registryOrigin: "http://169.254.169.254",
          allowPrivateRegistryOrigin: true,
        },
        timeoutMs: 1_000,
        retries: 0,
      }),
    ).rejects.toThrow(/metadata/i);
  });

  test("an explicit private npm mirror cannot nominate a same-host different origin as private", async () => {
    const tarballUrl = "https://npm.internal:8443/pkg/-/pkg-1.0.0.tgz";
    const policy = npmArtifactNetworkPolicy({
      registryOrigin: "http://npm.internal:4873",
      allowPrivateRegistryOrigin: true,
    });
    expect(policy.registryOrigin).toBe("http://npm.internal:4873");

    await withEnv({ AKM_NPM_REGISTRY: "http://changed.internal:9999" }, async () => {
      await expect(
        withMockedFetch(
          () =>
            fetchRegistryResponse(tarballUrl, undefined, {
              policy,
              timeoutMs: 1_000,
              retries: 0,
              resolveHostname: resolverFor({ "npm.internal": ["10.0.0.20"] }),
            }),
          () => new Response("archive"),
        ),
      ).rejects.toThrow(/non-public/i);
    });
  });

  test("classifies every spelling of the AWS IPv6 metadata address numerically", async () => {
    const expanded = "fd00:0ec2:0000:0000:0000:0000:0000:0254";
    expect(classifyNetworkAddress("fd00:ec2::254")).toBe("metadata");
    expect(classifyNetworkAddress(expanded)).toBe("metadata");

    await expect(
      fetchRegistryResponse("http://npm.internal:4873/pkg", undefined, {
        policy: {
          kind: "npm-api",
          registryOrigin: "http://npm.internal:4873",
          allowPrivateRegistryOrigin: true,
        },
        timeoutMs: 1_000,
        retries: 0,
        resolveHostname: resolverFor({ "npm.internal": [expanded] }),
      }),
    ).rejects.toThrow(/metadata/i);
  });

  test("fails closed for IPv6 space outside allocated global unicast", () => {
    expect(classifyNetworkAddress("2001:4860:4860::8888")).toBe("public");
    for (const address of ["3ffe::1", "4000::1", "8000::1"]) {
      expect(classifyNetworkAddress(address)).toBe("reserved");
    }
  });

  test("npm artifact downloads use the boundary and reject private redirect targets", async () => {
    const tarballUrl = "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz";
    let fetchCalls = 0;
    await expect(
      withMockedFetch(
        () =>
          downloadArchive(
            tarballUrl,
            "/tmp/akm-registry-boundary-unwritten.tgz",
            npmArtifactNetworkPolicy({
              registryOrigin: "https://registry.npmjs.org",
              allowPrivateRegistryOrigin: false,
            }),
          ),
        () => {
          fetchCalls += 1;
          return new Response("", { status: 302, headers: { location: "http://169.254.169.254/archive.tgz" } });
        },
      ),
    ).rejects.toThrow(/non-public/i);
    expect(fetchCalls).toBe(1);
  });
});
