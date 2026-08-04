// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchWithRetry, readBodyWithByteCap } from "../../core/common";

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

export interface GuardedResponse {
  response: Response;
  finalUrl: string;
}

/** Redirect budget for a single guarded request chain. */
const MAX_GUARDED_REDIRECTS = 8;

export type WebsiteUrlErrorCtor = new (message: string) => Error;

export function assertWebsiteRequestUrl(
  rawUrl: string,
  ErrorType: WebsiteUrlErrorCtor = Error,
  options?: HostGuardOptions,
): void {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.username || parsedUrl.password) {
    throw new ErrorType(`Refusing to fetch URL with embedded credentials: ${parsedUrl.hostname}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ErrorType(`Refusing to fetch non-http(s) URL on host: ${parsedUrl.hostname}`);
  }
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
  const literalVersion = isIP(bare);
  if (literalVersion !== 0) {
    const forbidden = literalVersion === 4 ? isForbiddenIpv4(bare) : isForbiddenIpv6(bare);
    if (forbidden) throw new Error(`Refusing to fetch non-public website host: ${hostname}`);
    return;
  }

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
  const [a = -1, b = -1, c = -1, d = -1] = parts;
  if (parts.length !== 4 || [a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Words(hostname: string): number[] | null {
  let normalized: string;
  try {
    normalized = stripIpv6Brackets(new URL(`http://[${stripIpv6Brackets(hostname)}]/`).hostname).toLowerCase();
  } catch {
    return null;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = halves.length === 2 ? [...left, ...Array<string>(missing).fill("0"), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv6Value(hostname: string): bigint | null {
  const words = parseIpv6Words(hostname);
  if (!words) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

const FORBIDDEN_IPV6_RANGES = [
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const;

function embeddedIpv4Address(words: number[]): string | null {
  const firstSixZero = words.slice(0, 6).every((word) => word === 0);
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const translated = words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0;
  const wellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (words[0] === 0x2002) return ipv4FromHextets(words[1] ?? 0, words[2] ?? 0);
  if (!firstSixZero && !mapped && !translated && !wellKnownNat64) return null;
  return ipv4FromHextets(words[6] ?? 0, words[7] ?? 0);
}

function ipv4FromHextets(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isForbiddenIpv6(hostname: string): boolean {
  const words = parseIpv6Words(hostname);
  const value = ipv6Value(hostname);
  if (!words || value === null) return true;
  const embeddedIpv4 = embeddedIpv4Address(words);
  if (embeddedIpv4) return isForbiddenIpv4(embeddedIpv4);
  return FORBIDDEN_IPV6_RANGES.some(([prefix, bits]) => {
    const prefixValue = ipv6Value(prefix);
    if (prefixValue === null) return true;
    const shift = BigInt(128 - bits);
    return value >> shift === prefixValue >> shift;
  });
}

function redirectInit(init: RequestInit, currentUrl: string, nextUrl: string): RequestInit {
  if (new URL(currentUrl).origin === new URL(nextUrl).origin) return init;
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return { ...init, headers };
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
): Promise<GuardedResponse> {
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
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Too many redirects while fetching ${url}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect response from ${url} did not include a Location header`);
    }
    await response.body?.cancel().catch(() => undefined);
    const nextUrl = new URL(location, url).toString();
    return fetchGuardedResponse(nextUrl, redirectInit(init, url, nextUrl), opts, redirectCount + 1);
  }

  return { response, finalUrl: url };
}

/** Options for fixed-host API reads that must reject redirects. */
export interface PinnedTextOptions {
  headers: HeadersInit;
  byteCap: number;
  bodyTimeoutMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  retries?: number;
}

export type PinnedJsonOptions = PinnedTextOptions;

/**
 * GET text from a compile-time fixed API host, rejecting redirects so request
 * headers (which may contain a token) can never be forwarded elsewhere.
 */
export async function fetchPinnedText(url: string, options: PinnedTextOptions): Promise<string | null> {
  const response = await fetchWithRetry(
    url,
    { headers: options.headers, signal: options.signal, redirect: "manual" },
    { timeout: options.timeoutMs, retries: options.retries ?? 1 },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return await readBodyWithByteCap(response, options.byteCap, {
      bodyTimeoutMs: options.bodyTimeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return null;
  }
}

/**
 * GET a JSON document from a PINNED, constant API host (X, Bluesky XRPC), with
 * a byte-capped read. Returns the parsed value, or null on any 3xx/non-2xx/
 * parse failure.
 *
 * `redirect: "manual"` + rejecting 3xx is load-bearing: these endpoints have no
 * legitimate reason to redirect, and following one would send the next request
 * (bearer token included) to an unvalidated host with none of the SSRF guards
 * the crawl path applies. The full resolve-then-validate DNS guard is
 * intentionally NOT applied here because the host is a compile-time constant,
 * not caller-supplied — the guarded chokepoint is {@link fetchGuardedResponse},
 * which the caller-supplied crawl/feed paths use instead.
 */
export async function fetchPinnedJson(url: string, options: PinnedJsonOptions): Promise<unknown | null> {
  const body = await fetchPinnedText(url, options);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
