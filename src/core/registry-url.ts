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
const HTTP_SCHEME_START = /h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*(?:s[\t\r\n]*)?:/giu;
const AUTHORITY_PREFIX_SEPARATOR = new Set(["\t", "\r", "\n", "\\", "/"]);
const AUTHORITY_STRUCTURAL_BOUNDARY = new Set(["\\", "/", "?", "#"]);
const AUTHORITY_AMBIGUOUS_BOUNDARY = new Set(["&", ",", ";", ")"]);
const AUTHORITY_SOFT_BOUNDARY = new Set(["\t", "\r", "\n", " ", '"', "'", "`", "<", ">"]);
const STRICT_MAX_DEPTH = 8;
const STRICT_MAX_CANDIDATES = 128;
const STRICT_MAX_DECODED_BYTES = 65_536;
const HTTP_SCHEME_EVIDENCE = /h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*(?:s[\t\r\n]*)?:/iu;

type RegistryUrlScanMode = "strict" | "diagnostic";

interface RegistryUrlStart {
  start: number;
  authorityStart: number;
}

interface UserinfoSpan {
  start: number;
  end: number;
}

type StrictInspectionReason = "credentials" | "malformed-encoding" | "inspection-limit";

interface StrictInspection {
  unsafe: boolean;
  reason?: StrictInspectionReason;
}

interface StrictWalkState {
  candidates: number;
  decodedBytes: number;
  reason?: StrictInspectionReason;
}

interface PercentDecodeResult {
  value: string;
  valid: boolean;
}

/**
 * Detect URL userinfo without broadening this issue into general URL/network
 * validation (the SSRF/redirect boundary is tracked separately in #767).
 * Whole configured values use WHATWG parsing; strict bounded scanning catches
 * nested, control-obfuscated, and special-scheme URL starts. Free-text error
 * sanitization uses the separate conservative mode below.
 */
export function hasRegistryUrlCredentials(raw: string): boolean {
  return inspectStrictRegistryUrl(raw).unsafe;
}

/**
 * The only formatter for configured registry URLs. Credential-free valid URLs
 * retain their authored spelling; userinfo is removed structurally. Invalid
 * strings fail closed rather than being echoed into a diagnostic.
 */
export function formatRegistryUrl(raw: string): string {
  const parsed = parseWholeHttpUrl(raw);
  const inspection = inspectStrictRegistryUrl(raw);
  if (parsed) {
    if (!inspection.unsafe) return raw;

    let candidate = raw;
    if (parsed.username || parsed.password) {
      // A whole configured value is unambiguous. Always clear WHATWG userinfo
      // structurally; textual deletion can otherwise stop at the first of
      // several `@` characters and leave the real credential behind.
      parsed.username = "";
      parsed.password = "";
      candidate = parsed.toString();
    }

    candidate = redactDetectedUserinfo(candidate, "strict");
    return inspectStrictRegistryUrl(candidate).unsafe ? INVALID_REGISTRY_URL_LABEL : candidate;
  }

  const formatted = redactDetectedUserinfo(raw, "strict");
  if (
    inspection.unsafe &&
    registryUrlStarts(raw)[0]?.start === 0 &&
    formatted !== raw &&
    !inspectStrictRegistryUrl(formatted).unsafe
  ) {
    return formatted;
  }
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
  return redactDetectedUserinfo(message, "diagnostic");
}

/** Fetch errors are untrusted: runtimes often include the request URL. */
export function formatRegistryError(error: unknown): string {
  return redactCredentialBearingUrls(toErrorMessage(error));
}

/**
 * Configured/provider registry values are not prose. Inspect their URL
 * structure recursively so encoded nested URLs cannot bypass validation,
 * while keeping arbitrary diagnostic tokenization deliberately conservative.
 */
function inspectStrictRegistryUrl(raw: string): StrictInspection {
  const parsed = parseWholeHttpUrl(raw);
  if (!parsed) {
    const unsafe = registryUrlStarts(raw).some((start) => findStrictComponentUserinfoSpan(raw, start) !== undefined);
    return unsafe ? { unsafe: true, reason: "credentials" } : { unsafe: false };
  }

  const state: StrictWalkState = { candidates: 0, decodedBytes: 0 };
  inspectParsedStrictUrl(parsed, state, 0);
  return state.reason ? { unsafe: true, reason: state.reason } : { unsafe: false };
}

