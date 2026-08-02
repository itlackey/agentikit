// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchWithRetry } from "../../core/common";

/**
 * SSRF host guards and the guarded fetch used by every outbound request the
 * website subsystem makes.
 *
 * Extracted from `website-ingest.ts` into a leaf module so the snapshot
 * fetchers can share it: a fetcher importing `website-ingest` directly would
 * cycle, because `website-ingest` imports the fetcher registry.
 */

/** Options accepted by the host guards. */
export interface HostGuardOptions {
  /** Test-only: permit loopback/private hosts. Never set in production. */
  allowPrivateHosts?: boolean;
  /** Injectable DNS resolver so tests never perform a real lookup. */
  resolveHostname?: HostnameResolver;
}

/** Resolve a hostname to its A/AAAA address strings. Injectable for tests. */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

/** Redirect budget for a single guarded request chain. */
const MAX_GUARDED_REDIRECTS = 8;

export type WebsiteUrlErrorCtor = new (message: string) => Error;

export function assertWebsiteRequestUrl(
  rawUrl: string,
  ErrorType: WebsiteUrlErrorCtor = Error,
  options?: HostGuardOptions,
): void {
  const parsedUrl = new URL(rawUrl);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname.endsWith(".invalid")) {
    throw new ErrorType(`Refusing to fetch reserved invalid hostname: ${parsedUrl.hostname}`);
  }
  if (isForbiddenWebsiteHostname(hostname, options)) {
    throw new ErrorType(`Refusing to fetch non-public website host: ${parsedUrl.hostname}`);
  }
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Resolve-then-validate SSRF guard against DNS rebinding / private-range
 * bypasses. {@link assertWebsiteRequestUrl} only rejects IP-literal and
 * well-known-name hosts; a hostname like `private-host.example.com` that
 * resolves to `10.0.0.1` passes those checks and then fetch connects to the
 * private address. Here we resolve EVERY A/AAAA record and validate each
 * against the same forbidden-range rules, failing CLOSED on an empty answer or
 * resolver error.
 *
 * TOCTOU residual (documented, not fully closable here): Bun's `fetch` exposes
 * no custom `lookup`/agent hook, so we cannot pin the socket to the exact IP we
 * validated — a hostile resolver could return a public IP to this lookup and a
 * private IP microseconds later at connect time (classic rebinding). This still
 * removes the TRIVIAL `hostname A 10.0.0.1` bypass, which is the strongest
 * guarantee available without a pinned-connection fetch API. Re-run on every
 * redirect hop (the crawler recurses through `fetchWebsiteResponse`).
 */
export async function assertResolvedHostAllowed(hostname: string, options?: HostGuardOptions): Promise<void> {
  if (options?.allowPrivateHosts === true) return;
  const bare = stripIpv6Brackets(hostname.toLowerCase());
  // IP-literal hosts are already fully validated by assertWebsiteRequestUrl's
  // range checks; resolving them is a no-op (and dnsLookup would just echo it).
  if (isIP(bare) !== 0) return;

  const resolve = options?.resolveHostname ?? defaultResolveHostname;
  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch {
    throw new Error(`Refusing to fetch ${hostname}: DNS resolution failed`);
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing to fetch ${hostname}: hostname resolved to no addresses`);
  }
  for (const address of addresses) {
    const version = isIP(address);
    const forbidden =
      version === 4 ? isForbiddenIpv4(address) : version === 6 ? isForbiddenIpv6(stripIpv6Brackets(address)) : true;
    if (forbidden) {
      throw new Error(`Refusing to fetch ${hostname}: resolves to non-public or unparseable address ${address}`);
    }
  }
}

// WHATWG URL.hostname wraps IPv6 literals in brackets (e.g. "[::1]"), but
// node:net's isIP() only recognizes the bare address form and returns 0 for
// anything bracketed — silently skipping all IPv6 forbidden-host checks
// below for every hostname parsed off a URL. Strip the brackets before any
// isIP()/isForbiddenIpv6() call so those checks actually run.
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isForbiddenWebsiteHostname(hostname: string, options?: HostGuardOptions): boolean {
  if (options?.allowPrivateHosts === true) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    return true;
  }

  const bareHostname = stripIpv6Brackets(hostname);
  const ipVersion = isIP(bareHostname);
  if (ipVersion === 4) return isForbiddenIpv4(bareHostname);
  if (ipVersion === 6) return isForbiddenIpv6(bareHostname);
  return false;
}

export function isLoopbackWebsiteHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const bareHostname = stripIpv6Brackets(hostname);
  const ipVersion = isIP(bareHostname);
  if (ipVersion === 4) return bareHostname.startsWith("127.");
  if (ipVersion === 6) return bareHostname === "::1";
  return false;
}

function isForbiddenIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d` or its canonical hex form `::ffff:xxxx:yyyy`), or
 * returns null if `hostname` isn't one.
 */
function extractIpv4MappedAddress(normalizedHostname: string): string | null {
  const match = normalizedHostname.match(/^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!match) return null;
  if (match[1]) return match[1];
  const high = Number.parseInt(match[2]!, 16);
  const low = Number.parseInt(match[3]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isForbiddenIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = extractIpv4MappedAddress(normalized);
  if (mappedIpv4) return isForbiddenIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

/**
 * Fetch with the full SSRF guard chain applied to the initial URL and to every
 * redirect hop.
 *
 * `redirect: "manual"` is essential: with the default `follow`, the platform
 * resolves and connects to redirect targets that were never validated, so a
 * public host can bounce a request into the private network.
 */
export async function fetchGuardedResponse(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries?: number } & HostGuardOptions,
  redirectCount = 0,
): Promise<Response> {
  assertWebsiteRequestUrl(url, Error, opts);
  await assertResolvedHostAllowed(new URL(url).hostname, opts);

  const response = await fetchWithRetry(
    url,
    { ...init, redirect: "manual" },
    {
      timeout: opts.timeoutMs,
      retries: opts.retries ?? 1,
    },
  );

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_GUARDED_REDIRECTS) {
      throw new Error(`Too many redirects while fetching ${url}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect response from ${url} did not include a Location header`);
    }
    const nextUrl = new URL(location, url).toString();
    return fetchGuardedResponse(nextUrl, init, opts, redirectCount + 1);
  }

  return response;
}
