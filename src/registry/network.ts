// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isIP } from "node:net";
import {
  bareHostname,
  classifyNetworkAddress,
  classifyNetworkHostname,
  type HostnameResolver,
  resolveHostnameAddresses,
} from "../core/network-policy";
import {
  assertRegistryPinnedTransportAvailable,
  type RegistryPinnedRequest,
  requestRegistryAddressPinned,
} from "./pinned-transport";

export { requestRegistryAddressPinned } from "./pinned-transport";

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
  /** Test-only transport injection; production callers never set this. */
  requestPinnedForTesting?: RegistryPinnedRequest;
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
const MAX_REGISTRY_RETRY_DELAY_MS = 30_000;
let allowRegistryFixturesForTests = false;
let registryHostnameResolverForTests: RegistryHostnameResolver | undefined;
let registryPinnedRequestForTests: RegistryPinnedRequest | undefined;

/**
 * Single outbound HTTP boundary for registry metadata requests.
 *
 * Every retry and redirect returns through this function's resolve, validate,
 * and pinned-connect sequence before another request can start.
 */
export async function fetchRegistryResponse(
  rawUrl: string,
  init: RequestInit | undefined,
  options: RegistryRequestOptions,
  redirectCount = 0,
): Promise<Response> {
  const url = parseRegistryUrl(rawUrl);
  const response = await requestRegistryHop(url, init, options);
  if (!isRedirect(response.status)) return response;

  if (options.policy.kind === "github-api") {
    await cancelRegistryResponse(response);
    throw new RegistryNetworkError("GitHub API registry metadata policy does not permit redirects");
  }
  if (redirectCount >= MAX_REGISTRY_REDIRECTS) {
    await cancelRegistryResponse(response);
    throw new RegistryNetworkError(`Too many redirects while fetching registry metadata from ${url.origin}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    await cancelRegistryResponse(response);
    throw new RegistryNetworkError(`Redirect from registry host ${url.hostname} did not include Location`);
  }

  await cancelRegistryResponse(response);
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, url);
  } catch {
    throw new RegistryNetworkError(`Redirect from registry host ${url.hostname} included an invalid Location`);
  }
  const nextInit = redirectInit(init, url, nextUrl, response.status);
  return fetchRegistryResponse(nextUrl.toString(), nextInit, options, redirectCount + 1);
}

async function requestRegistryHop(
  url: URL,
  init: RequestInit | undefined,
  options: RegistryRequestOptions,
): Promise<Response> {
  const maxRetries = options.retries ?? 3;
  const injectedTransport = options.requestPinnedForTesting ?? registryPinnedRequestForTests;
  if (!injectedTransport) assertRegistryPinnedTransportAvailable();
  const transport = injectedTransport ?? requestRegistryAddressPinned;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptDeadline = Date.now() + options.timeoutMs;
    const allowPrivate = privateNetworkAllowed(url, options);
    const addresses = await validatedRegistryAddresses(url, options, allowPrivate, options.timeoutMs, init?.signal);
    if (Date.now() >= attemptDeadline) {
      throw new RegistryNetworkError(
        `Registry request to ${url.hostname} attempt deadline expired before transport could start`,
      );
    }
    const address = addresses[attempt % addresses.length];
    if (!address) {
      throw new RegistryNetworkError(`Refusing registry request to ${url.hostname}: no validated address available`);
    }

    try {
      const remainingMs = attemptDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new RegistryNetworkError(
          `Registry request to ${url.hostname} attempt deadline expired before transport could start`,
        );
      }
      const response = await transport(url, address, init, remainingMs);
      if (attempt < maxRetries && shouldRetry(response.status)) {
        const delay = retryDelay(response, attempt);
        await cancelRegistryResponse(response);
        await abortableDelay(delay, init?.signal);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxRetries || init?.signal?.aborted) throw error;
      await abortableDelay(backoffDelay(attempt), init?.signal);
    }
  }
  throw new Error("Registry retry loop is unreachable");
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

async function validatedRegistryAddresses(
  url: URL,
  options: RegistryRequestOptions,
  allowPrivate: boolean,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<string[]> {
  assertPolicyOrigin(url, options.policy);

  const hostname = bareHostname(url.hostname);
  const literal = isIP(hostname) !== 0;
  const hostClass = classifyNetworkHostname(hostname);
  assertAllowedClass(hostClass, hostname, allowPrivate);
  if (literal) return [hostname];

  let addresses: string[];
  try {
    addresses = await resolveAddressesWithDeadline(
      hostname,
      options.resolveHostname ?? registryHostnameResolverForTests,
      timeoutMs,
      signal,
    );
  } catch (error) {
    if (error instanceof RegistryNetworkError || signal?.aborted) throw error;
    throw new RegistryNetworkError(`Refusing registry request to ${hostname}: DNS resolution failed`);
  }
  if (addresses.length === 0) {
    throw new RegistryNetworkError(`Refusing registry request to ${hostname}: hostname resolved to no addresses`);
  }
  for (const address of addresses) {
    const addressClass = classifyNetworkAddress(address);
    assertAllowedClass(addressClass, `${hostname} (${address})`, allowPrivate, true);
  }
  return addresses;
}

async function resolveAddressesWithDeadline(
  hostname: string,
  resolver: RegistryHostnameResolver | undefined,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<string[]> {
  if (signal?.aborted) throw signal.reason ?? new Error("Registry request aborted");
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason ?? new Error("Registry request aborted")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new RegistryNetworkError(
              `Refusing registry request to ${hostname}: DNS resolution timed out after ${timeoutMs}ms`,
            ),
          ),
        ),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    void resolveHostnameAddresses(hostname, resolver).then(
      (addresses) => finish(() => resolve(addresses)),
      (error) => finish(() => reject(error)),
    );
  });
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

function redirectInit(
  init: RequestInit | undefined,
  currentUrl: URL,
  nextUrl: URL,
  status: number,
): RequestInit | undefined {
  if (!init) return init;
  const headers = new Headers(init.headers);
  if (currentUrl.origin !== nextUrl.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }

  const method = (init.method ?? "GET").toUpperCase();
  const switchToGet =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  if (!switchToGet) return { ...init, headers };
  for (const name of ["content-encoding", "content-language", "content-length", "content-location", "content-type"]) {
    headers.delete(name);
  }
  return { ...init, method: "GET", body: undefined, headers };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Release a terminal response body so pinned helper/socket resources cannot linger. */
export async function cancelRegistryResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds >= 0 ? Math.min(MAX_REGISTRY_RETRY_DELAY_MS, seconds * 1_000) : backoffDelay(attempt);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(MAX_REGISTRY_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
  }
  return backoffDelay(attempt);
}

function backoffDelay(attempt: number): number {
  return Math.min(MAX_REGISTRY_RETRY_DELAY_MS, 500 * 2 ** attempt * (0.5 + Math.random() * 0.5));
}

/** Test-only visibility for the server-controlled Retry-After clamp. */
export function _registryRetryDelayForTests(response: Response, attempt: number): number {
  return retryDelay(response, attempt);
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Registry request aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Registry request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  requestPinned?: RegistryPinnedRequest;
}): void {
  allowRegistryFixturesForTests = overrides?.allowLoopbackFixtures === true;
  registryHostnameResolverForTests = overrides?.resolveHostname;
  registryPinnedRequestForTests = overrides?.requestPinned;
}