function inspectParsedStrictUrl(parsed: URL, state: StrictWalkState, depth: number): void {
  if (state.reason) return;
  if (parsed.username || parsed.password) {
    state.reason = "credentials";
    return;
  }

  inspectAuthoredStrictComponent(parsed.pathname, state, depth, false);
  if (state.reason) return;

  // Inspect each authored query key/value independently. This mirrors
  // URLSearchParams' first decoding layer while retaining whether a delimiter
  // was structural (`&`) or encoded data (`%26`) inside one value.
  const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
  for (const pair of rawQuery.split("&")) {
    const equals = pair.indexOf("=");
    const rawKey = equals >= 0 ? pair.slice(0, equals) : pair;
    const rawValue = equals >= 0 ? pair.slice(equals + 1) : "";
    inspectAuthoredStrictComponent(rawKey, state, depth, true);
    inspectAuthoredStrictComponent(rawValue, state, depth, true);
    if (state.reason) return;
  }

  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  inspectAuthoredStrictComponent(fragment, state, depth, false);
}

function inspectAuthoredStrictComponent(
  raw: string,
  state: StrictWalkState,
  depth: number,
  queryEncoded: boolean,
): void {
  for (const authoredPart of splitAuthoredFieldComponents(raw)) {
    let component = authoredPart;
    if (queryEncoded) {
      const decoded = decodePercentSafely(authoredPart, "query");
      if (!decoded.valid && hasCredentialLikeUrlEvidence(authoredPart)) {
        state.reason = "malformed-encoding";
        return;
      }
      component = decoded.value;
    }
    inspectStrictComponent(component, state, depth);
    if (state.reason) return;
  }
}

function inspectStrictComponent(raw: string, state: StrictWalkState, depth: number): void {
  if (state.reason || raw.length === 0) return;

  let decoded = raw;
  let currentDepth = depth;
  const seenCandidateKeys = new Set<string>();
  while (true) {
    const starts = registryUrlStarts(decoded);
    if (starts.length > 0) {
      const unseenIndices = unseenCandidateIndices(decoded, starts, seenCandidateKeys);
      const percentFullyCovered = inspectStrictUrlCandidates(decoded, starts, unseenIndices, state, currentDepth);
      if (state.reason) return;
      if (percentFullyCovered) return;
    }

    if (!decoded.includes("%")) return;
    if (currentDepth >= STRICT_MAX_DEPTH) {
      if (looksLikeStrictUrlComponent(decoded)) state.reason = "inspection-limit";
      return;
    }

    const next = decodePercentSafely(decoded, "component");
    if (!next.valid) {
      if (hasCredentialLikeUrlEvidence(decoded)) state.reason = "malformed-encoding";
      return;
    }
    if (next.value === decoded) return;
    decoded = next.value;
    currentDepth++;
  }
}

function unseenCandidateIndices(
  decoded: string,
  starts: RegistryUrlStart[],
  seenCandidateKeys: Set<string>,
): Set<number> {
  const occurrences = new Map<string, number>();
  const unseen = new Set<number>();
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    if (!start) continue;
    const authority = strictAuthoritySlice(decoded.slice(start.start));
    const occurrence = (occurrences.get(authority) ?? 0) + 1;
    occurrences.set(authority, occurrence);
    const key = `${authority}\u0000${occurrence}`;
    if (seenCandidateKeys.has(key)) continue;
    seenCandidateKeys.add(key);
    unseen.add(index);
  }
  return unseen;
}

function inspectStrictUrlCandidates(
  decoded: string,
  starts: RegistryUrlStart[],
  unseenIndices: Set<number>,
  state: StrictWalkState,
  depth: number,
): boolean {
  const recursivelyInspectedRanges: Array<{ start: number; end: number }> = [];
  const bytes = new TextEncoder().encode(decoded).byteLength;
  if (bytes > STRICT_MAX_DECODED_BYTES - state.decodedBytes) {
    state.reason = "inspection-limit";
    return false;
  }
  state.decodedBytes += bytes;

  if (unseenIndices.size > STRICT_MAX_CANDIDATES - state.candidates) {
    state.reason = "inspection-limit";
    return false;
  }
  state.candidates += unseenIndices.size;

  for (const start of starts) {
    if (findStrictComponentUserinfoSpan(decoded, start)) {
      state.reason = "credentials";
      return false;
    }
  }

  for (let index = 0; index < starts.length; index++) {
    if (!unseenIndices.has(index)) continue;
    const start = starts[index];
    if (!start) continue;

    const nextStart = starts[index + 1]?.start ?? decoded.length;
    const candidate = trimStrictCandidateSuffix(decoded.slice(start.start, nextStart));
    const candidateDepth = inspectDecodedCandidateUserinfo(candidate, state, depth);
    if (state.reason) return false;

    if (candidateDepth >= STRICT_MAX_DEPTH) {
      state.reason = "inspection-limit";
      return false;
    }

    const parsed = parseWholeHttpUrl(candidate);
    if (!parsed) continue;

    // A later query/list email can make WHATWG interpret surrounding prose as
    // userinfo. Trust that interpretation only when the component-bounded
    // authority scan above found the same userinfo.
    if (parsed.username || parsed.password) continue;
    inspectParsedStrictUrl(parsed, state, candidateDepth + 1);
    if (state.reason) return false;
    recursivelyInspectedRanges.push({ start: start.start, end: nextStart });
  }

  return everyPercentEscapeIsCovered(decoded, recursivelyInspectedRanges);
}

