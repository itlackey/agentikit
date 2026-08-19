// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  cancelRegistryResponse,
  fetchRegistryResponse,
  requestRegistryAddressPinned,
} from "../../src/registry/network";
import { RegistryPinnedTransportError } from "../../src/registry/pinned-transport";
import { withEnv } from "../_helpers/sandbox";

const PUBLIC_POLICY = { kind: "public-registry" } as const;
const FIXTURES = path.resolve(import.meta.dir, "../fixtures/registry-network");
const TEST_CERT = fs.readFileSync(path.join(FIXTURES, "registry-test-cert.pem"), "utf8");

function nodeExecutablePath(): string {
  const executable = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, process.platform === "win32" ? "node.exe" : "node"))
    .find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Node executable is required for registry transport acceptance");
  return fs.realpathSync(executable);
}

async function nodeTlsObserver(): Promise<{ port: number; close: () => Promise<void> }> {
  const child = spawn(
    nodeExecutablePath(),
    [
      path.join(FIXTURES, "tls-observer.mjs"),
      path.join(FIXTURES, "registry-test-cert.pem"),
      path.join(FIXTURES, "registry-test-key.pem"),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      const candidate = Number.parseInt(Buffer.from(chunk).toString("utf8").trim(), 10);
      if (!Number.isInteger(candidate)) reject(new Error("TLS observer returned an invalid port"));
      else resolve(candidate);
    });
  });
  return {
    port,
    close: async () => {
      child.stdin.end("close\n");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function runProcess(command: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${stderr || stdout}`);
  return stdout.trim();
}

function writeFakeExecutable(source: string): { executable: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-helper-fixture-"));
  const executable = path.join(directory, "fake-node");
  fs.writeFileSync(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  return {
    executable,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function productionOptions(hostname: string, address = "127.0.0.1") {
  return {
    policy: PUBLIC_POLICY,
    timeoutMs: 1_000,
    retries: 0,
    resolveHostname: async (candidate: string) => (candidate === hostname ? [address] : []),
    allowPrivateHostsForTesting: true,
    requestPinnedForTesting: requestRegistryAddressPinned,
  } as const;
}

describe("registry pinned production transport", () => {
  test("streams and transparently decodes gzip, deflate, and br while retaining response headers", async () => {
    const encodings = {
      gzip: gzipSync,
      deflate: deflateSync,
      br: brotliCompressSync,
    } as const;
    const server = http.createServer((request, response) => {
      const encoding = request.url?.slice(1) as keyof typeof encodings;
      const compressed = encodings[encoding](Buffer.from(`decoded-${encoding}`));
      response.writeHead(200, {
        "Content-Encoding": encoding,
        "Content-Length": String(compressed.byteLength),
        "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
        "X-Duplicate": ["one", "two"],
      });
      response.end(compressed);
    });
    const port = await listen(server);
    try {
      for (const encoding of Object.keys(encodings) as Array<keyof typeof encodings>) {
        const response = await fetchRegistryResponse(
          `http://registry.test:${port}/${encoding}`,
          undefined,
          productionOptions("registry.test"),
        );
        expect(response.headers.get("content-encoding")).toBe(encoding);
        expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
        expect(response.headers.get("x-duplicate")).toBe("one, two");
        expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
        expect(await response.text()).toBe(`decoded-${encoding}`);
      }
    } finally {
      await close(server);
    }
  });

  test("surfaces decompression failures through the streaming response body", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Encoding": "gzip" });
      response.end("not-gzip");
    });
    const port = await listen(server);
    try {
      const response = await fetchRegistryResponse(
        `http://registry.test:${port}/broken`,
        undefined,
        productionOptions("registry.test"),
      );
      await expect(response.text()).rejects.toThrow();
    } finally {
      await close(server);
    }
  });

  test("aborts an in-progress streaming body", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("first");
    });
    const port = await listen(server);
    const controller = new AbortController();
    let helperDirectory: string | undefined;
    let helperPid: number | undefined;
    try {
      const response = await fetchRegistryResponse(
        `http://registry.test:${port}/stream`,
        { signal: controller.signal },
        {
          ...productionOptions("registry.test"),
          requestPinnedForTesting: (url, address, init, timeoutMs) =>
            requestRegistryAddressPinned(url, address, init, timeoutMs, {
              onHelperSpawn(details) {
                helperDirectory = details.directory;
                helperPid = details.pid;
              },
            }),
        },
      );
      const body = response.text();
      controller.abort(new Error("stop-stream"));
      await expect(body).rejects.toThrow();
      const directory = required(helperDirectory, "aborted registry helper did not start");
      await waitFor(() => !fs.existsSync(directory), "aborted registry helper was not cleaned up");
      const pid = helperPid;
      if (pid !== undefined && process.platform !== "win32") {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      await close(server);
    }
  });

  test("enforces the response-header timeout", async () => {
    const pendingResponses: http.ServerResponse[] = [];
    const server = http.createServer((_request, response) => {
      pendingResponses.push(response);
    });
    const port = await listen(server);
    let helperDirectory: string | undefined;
    let helperPid: number | undefined;
    try {
      await expect(
        fetchRegistryResponse(`http://registry.test:${port}/hang`, undefined, {
          ...productionOptions("registry.test"),
          timeoutMs: 25,
          requestPinnedForTesting: (url, address, init, timeoutMs) =>
            requestRegistryAddressPinned(url, address, init, timeoutMs, {
              onHelperSpawn(details) {
                helperDirectory = details.directory;
                helperPid = details.pid;
              },
            }),
        }),
      ).rejects.toThrow(/timed out/i);
      const directory = required(helperDirectory, "timed-out registry helper did not start");
      await waitFor(() => !fs.existsSync(directory), "timed-out registry helper was not cleaned up");
      const pid = helperPid;
      if (pid !== undefined && process.platform !== "win32") {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      await close(server);
    }
  });

  test("cancelling a terminal non-OK response kills, reaps, and cleans up its helper", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.write("first");
    });
    const port = await listen(server);
    let helperDirectory: string | undefined;
    let helperPid: number | undefined;
    try {
      const response = await fetchRegistryResponse(`http://registry.test:${port}/cancel`, undefined, {
        ...productionOptions("registry.test"),
        requestPinnedForTesting: (url, address, init, timeoutMs) =>
          requestRegistryAddressPinned(url, address, init, timeoutMs, {
            onHelperSpawn(details) {
              helperDirectory = details.directory;
              helperPid = details.pid;
            },
          }),
      });
      expect(response.status).toBe(404);
      await cancelRegistryResponse(response);
      const directory = required(helperDirectory, "cancelled registry helper did not start");
      await waitFor(() => !fs.existsSync(directory), "cancelled registry helper was not cleaned up");
      const pid = helperPid;
      if (pid !== undefined && process.platform !== "win32") {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      await close(server);
    }
  });

  test("pins TLS to the address while verifying the original hostname and sending it as SNI/Host", async () => {
    const observer = await nodeTlsObserver();
    const trustedTransport = (url: URL, address: string, init: RequestInit | undefined, timeoutMs: number) =>
      requestRegistryAddressPinned(url, address, init, timeoutMs, { ca: TEST_CERT });
    try {
      const response = await fetchRegistryResponse(
        `https://registry.test:${observer.port}/secure`,
        { headers: { Host: "unrelated.internal" } },
        {
          ...productionOptions("registry.test"),
          requestPinnedForTesting: trustedTransport,
        },
      );
      expect(await response.json()).toEqual({
        host: `registry.test:${observer.port}`,
        remoteAddress: "127.0.0.1",
        servername: "registry.test",
      });
    } finally {
      await observer.close();
    }

    const mismatchObserver = await nodeTlsObserver();
    try {
      await expect(
        fetchRegistryResponse(`https://other.test:${mismatchObserver.port}/secure`, undefined, {
          ...productionOptions("other.test"),
          requestPinnedForTesting: trustedTransport,
        }),
      ).rejects.toThrow(/not valid for 'other\.test'|hostname/i);
    } finally {
      await mismatchObserver.close();
    }
  });

  test("keeps request secrets off argv/env, forces Host, and removes hop-by-hop proxy headers", async () => {
    const observed: Array<{ authorization?: string; host?: string; proxyAuthorization?: string; body: string }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed.push({
          authorization: request.headers.authorization,
          host: request.headers.host,
          proxyAuthorization: request.headers["proxy-authorization"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.end("ok");
      });
    });
    const port = await listen(server);
    const secret = "private-auth-value";
    const body = "private-body-value";
    let helperDirectory: string | undefined;
    let helperPid: number | undefined;
    try {
      await withEnv(
        {
          ALL_PROXY: `http://${secret}@proxy.invalid`,
          HTTP_PROXY: `http://${secret}@proxy.invalid`,
          HTTPS_PROXY: `http://${secret}@proxy.invalid`,
          NO_PROXY: secret,
        },
        async () => {
          const response = await fetchRegistryResponse(
            `http://registry.test:${port}/upload`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secret}`,
                Connection: "keep-alive",
                Host: "unrelated.internal",
                "Proxy-Authorization": `Basic ${secret}`,
              },
              body,
            },
            {
              ...productionOptions("registry.test"),
              requestPinnedForTesting: (url, address, init, timeoutMs) =>
                requestRegistryAddressPinned(url, address, init, timeoutMs, {
                  onHelperSpawn(details) {
                    helperDirectory = details.directory;
                    helperPid = details.pid;
                    expect(fs.statSync(details.directory).mode & 0o777).toBe(0o700);
                    expect(fs.statSync(required(details.args[0], "helper argv omitted its program")).mode & 0o777).toBe(
                      0o600,
                    );
                    const processMetadata = JSON.stringify({
                      executable: details.executable,
                      args: details.args,
                      env: details.env,
                    });
                    expect(processMetadata).not.toContain(secret);
                    expect(processMetadata).not.toContain(body);
                    expect(processMetadata).not.toContain("registry.test");
                    expect(Object.keys(details.env).some((name) => /proxy|authorization|token/i.test(name))).toBe(
                      false,
                    );
                    if (details.pid && fs.existsSync(`/proc/${details.pid}/cmdline`)) {
                      expect(fs.readFileSync(`/proc/${details.pid}/cmdline`, "utf8")).not.toContain(secret);
                      expect(fs.readFileSync(`/proc/${details.pid}/environ`, "utf8")).not.toContain(secret);
                    }
                  },
                }),
            },
          );
          expect(await response.text()).toBe("ok");
          expect(observed).toEqual([
            {
              authorization: `Bearer ${secret}`,
              host: `registry.test:${port}`,
              proxyAuthorization: undefined,
              body,
            },
          ]);
          const directory = required(helperDirectory, "completed registry helper did not start");
          await waitFor(() => !fs.existsSync(directory), "completed registry helper was not cleaned up");
          const pid = helperPid;
          if (pid !== undefined && process.platform !== "win32") {
            expect(() => process.kill(pid, 0)).toThrow();
          }
        },
      );
    } finally {
      await close(server);
    }
  });

  test("fails closed before connecting when Bun cannot find Node", async () => {
    await expect(
      requestRegistryAddressPinned(new URL("https://registry.test/never-connect"), "203.0.113.8", undefined, 100, {
        nodeExecutable: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "REGISTRY_PINNED_TRANSPORT",
        message: expect.stringContaining("requires Node.js >= 22"),
      }),
    );
  });

  test.skipIf(process.platform === "win32")(
    "rejects oversized, malformed, and out-of-order helper frames",
    async () => {
      const cases = [
        { bytes: "\\000\\000\\001\\000\\001", expected: /frame exceeds/i },
        { bytes: "\\001\\000\\020\\000\\001", expected: /frame exceeds/i },
        { bytes: "\\001\\000\\000\\000\\000", expected: /body data before response metadata/i },
        { bytes: "\\000\\000\\000\\000\\001{", expected: /invalid response metadata/i },
        { bytes: "\\004\\000\\000\\000\\000", expected: /unknown frame type/i },
      ];
      for (const fixtureCase of cases) {
        const fake = writeFakeExecutable(`printf '${fixtureCase.bytes}'\n/bin/sleep 0.1`);
        try {
          await expect(
            requestRegistryAddressPinned(new URL("http://registry.test/probe"), "203.0.113.8", undefined, 1_000, {
              nodeExecutable: fake.executable,
            }),
          ).rejects.toThrow(fixtureCase.expected);
        } finally {
          fake.cleanup();
        }
      }
    },
  );

  test.skipIf(process.platform === "win32")("caps and redacts stderr from a nonzero helper exit", async () => {
    const secret = "Bearer must-not-escape";
    const fake = writeFakeExecutable(`printf '${secret}' >&2\nexit 7`);
    try {
      let failure: unknown;
      try {
        await requestRegistryAddressPinned(
          new URL("http://registry.test/probe"),
          "203.0.113.8",
          { headers: { Authorization: secret } },
          1_000,
          { nodeExecutable: fake.executable },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(RegistryPinnedTransportError);
      expect(String(failure)).not.toContain(secret);
    } finally {
      fake.cleanup();
    }
  });

  test("rejects an oversized request prelude and cleans up the helper", async () => {
    let helperDirectory: string | undefined;
    await expect(
      requestRegistryAddressPinned(
        new URL("http://registry.test/probe"),
        "203.0.113.8",
        { headers: { "X-Oversized": "x".repeat(70_000) } },
        1_000,
        {
          onHelperSpawn(details) {
            helperDirectory = details.directory;
          },
        },
      ),
    ).rejects.toThrow(/request prelude exceeds/i);
    const directory = required(helperDirectory, "rejected registry helper did not start");
    await waitFor(() => !fs.existsSync(directory), "rejected registry helper was not cleaned up");
  });

  test("rejects an oversized request body before starting a helper or network connection", async () => {
    let helperStarted = false;
    await expect(
      requestRegistryAddressPinned(
        new URL("http://registry.test/never-connect"),
        "203.0.113.8",
        { method: "POST", body: new Uint8Array(16 * 1024 * 1024 + 1) },
        1_000,
        {
          onHelperSpawn() {
            helperStarted = true;
          },
        },
      ),
    ).rejects.toThrow(/request body exceeds/i);
    expect(helperStarted).toBe(false);
  });

  test("compiled Bun transport uses Node when present and fails closed without it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-compiled-transport-"));
    const executable = path.join(root, process.platform === "win32" ? "registry-client.exe" : "registry-client");
    const nodeBundle = path.join(root, "registry-client.mjs");
    const fixture = path.join(FIXTURES, "compiled-client.ts");
    try {
      await runProcess([process.execPath, "build", fixture, "--compile", "--outfile", executable]);
      await runProcess([process.execPath, "build", fixture, "--target=node", "--outfile", nodeBundle]);

      const observer = await nodeTlsObserver();
      try {
        const success = JSON.parse(
          await runProcess(
            [
              executable,
              `https://registry.test:${observer.port}/compiled`,
              "127.0.0.1",
              path.join(FIXTURES, "registry-test-cert.pem"),
              "success",
            ],
            process.env,
          ),
        ) as { ok: boolean; body: string };
        expect(success.ok).toBe(true);
        expect(JSON.parse(success.body)).toEqual({
          host: `registry.test:${observer.port}`,
          remoteAddress: "127.0.0.1",
          servername: "registry.test",
        });

        const nodeSuccess = JSON.parse(
          await runProcess([
            nodeExecutablePath(),
            nodeBundle,
            `https://registry.test:${observer.port}/node`,
            "127.0.0.1",
            path.join(FIXTURES, "registry-test-cert.pem"),
            "success",
          ]),
        ) as { ok: boolean; body: string };
        expect(nodeSuccess.ok).toBe(true);
        expect(JSON.parse(nodeSuccess.body)).toEqual({
          host: `registry.test:${observer.port}`,
          remoteAddress: "127.0.0.1",
          servername: "registry.test",
        });

        const certificateFailure = JSON.parse(
          await runProcess([
            nodeExecutablePath(),
            nodeBundle,
            `https://other.test:${observer.port}/node-mismatch`,
            "127.0.0.1",
            path.join(FIXTURES, "registry-test-cert.pem"),
            "certificate-failure",
          ]),
        ) as { ok: boolean; message?: string };
        expect(certificateFailure.ok).toBe(false);
        expect(certificateFailure.message).toMatch(/not valid for 'other\.test'|hostname/i);
      } finally {
        await observer.close();
      }

      const emptyPath = path.join(root, "empty-path");
      fs.mkdirSync(emptyPath);
      const failure = JSON.parse(
        await runProcess([executable, "http://registry.test:9/no-network", "203.0.113.8", "-", "failure"], {
          ...process.env,
          PATH: emptyPath,
        }),
      ) as { ok: boolean; code?: string; message?: string; resolverCalled?: boolean };
      expect(failure).toMatchObject({
        ok: false,
        code: "REGISTRY_PINNED_TRANSPORT",
        message: expect.stringContaining("requires Node.js >= 22 on PATH"),
        resolverCalled: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
