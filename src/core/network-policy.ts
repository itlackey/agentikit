// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** DNS capability injected by guarded network boundaries in tests. */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

export type NetworkAddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "reserved"
  | "invalid";

/** WHATWG URL brackets IPv6 literals while node:net expects bare addresses. */
export function bareHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

/** Resolve every A/AAAA record for a hostname. */
export async function resolveHostnameAddresses(hostname: string, resolver?: HostnameResolver): Promise<string[]> {
  const resolve = resolver ?? defaultResolveHostname;
  return resolve(bareHostname(hostname));
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/** Classify a hostname literal or well-known metadata/loopback name. */
export function classifyNetworkHostname(hostname: string): NetworkAddressClass {
  const bare = bareHostname(hostname);
  if (bare === "metadata.google.internal" || bare === "metadata.goog") return "metadata";
  if (bare === "localhost" || bare.endsWith(".localhost")) return "loopback";
  if (bare.endsWith(".invalid")) return "reserved";
  const addressClass = classifyNetworkAddress(bare);
  return addressClass === "invalid" ? "public" : addressClass;
}

/** Classify an IPv4/IPv6 address; non-address strings are `invalid`. */
export function classifyNetworkAddress(address: string): NetworkAddressClass {
  const bare = bareHostname(address);
  const version = isIP(bare);
  if (version === 4) return classifyIpv4(bare);
  if (version === 6) return classifyIpv6(bare);
  return "invalid";
}

function classifyIpv4(address: string): NetworkAddressClass {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a = -1, b = -1, c = -1, d = -1] = parts;
  if (parts.length !== 4 || [a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "invalid";
  }
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return d === 254 && c === 169 ? "metadata" : "link-local";
  if (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) {
    return "reserved";
  }
  return "public";
}

function classifyIpv6(address: string): NetworkAddressClass {
  const words = parseIpv6Words(address);
  const value = ipv6Value(address);
  if (!words || value === null) return "invalid";

  if (value === 0n) return "reserved";
  if (value === 1n) return "loopback";
  const embeddedIpv4 = embeddedIpv4Address(words);
  if (embeddedIpv4) return classifyIpv4(embeddedIpv4);
  if (address.toLowerCase() === "fd00:ec2::254") return "metadata";
  if (inIpv6Range(value, "fc00::", 7)) return "private";
  if (inIpv6Range(value, "fe80::", 10)) return "link-local";
  if (FORBIDDEN_IPV6_RANGES.some(([prefix, bits]) => inIpv6Range(value, prefix, bits))) return "reserved";
  return "public";
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
  ["fec0::", 10],
  ["ff00::", 8],
] as const;

function inIpv6Range(value: bigint, prefix: string, bits: number): boolean {
  const prefixValue = ipv6Value(prefix);
  if (prefixValue === null) return true;
  const shift = BigInt(128 - bits);
  return value >> shift === prefixValue >> shift;
}

function parseIpv6Words(address: string): number[] | null {
  let normalized: string;
  try {
    normalized = bareHostname(new URL(`http://[${bareHostname(address)}]/`).hostname);
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

function ipv6Value(address: string): bigint | null {
  const words = parseIpv6Words(address);
  if (!words) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

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
