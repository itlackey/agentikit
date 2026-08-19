// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isIP } from "node:net";
import { fetchWithRetry } from "../core/common";
import {
  bareHostname,
  classifyNetworkAddress,
  classifyNetworkHostname,
  type HostnameResolver,
  resolveHostnameAddresses,
} from "../core/network-policy";

export type RegistryHostnameResolver = HostnameResolver;

export type RegistryNetworkPolicy =
  | { kind: "public-registry" }
  | { kind: "github-api" }
  | {
      kind: "npm-api";
      registryOrigin: string;
      /** Explicit operator compatibility for an AKM_NPM_REGISTRY private mirror. */
      allowPrivateRegistryOrigin: boolean;
    };

export interface RegistryRequestOptions {
  policy: RegistryNetworkPolicy;
  timeoutMs: number;
  retries?: number;
  resolveHostname?: RegistryHostnameResolver;
  /** Test harness only: local HTTP fixtures are not a production compatibility path. */
  allowPrivateHostsForTesting?: boolean;
}

export class RegistryNetworkError extends Error {
  readonly code = "REGISTRY_NETWORK_POLICY" as const;
  constructor(message: string) {
    super(message);
    this.name = "RegistryNetworkError";
  }
}

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_REGISTRY_REDIRECTS = 8;
let allowRegistryFixturesForTests = false;
let registryHostnameResolverForTests: RegistryHostnameResolver | undefined;

/**
 * Single outbound HTTP boundary for registry metadata requests.
 *
 * Each retry remains inside `fetchWithRetry` with `redirect: "manual"`; every
 * redirect returns through this function, where URL and DNS policy are applied
 * again before another request can start.
 */
export async function fetchRegistryResponse(
  rawUrl: string,
  init: RequestInit | undefined,
  options: RegistryRequestOptions,
  redirectCount = 0,
): Promise<Response> {
  const url = parseRegistryUrl(rawUrl);
  const allowPrivate = privateNetworkAllowed(url, options);
  await assertRegistryDestination(url, options, allowPrivate);

  const response = await fetchWithRetry(
    url.toString(),
    { ...init, redirect: "manual" },
    { timeout: options.timeoutMs, retries: options.retries },
  );
  if (!isRedirect(response.status)) return response;

  if (options.policy.kind === "github-api") {
    await cancelResponse(response);
    throw new RegistryNetworkError("GitHub API registry metadata policy does not permit redirects");
  }
  if (redirectCount >= MAX_REGISTRY_REDIRECTS) {
    await cancelResponse(response);
    throw new RegistryNetworkError(`Too many redirects while fetching registry metadata from ${url.origin}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    await cancelResponse(response);
    throw new RegistryNetworkError(`Redirect from registry host ${url.hostname} did not include Location`);
  }

  await cancelResponse(response);
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, url);
  } catch {
    throw new RegistryNetworkError(`Redirect from registry host ${url.hostname} included an invalid Location`);
  }
  const nextInit = redirectInit(init, url, nextUrl);
  return fetchRegistryResponse(nextUrl.toString(), nextInit, options, redirectCount + 1);
}

function parseRegistryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RegistryNetworkError("Registry request URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RegistryNetworkError(`Registry requests require HTTP(S), not ${url.protocol || "an empty scheme"}`);
  }
  if (url.username || url.password) {
    throw new RegistryNetworkError(`Registry request URL must not contain embedded credentials: ${url.hostname}`);
  }
  return url;
}

function privateNetworkAllowed(url: URL, options: RegistryRequestOptions): boolean {
  if (options.allowPrivateHostsForTesting === true) return true;
  if (options.policy.kind !== "npm-api" || !options.policy.allowPrivateRegistryOrigin) return false;
  const expectedOrigin = normalizedOrigin(options.policy.registryOrigin, "npm registry");
  return url.origin === expectedOrigin;
}

async function assertRegistryDestination(
  url: URL,
  options: RegistryRequestOptions,
  allowPrivate: boolean,
): Promise<void> {
  assertPolicyOrigin(url, options.policy);

  const hostname = bareHostname(url.hostname);
  const literal = isIP(hostname) !== 0;
  const hostClass = classifyNetworkHostname(hostname);
  assertAllowedClass(hostClass, hostname, allowPrivate);
  if (literal) return;

  let addresses: string[];
  try {
    addresses = await resolveHostnameAddresses(hostname, options.resolveHostname ?? registryHostnameResolverForTests);
  } catch {
    throw new RegistryNetworkError(`Refusing registry request to ${hostname}: DNS resolution failed`);
  }
  if (addresses.length === 0) {
    throw new RegistryNetworkError(`Refusing registry request to ${hostname}: hostname resolved to no addresses`);
  }
  for (const address of addresses) {
    const addressClass = classifyNetworkAddress(address);
    assertAllowedClass(addressClass, `${hostname} (${address})`, allowPrivate, true);
  }
}

function assertPolicyOrigin(url: URL, policy: RegistryNetworkPolicy): void {
  if (policy.kind === "github-api" && url.origin !== GITHUB_API_ORIGIN) {
    throw new RegistryNetworkError(`GitHub API origin policy rejected registry request to ${url.origin}`);
  }
  if (policy.kind === "npm-api") {
    const expected = normalizedOrigin(policy.registryOrigin, "npm registry");
    if (url.origin !== expected && classifyNetworkHostname(url.hostname) !== "public") {
      throw new RegistryNetworkError(`npm registry redirect policy rejected non-public origin ${url.origin}`);
    }
  }
}

function normalizedOrigin(rawUrl: string, label: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    throw new RegistryNetworkError(`Configured ${label} origin is invalid`);
  }
}

function assertAllowedClass(
  addressClass: ReturnType<typeof classifyNetworkAddress>,
  destination: string,
  allowPrivate: boolean,
  resolved = false,
): void {
  if (addressClass === "public") return;
  if (allowPrivate && (addressClass === "private" || addressClass === "loopback")) return;
  const qualifier = resolved ? "resolves to " : "is ";
  throw new RegistryNetworkError(
    `Refusing registry request: ${destination} ${qualifier}non-public ${addressClass} destination`,
  );
}

function redirectInit(init: RequestInit | undefined, currentUrl: URL, nextUrl: URL): RequestInit | undefined {
  if (!init || currentUrl.origin === nextUrl.origin) return init;
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return { ...init, headers };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Existing local HTTP fixtures remain available only inside the test process. */
export function allowPrivateRegistryFixtureForTests(rawUrl: string): boolean {
  if (!allowRegistryFixturesForTests) return false;
  try {
    const url = new URL(rawUrl);
    const hostClass = classifyNetworkHostname(url.hostname);
    const port = Number.parseInt(url.port, 10);
    return hostClass === "loopback" && Number.isInteger(port) && port >= 1024 && port <= 65_535;
  } catch {
    return false;
  }
}

/** Test-harness seam; production composition never enables these overrides. */
export function _setRegistryNetworkOverridesForTests(overrides?: {
  allowLoopbackFixtures?: boolean;
  resolveHostname?: RegistryHostnameResolver;
}): void {
  allowRegistryFixturesForTests = overrides?.allowLoopbackFixtures === true;
  registryHostnameResolverForTests = overrides?.resolveHostname;
}
