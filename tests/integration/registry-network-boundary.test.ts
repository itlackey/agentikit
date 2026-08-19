// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { searchRegistry } from "../../src/commands/read/registry-search";
import { fetchRegistryResponse, type RegistryHostnameResolver, RegistryNetworkError } from "../../src/registry/network";
import { npmArtifactNetworkPolicy } from "../../src/registry/resolve";
import { downloadArchive } from "../../src/sources/providers/provider-utils";
import { withMockedFetch } from "../_helpers/sandbox";

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

  test("npm artifact downloads use the boundary and reject private redirect targets", async () => {
    const tarballUrl = "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz";
    let fetchCalls = 0;
    await expect(
      withMockedFetch(
        () =>
          downloadArchive(tarballUrl, "/tmp/akm-registry-boundary-unwritten.tgz", npmArtifactNetworkPolicy(tarballUrl)),
        () => {
          fetchCalls += 1;
          return new Response("", { status: 302, headers: { location: "http://169.254.169.254/archive.tgz" } });
        },
      ),
    ).rejects.toThrow(/non-public/i);
    expect(fetchCalls).toBe(1);
  });
});
