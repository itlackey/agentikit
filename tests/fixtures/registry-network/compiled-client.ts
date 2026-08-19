// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { fetchRegistryResponse } from "../../../src/registry/network";
import { requestRegistryAddressPinned } from "../../../src/registry/pinned-transport";

const [rawUrl, address, caPath, expectation] = process.argv.slice(2);
if (!rawUrl || !address || !caPath || !expectation) {
  throw new Error(
    "Usage: compiled-client <url> <address> <ca-path|-> <success|bodyless-success|failure|certificate-failure>",
  );
}

let resolverCalled = false;
const unhandledRejections: string[] = [];
const onUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
};
if (expectation === "bodyless-success") process.on("unhandledRejection", onUnhandledRejection);
try {
  if (expectation === "failure") {
    await fetchRegistryResponse(rawUrl, undefined, {
      policy: { kind: "public-registry" },
      timeoutMs: 2_000,
      retries: 0,
      resolveHostname: async () => {
        resolverCalled = true;
        return [address];
      },
    });
    throw new Error(`Expected the pinned registry request to fail (resolverCalled=${String(resolverCalled)})`);
  }
  const response = await requestRegistryAddressPinned(
    new URL(rawUrl),
    address,
    { headers: { Host: "evil.invalid" } },
    2_000,
    {
      ca: caPath === "-" ? undefined : fs.readFileSync(caPath),
    },
  );
  const body = await response.text();
  if (expectation === "certificate-failure") throw new Error("Expected TLS certificate identity verification to fail");
  if (expectation === "bodyless-success") {
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.off("unhandledRejection", onUnhandledRejection);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, status: response.status, body, unhandledRejections })}\n`);
} catch (error) {
  process.off("unhandledRejection", onUnhandledRejection);
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  if (expectation !== "failure" && expectation !== "certificate-failure") throw error;
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: candidate.code,
      message: candidate.message,
      name: candidate.name,
      resolverCalled,
    })}\n`,
  );
}