function everyPercentEscapeIsCovered(raw: string, ranges: Array<{ start: number; end: number }>): boolean {
  for (let cursor = raw.indexOf("%"); cursor >= 0; cursor = raw.indexOf("%", cursor + 1)) {
    if (!ranges.some((range) => cursor >= range.start && cursor < range.end)) return false;
  }
  return true;
}

function inspectDecodedCandidateUserinfo(raw: string, state: StrictWalkState, depth: number): number {
  let decoded = strictAuthoritySlice(raw);
  let currentDepth = depth;
  while (true) {
    if (registryUrlStarts(decoded).some((start) => findStrictComponentUserinfoSpan(decoded, start))) {
      state.reason = "credentials";
      return currentDepth;
    }
    if (!decoded.includes("%")) return currentDepth;
    if (currentDepth >= STRICT_MAX_DEPTH) {
      state.reason = "inspection-limit";
      return currentDepth;
    }

    const next = decodePercentSafely(decoded, "component");
    if (!next.valid) {
      if (hasCredentialLikeUrlEvidence(decoded)) state.reason = "malformed-encoding";
      return currentDepth;
    }
    if (next.value === decoded) return currentDepth;
    decoded = strictAuthoritySlice(next.value);
    currentDepth++;
  }
}

function strictAuthoritySlice(raw: string): string {
  const start = registryUrlStarts(raw)[0];
  if (!start) return raw;
  let end = raw.length;
  for (let cursor = start.authorityStart; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char && AUTHORITY_STRUCTURAL_BOUNDARY.has(char)) {
      end = cursor;
      break;
    }
  }
  return raw.slice(start.start, end);
}

function decodePercentSafely(raw: string, mode: "component" | "query"): PercentDecodeResult {
  const input = mode === "query" ? raw.replaceAll("+", "%20") : raw;
  let valid = true;
  let value = raw;
  try {
    value = decodeURIComponent(input);
  } catch {
    valid = false;
  }

  if (mode === "query") {
    return { value: new URLSearchParams(`value=${raw}`).get("value") ?? "", valid };
  }
  if (!valid) return { value: raw, valid: false };
  return { value, valid: true };
}

function splitAuthoredFieldComponents(raw: string): string[] {
  const parts: string[] = [];
  let partStart = 0;
  for (let cursor = 0; cursor < raw.length; cursor++) {
    const delimiter = raw[cursor];
    if (!delimiter || !AUTHORITY_AMBIGUOUS_BOUNDARY.has(delimiter)) continue;
    if (!/^[a-z0-9_.-]+=/iu.test(raw.slice(cursor + 1))) continue;

    const prefix = raw.slice(partStart, cursor);
    const starts = registryUrlStarts(prefix);
    const lastStart = starts.at(-1);
    if (!lastStart) continue;
    const candidate = trimStrictCandidateSuffix(prefix.slice(lastStart.start));
    const parsed = parseWholeHttpUrl(candidate);
    if (!parsed || parsed.username || parsed.password || !looksLikeDiagnosticHostPrefix(parsed.hostname)) continue;

    parts.push(raw.slice(partStart, cursor));
    partStart = cursor + 1;
  }
  parts.push(raw.slice(partStart));
  return parts;
}

