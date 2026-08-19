// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { toErrorMessage } from "./common";

/** Structural subset shared by config, providers, diagnostics, and output. */
export interface RegistryUrlDescriptor {
  url: string;
  name?: string;
}

export const REGISTRY_CREDENTIALS_UNSUPPORTED =
  "Registry URLs must not include username or password credentials. Authenticated registries are not supported by the built-in static-index or skills-sh providers; configure a credential-free HTTPS endpoint.";

const INVALID_REGISTRY_URL_LABEL = "(invalid registry URL)";
const URL_START_WITH_CONTROLS = /h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*(?:s[\t\r\n]*)?:[\t\r\n]*\/[\t\r\n]*\//giu;
const AUTHORITY_STRUCTURAL_BOUNDARY = new Set(["\\", "/", "?", "#"]);
const AUTHORITY_AMBIGUOUS_BOUNDARY = new Set(["&", ",", ";", ")"]);
const AUTHORITY_SOFT_BOUNDARY = new Set(["\t", "\r", "\n", " ", '"', "'", "`", "<", ">"]);

interface RegistryUrlStart {
  start: number;
  schemeEnd: number;
}

interface UserinfoSpan {
  start: number;
  end: number;
}

/**
 * Detect URL userinfo without broadening this issue into general URL/network
 * validation (the SSRF/redirect boundary is tracked separately in #767).
 * Whole configured values use WHATWG parsing; a separate bounded scan catches
 * nested or control-obfuscated URL starts without absorbing later diagnostics.
 */
export function hasRegistryUrlCredentials(raw: string): boolean {
  const parsed = parseWholeHttpUrl(raw);
  if (parsed && (parsed.username.length > 0 || parsed.password.length > 0)) return true;
  return registryUrlStarts(raw).some((start) => findUserinfoSpan(raw, start) !== undefined);
}

/**
 * The only formatter for configured registry URLs. Credential-free valid URLs
 * retain their authored spelling; userinfo is removed structurally. Invalid
 * strings fail closed rather than being echoed into a diagnostic.
 */
export function formatRegistryUrl(raw: string): string {
  const parsed = parseWholeHttpUrl(raw);
  const formatted = redactDetectedUserinfo(raw);
  if (parsed) {
    if ((parsed.username || parsed.password) && formatted === raw) {
      // Structural scanning is deliberately conservative at diagnostic token
      // boundaries. A whole configured URL is unambiguous, so canonicalize as
      // a final fail-closed fallback if WHATWG found userinfo that scanning did not.
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return formatted;
  }
  if (registryUrlStarts(raw)[0]?.start === 0 && formatted !== raw) return formatted;
  return INVALID_REGISTRY_URL_LABEL;
}

/** A consistent human label built on the safe URL formatter. */
export function formatRegistryLabel(entry: RegistryUrlDescriptor): string {
  const url = formatRegistryUrl(entry.url);
  return entry.name ? `${entry.name} (${url})` : url;
}

/** Actionable fail-closed warning for runtime inputs that bypass config load. */
export function formatRegistryCredentialWarning(entry: RegistryUrlDescriptor): string {
  return `Registry ${formatRegistryLabel(entry)} was ignored. ${REGISTRY_CREDENTIALS_UNSUPPORTED}`;
}

/** Copy a registry entry for any structured-output boundary. */
export function registryEntryForOutput<T extends RegistryUrlDescriptor>(entry: T): T {
  return { ...entry, url: formatRegistryUrl(entry.url) };
}

/**
 * Remove userinfo from every HTTP(S) URL token in an untrusted error/warning
 * string while leaving ordinary credential-free query/path text untouched.
 */
export function redactCredentialBearingUrls(message: string): string {
  return redactDetectedUserinfo(message);
}

/** Fetch errors are untrusted: runtimes often include the request URL. */
export function formatRegistryError(error: unknown): string {
  return redactCredentialBearingUrls(toErrorMessage(error));
}

function redactDetectedUserinfo(raw: string): string {
  let formatted = raw;
  const starts = registryUrlStarts(raw);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i];
    if (start === undefined) continue;
    const span = findUserinfoSpan(formatted, start);
    if (!span) continue;
    formatted = `${formatted.slice(0, span.start)}${formatted.slice(span.end)}`;
  }
  return formatted;
}

function registryUrlStarts(raw: string): RegistryUrlStart[] {
  return Array.from(raw.matchAll(URL_START_WITH_CONTROLS), (match) => ({
    start: match.index,
    schemeEnd: match.index + match[0].length,
  }));
}

function findUserinfoSpan(raw: string, urlStart: RegistryUrlStart): UserinfoSpan | undefined {
  const authorityStart = urlStart.schemeEnd;
  let crossedAmbiguousBoundary = false;
  for (let cursor = authorityStart; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char === undefined) return undefined;
    if (char === "@") {
      return cursor > authorityStart ? { start: authorityStart, end: cursor + 1 } : undefined;
    }
    if (AUTHORITY_STRUCTURAL_BOUNDARY.has(char)) return undefined;

    const isSoftBoundary = AUTHORITY_SOFT_BOUNDARY.has(char);
    const isAmbiguousBoundary = AUTHORITY_AMBIGUOUS_BOUNDARY.has(char);
    if (!isSoftBoundary && !isAmbiguousBoundary) continue;
    if (crossedAmbiguousBoundary) continue;

    // These characters can be WHATWG userinfo, but also delimit diagnostic
    // text or a nested URL. A host-shaped prefix wins as a token boundary.
    // Otherwise soft punctuation can continue username-only userinfo, while
    // &, comma, semicolon, and ) require an explicit username:password prefix.
    const prefix = raw.slice(authorityStart, cursor);
    if (looksLikeDiagnosticHostPrefix(prefix) || (isAmbiguousBoundary && !prefix.includes(":"))) return undefined;
    crossedAmbiguousBoundary = true;
  }
  return undefined;
}

function looksLikeDiagnosticHostPrefix(raw: string): boolean {
  if (raw.startsWith("[")) return true;
  const hostname = raw.split(":", 1)[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname.startsWith("xn--") || hostname.includes(".");
}

function parseWholeHttpUrl(raw: string): URL | undefined {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