function findStrictComponentUserinfoSpan(raw: string, urlStart: RegistryUrlStart): UserinfoSpan | undefined {
  const conventional = findUserinfoSpan(raw, urlStart, "strict");
  if (conventional) return conventional;

  const { authorityStart } = urlStart;
  let lastAt = -1;
  for (let cursor = authorityStart; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char === undefined || AUTHORITY_STRUCTURAL_BOUNDARY.has(char)) break;
    if (char === "@" && cursor > authorityStart) lastAt = cursor;
  }
  if (lastAt <= authorityStart) return undefined;

  const prefix = raw.slice(authorityStart, lastAt);
  const ambiguousBoundary = Array.from(prefix).findIndex((char) => AUTHORITY_AMBIGUOUS_BOUNDARY.has(char));
  if (ambiguousBoundary < 0) return undefined;
  return { start: authorityStart, end: lastAt + 1 };
}

function trimStrictCandidateSuffix(raw: string): string {
  return raw.replace(/[\t\r\n ]+$/u, "").replace(/[,&;]+$/u, "");
}

function hasCredentialLikeUrlEvidence(raw: string): boolean {
  const evidence = decodePercentForEvidence(raw);
  return HTTP_SCHEME_EVIDENCE.test(stripMalformedPercentForEvidence(evidence)) && evidence.includes("@");
}

function looksLikeStrictUrlComponent(raw: string): boolean {
  const evidence = decodePercentForEvidence(raw);
  return HTTP_SCHEME_EVIDENCE.test(stripMalformedPercentForEvidence(evidence));
}

function decodePercentForEvidence(raw: string): string {
  let decoded = raw;
  for (let layer = 0; layer <= STRICT_MAX_DEPTH; layer++) {
    const next = decoded.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function stripMalformedPercentForEvidence(raw: string): string {
  return raw.replace(/%[^%]{0,2}/gu, "");
}

function redactDetectedUserinfo(raw: string, mode: RegistryUrlScanMode): string {
  let formatted = raw;
  const starts = registryUrlStarts(raw);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i];
    if (start === undefined) continue;
    const span = findUserinfoSpan(formatted, start, mode);
    if (!span) continue;
    formatted = `${formatted.slice(0, span.start)}${formatted.slice(span.end)}`;
  }
  return formatted;
}

function registryUrlStarts(raw: string): RegistryUrlStart[] {
  return Array.from(raw.matchAll(HTTP_SCHEME_START), (match) => {
    let authorityStart = match.index + match[0].length;
    while (authorityStart < raw.length && AUTHORITY_PREFIX_SEPARATOR.has(raw[authorityStart] ?? "")) {
      authorityStart++;
    }
    return { start: match.index, authorityStart };
  });
}

function findUserinfoSpan(
  raw: string,
  urlStart: RegistryUrlStart,
  mode: RegistryUrlScanMode,
): UserinfoSpan | undefined {
  const { authorityStart } = urlStart;
  let crossedAmbiguousBoundary = false;
  let lastAt = -1;
  for (let cursor = authorityStart; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char === undefined) return undefined;
    if (char === "@") {
      if (cursor > authorityStart) lastAt = cursor;
      continue;
    }
    if (AUTHORITY_STRUCTURAL_BOUNDARY.has(char)) return userinfoSpan(authorityStart, lastAt);

    const isSoftBoundary = AUTHORITY_SOFT_BOUNDARY.has(char);
    const isAmbiguousBoundary = AUTHORITY_AMBIGUOUS_BOUNDARY.has(char);
    if (!isSoftBoundary && !isAmbiguousBoundary) continue;
    if (mode === "diagnostic" && cursor === authorityStart && isSoftBoundary) return undefined;
    if (lastAt >= 0 && mode === "diagnostic") {
      const apparentHost = raw.slice(lastAt + 1, cursor);
      if (looksLikeDiagnosticHostPrefix(apparentHost)) return userinfoSpan(authorityStart, lastAt);
    }
    if (crossedAmbiguousBoundary) continue;

    const prefix = raw.slice(authorityStart, cursor);
    // Strict configured/provider handling crosses soft delimiters even after a
    // host-shaped username: WHATWG accepts those values as nested userinfo.
    // Conservative free-text handling stops at an apparent host so a later
    // ordinary email is not consumed. Ambiguous query/list punctuation still
    // requires an explicit username:password prefix in either mode.
    if (
      (mode === "diagnostic" && looksLikeDiagnosticHostPrefix(prefix)) ||
      (isAmbiguousBoundary && !prefix.includes(":"))
    ) {
      return userinfoSpan(authorityStart, lastAt);
    }
    crossedAmbiguousBoundary = true;
  }
  return userinfoSpan(authorityStart, lastAt);
}

function userinfoSpan(authorityStart: number, lastAt: number): UserinfoSpan | undefined {
  return lastAt > authorityStart ? { start: authorityStart, end: lastAt + 1 } : undefined;
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
