// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { bareHostname } from "../core/network-policy";
import { nodePinnedRequestHelperSource } from "./pinned-request-helper";

const MAX_HELPER_PRELUDE_BYTES = 64 * 1024;
const MAX_HELPER_FRAME_BYTES = 1024 * 1024;
const MAX_HELPER_STDERR_BYTES = 8 * 1024;
const MAX_REGISTRY_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const FRAME_PRELUDE = 0;
const FRAME_BODY = 1;
const FRAME_END = 2;
const FRAME_ERROR = 3;

/** One HTTP(S) request whose socket is pinned to an already-validated address. */
export type RegistryPinnedRequest = (
  url: URL,
  address: string,
  init: RequestInit | undefined,
  timeoutMs: number,
) => Promise<Response>;

interface PreparedRequest {
  method: string;
  headers: Headers;
  body?: Uint8Array | ReadableStream<Uint8Array>;
}

interface HelperResponsePrelude {
  status: number;
  statusText: string;
  rawHeaders: string[];
}

export interface RegistryPinnedTransportTestOptions {
  /** Local-CA proof seam; registry composition never supplies this. */
  ca?: string | Buffer;
  /** Test-only executable override; null proves the fail-closed path. */
  nodeExecutable?: string | null;
  /** Inspection seam proving secrets never enter argv or the helper environment. */
  onHelperSpawn?: (details: {
    executable: string;
    args: string[];
    env: Record<string, string>;
    directory: string;
    pid: number | undefined;
  }) => void;
}

export class RegistryPinnedTransportError extends Error {
  readonly code = "REGISTRY_PINNED_TRANSPORT" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryPinnedTransportError";
  }
}

/**
 * Connect to `address` while retaining the URL hostname for Host, TLS SNI, and
 * certificate verification. Node uses a request-level pinned lookup. Bun uses
 * the same Node transport in a fresh one-request helper because Bun's TLS
 * client currently drops SNI when the connection is pinned to a numeric IP.
 */
export async function requestRegistryAddressPinned(
  url: URL,
  address: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  testOptions?: RegistryPinnedTransportTestOptions,
): Promise<Response> {
  if (isIP(address) === 0) throw new Error(`Pinned registry address is not an IP literal: ${address}`);
  const nodeExecutable = process.versions.bun ? resolveNodeExecutable(testOptions?.nodeExecutable) : undefined;
  assertNodeRuntimeVersion();
  const prepared = await prepareRequest(url, init);
  if (process.versions.bun) {
    if (!nodeExecutable) throw new RegistryPinnedTransportError("Pinned registry Node helper is unavailable");
    return requestWithNodeHelper(url, address, prepared, init, timeoutMs, nodeExecutable, testOptions);
  }
  return requestWithNodePinnedLookup(url, address, prepared, init, timeoutMs, testOptions);
}

/** Fail before DNS or socket activity when this runtime cannot provide the pinned transport. */
export function assertRegistryPinnedTransportAvailable(): void {
  if (process.versions.bun) {
    resolveNodeExecutable(undefined);
    return;
  }
  assertNodeRuntimeVersion();
}

async function requestWithNodePinnedLookup(
  url: URL,
  address: string,
  prepared: PreparedRequest,
  init: RequestInit | undefined,
  timeoutMs: number,
  testOptions: RegistryPinnedTransportTestOptions | undefined,
): Promise<Response> {
  const hostname = bareHostname(url.hostname);
  const requestOptions: RequestOptions & { servername?: string; ca?: string | Buffer } = {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: prepared.method,
    headers: requestHeaders(prepared.headers, url),
    lookup: pinnedLookup(address),
    // Never reuse a connection selected for an earlier DNS answer.
    agent: false,
    signal: init?.signal ?? undefined,
  };
  if (url.protocol === "https:" && isIP(hostname) === 0) {
    requestOptions.servername = hostname;
    if (testOptions?.ca) requestOptions.ca = testOptions.ca;
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const requestFn = url.protocol === "https:" ? https.request : http.request;
    const request = requestFn(requestOptions, (incoming) => {
      if (settled) {
        incoming.destroy();
        return;
      }
      settled = true;
      if (headerTimer) clearTimeout(headerTimer);
      resolve(responseFromIncoming(incoming, prepared.method, init?.signal));
    });
    headerTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Registry request timed out after ${timeoutMs}ms while awaiting response headers`);
      reject(error);
      request.destroy(error);
    }, timeoutMs);
    request.once("error", (error) => {
      if (headerTimer) clearTimeout(headerTimer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    writeRequestBody(request, prepared.body).catch((error) => request.destroy(error as Error));
  });
}

async function requestWithNodeHelper(
  url: URL,
  address: string,
  prepared: PreparedRequest,
  init: RequestInit | undefined,
  timeoutMs: number,
  executable: string,
  testOptions: RegistryPinnedTransportTestOptions | undefined,
): Promise<Response> {
  const artifacts = createHelperArtifacts(testOptions?.ca);
  const env = helperEnvironment(artifacts.caPath);
  const args = [artifacts.helperPath];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executable, args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    artifacts.cleanup();
    throw new RegistryPinnedTransportError("Unable to start the pinned registry Node helper", { cause: error });
  }
  try {
    testOptions?.onHelperSpawn?.({
      executable,
      args: [...args],
      env: { ...env },
      directory: artifacts.directory,
      pid: child.pid,
    });
  } catch (error) {
    child.kill("SIGKILL");
    artifacts.cleanup();
    throw error;
  }

  let promiseSettled = false;
  let responseProduced = false;
  let protocolTerminal = false;
  let childKilled = false;
  let consumerCancelled = false;
  const rawBody = new PassThrough();
  const stderr = collectLimitedStderr(child.stderr).catch(() => "");
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.then(artifacts.cleanup, artifacts.cleanup);

  const killChild = (): void => {
    if (childKilled || child.exitCode !== null || child.signalCode !== null) return;
    childKilled = true;
    child.kill("SIGKILL");
  };
  const abortReason = (): Error => {
    const reason = init?.signal?.reason;
    return reason instanceof Error ? reason : new Error("Registry request aborted");
  };

  return new Promise<Response>((resolve, reject) => {
    const rejectBeforeResponse = (error: unknown): void => {
      if (responseProduced) {
        if (!rawBody.destroyed) rawBody.destroy(asTransportError(error));
        return;
      }
      if (promiseSettled) return;
      promiseSettled = true;
      reject(asTransportError(error));
    };
    const onAbort = (): void => {
      const error = abortReason();
      killChild();
      rejectBeforeResponse(error);
    };
    if (init?.signal?.aborted) {
      onAbort();
      return;
    }
    init?.signal?.addEventListener("abort", onAbort, { once: true });

    const headerTimer = setTimeout(() => {
      const error = new RegistryPinnedTransportError(
        `Registry request timed out after ${timeoutMs}ms while awaiting response headers`,
      );
      killChild();
      rejectBeforeResponse(error);
    }, timeoutMs);

    void writeHelperRequest(child, url, address, prepared, timeoutMs).catch((error) => {
      if (protocolTerminal || promiseSettled) return;
      killChild();
      rejectBeforeResponse(error);
    });

    void pumpHelperFrames(child.stdout, rawBody, exited, {
      onPrelude: (prelude) => {
        if (responseProduced) throw new RegistryPinnedTransportError("Registry helper sent more than one prelude");
        if (promiseSettled) throw new RegistryPinnedTransportError("Registry helper responded after the request ended");
        responseProduced = true;
        promiseSettled = true;
        clearTimeout(headerTimer);
        const response = responseFromRaw(rawBody, prelude, prepared.method, init?.signal, () => {
          consumerCancelled = true;
          if (!protocolTerminal) killChild();
        });
        resolve(response);
      },
      onTerminal: () => {
        protocolTerminal = true;
      },
    })
      .catch(async (error) => {
        clearTimeout(headerTimer);
        killChild();
        if (consumerCancelled || init?.signal?.aborted) {
          if (!promiseSettled) rejectBeforeResponse(abortReason());
          return;
        }
        // Always drain but never surface helper stderr: a failed executable
        // could echo the private stdin request, including authorization.
        await stderr;
        rejectBeforeResponse(new RegistryPinnedTransportError(asErrorMessage(error), { cause: error }));
      })
      .finally(() => {
        clearTimeout(headerTimer);
        init?.signal?.removeEventListener("abort", onAbort);
      });
  });
}

function resolveNodeExecutable(override: string | null | undefined): string {
  if (override === null) {
    throw new RegistryPinnedTransportError(
      "Pinned registry networking under Bun requires Node.js >= 24 on PATH; no Node executable is available",
    );
  }
  const candidates =
    override === undefined
      ? (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, process.platform === "win32" ? "node.exe" : "node"))
      : [override];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = fs.realpathSync(candidate);
      if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      if (override === undefined && !isSupportedNodeExecutable(resolved)) continue;
      return resolved;
    } catch {
      // Try the next PATH entry. The helper itself enforces Node >= 24.
    }
  }
  throw new RegistryPinnedTransportError(
    "Pinned registry networking under Bun requires Node.js >= 24 on PATH. Install Node.js or run akm with Node.",
  );
}

function isSupportedNodeExecutable(executable: string): boolean {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: helperEnvironment(undefined),
    maxBuffer: 1_024,
    shell: false,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  const match = /^v(\d+)\./.exec(result.stdout.trim());
  const major = match?.[1];
  return major !== undefined && Number.parseInt(major, 10) >= 24;
}

function assertNodeRuntimeVersion(): void {
  if (process.versions.bun) return;
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new RegistryPinnedTransportError(
      `Pinned registry networking requires Node.js >= 24; found ${process.versions.node}`,
    );
  }
}

interface HelperArtifacts {
  directory: string;
  helperPath: string;
  caPath?: string;
  cleanup: () => void;
}

function createHelperArtifacts(ca: string | Buffer | undefined): HelperArtifacts {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-registry-helper-"));
  fs.chmodSync(directory, 0o700);
  const helperPath = path.join(directory, "request.mjs");
  const caPath = ca === undefined ? undefined : path.join(directory, "ca.pem");
  const cleanup = (): void => {
    for (const file of [helperPath, caPath]) {
      if (!file) continue;
      try {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat?.isFile()) fs.unlinkSync(file);
      } catch {
        // A private one-request directory is best-effort cleanup after exit.
      }
    }
    try {
      fs.rmdirSync(directory);
    } catch {
      // Preserve unexpected contents for diagnosis; never recurse here.
    }
  };
  try {
    const source = nodePinnedRequestHelperSource();
    fs.writeFileSync(helperPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (caPath && ca !== undefined) fs.writeFileSync(caPath, ca, { flag: "wx", mode: 0o600 });
    for (const file of [helperPath, caPath]) {
      if (!file) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new RegistryPinnedTransportError("Registry helper artifact is not a regular file");
    }
    return { directory, helperPath, caPath, cleanup };
  } catch (error) {
    cleanup();
    if (error instanceof RegistryPinnedTransportError) throw error;
    throw new RegistryPinnedTransportError("Unable to prepare the pinned registry Node helper", { cause: error });
  }
}

function helperEnvironment(caPath: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;
  return env;
}

async function writeHelperRequest(
  child: ChildProcessWithoutNullStreams,
  url: URL,
  address: string,
  prepared: PreparedRequest,
  timeoutMs: number,
): Promise<void> {
  const prelude = Buffer.from(
    JSON.stringify({
      url: url.toString(),
      address,
      method: prepared.method,
      headers: [...prepared.headers.entries()],
      timeoutMs,
      bodyPresent: prepared.body !== undefined,
    }),
  );
  if (prelude.byteLength === 0 || prelude.byteLength > MAX_HELPER_PRELUDE_BYTES) {
    throw new RegistryPinnedTransportError("Registry helper request prelude exceeds its protocol limit");
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(prelude.byteLength, 0);
  await writeNodeChunk(child.stdin, length);
  await writeNodeChunk(child.stdin, prelude);
  if (prepared.body instanceof Uint8Array) {
    await writeNodeChunk(child.stdin, prepared.body);
  } else if (prepared.body) {
    for await (const chunk of Readable.fromWeb(prepared.body as never)) {
      await writeNodeChunk(child.stdin, Buffer.from(chunk));
    }
  }
  await endNodeWritable(child.stdin);
}

async function writeNodeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function endNodeWritable(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

async function pumpHelperFrames(
  stdout: Readable,
  rawBody: PassThrough,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  callbacks: { onPrelude: (prelude: HelperResponsePrelude) => void; onTerminal: () => void },
): Promise<void> {
  const iterator = stdout[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const readExact = async (length: number): Promise<Buffer> => {
    while (buffered.byteLength < length) {
      const next = await iterator.next();
      if (next.done) throw new RegistryPinnedTransportError("Registry helper output ended before a terminal frame");
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  };

  let sawPrelude = false;
  while (true) {
    const frameHeader = await readExact(5);
    const type = frameHeader[0];
    const length = frameHeader.readUInt32BE(1);
    const limit = type === FRAME_BODY ? MAX_HELPER_FRAME_BYTES : MAX_HELPER_PRELUDE_BYTES;
    if (length > limit) throw new RegistryPinnedTransportError("Registry helper frame exceeds its protocol limit");
    const payload = await readExact(length);
    if (type === FRAME_PRELUDE) {
      if (sawPrelude) throw new RegistryPinnedTransportError("Registry helper sent duplicate response metadata");
      const prelude = parseHelperPrelude(payload);
      sawPrelude = true;
      callbacks.onPrelude(prelude);
      // A HEAD or null-body status cancels the transport synchronously from
      // the prelude callback. Do not consume any body frames already buffered
      // behind that prelude or wait for a helper that has been terminated.
      if (rawBody.destroyed) return;
      continue;
    }
    if (type === FRAME_BODY) {
      if (!sawPrelude)
        throw new RegistryPinnedTransportError("Registry helper sent body data before response metadata");
      if (payload.byteLength > 0 && !rawBody.write(payload)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => {
            cleanup();
            resolve();
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(error);
          };
          const cleanup = (): void => {
            rawBody.off("drain", onDrain);
            rawBody.off("error", onError);
          };
          rawBody.once("drain", onDrain);
          rawBody.once("error", onError);
        });
      }
      continue;
    }
    if (type === FRAME_END) {
      if (!sawPrelude || length !== 0)
        throw new RegistryPinnedTransportError("Registry helper sent an invalid end frame");
      const result = await exited;
      if (result.code !== 0 || result.signal) {
        throw new RegistryPinnedTransportError(
          `Registry helper exited unexpectedly (${result.signal ?? `code ${result.code ?? "unknown"}`})`,
        );
      }
      callbacks.onTerminal();
      rawBody.end();
      return;
    }
    if (type === FRAME_ERROR) {
      const detail = parseHelperError(payload);
      throw new RegistryPinnedTransportError(detail);
    }
    throw new RegistryPinnedTransportError(`Registry helper sent unknown frame type ${String(type)}`);
  }
}

function parseHelperPrelude(payload: Buffer): HelperResponsePrelude {
  let candidate: unknown;
  try {
    candidate = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new RegistryPinnedTransportError("Registry helper sent invalid response metadata");
  }
  if (typeof candidate !== "object" || candidate === null) {
    throw new RegistryPinnedTransportError("Registry helper sent invalid response metadata");
  }
  const value = candidate as { status?: unknown; statusText?: unknown; rawHeaders?: unknown };
  if (
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    value.status < 200 ||
    value.status > 599 ||
    typeof value.statusText !== "string" ||
    !Array.isArray(value.rawHeaders) ||
    value.rawHeaders.length > 512 ||
    value.rawHeaders.length % 2 !== 0 ||
    value.rawHeaders.some((entry) => typeof entry !== "string" || entry.length > 16_384)
  ) {
    throw new RegistryPinnedTransportError("Registry helper sent invalid response metadata");
  }
  return { status: value.status, statusText: value.statusText, rawHeaders: value.rawHeaders as string[] };
}

function parseHelperError(payload: Buffer): string {
  try {
    const candidate = JSON.parse(payload.toString("utf8")) as { message?: unknown; code?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "Pinned registry helper failed";
    const code = typeof candidate.code === "string" ? ` [${candidate.code}]` : "";
    return `${message}${code}`;
  } catch {
    return "Pinned registry helper failed with an invalid error frame";
  }
}

function collectLimitedStderr(stderr: Readable): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stderr) {
      if (total >= MAX_HELPER_STDERR_BYTES) continue;
      const buffer = Buffer.from(chunk);
      const selected = buffer.subarray(0, MAX_HELPER_STDERR_BYTES - total);
      chunks.push(selected);
      total += selected.byteLength;
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family === 0) throw new Error(`Pinned registry address is not an IP literal: ${address}`);
  return ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

async function prepareRequest(url: URL, init: RequestInit | undefined): Promise<PreparedRequest> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body;
  if (body === undefined || body === null) return { method, headers };
  if (method === "GET" || method === "HEAD") {
    throw new TypeError(`Request with ${method} method cannot have a body`);
  }

  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return { method, headers, body: boundedRequestBytes(new TextEncoder().encode(body)) };
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    return { method, headers, body: boundedRequestBytes(new TextEncoder().encode(body.toString())) };
  }
  if (body instanceof Blob) {
    if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    if (body.size > MAX_REGISTRY_REQUEST_BODY_BYTES) throw requestBodyTooLarge(body.size);
    return { method, headers, body: boundedRequestBytes(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof FormData) {
    const encoded = new Request(url, { method, body });
    for (const [name, value] of encoded.headers) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return { method, headers, body: boundedRequestBytes(new Uint8Array(await encoded.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) {
    return { method, headers, body: boundedRequestBytes(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      method,
      headers,
      body: boundedRequestBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
    };
  }
  if (body instanceof ReadableStream) {
    return { method, headers, body: boundedRequestStream(body as ReadableStream<Uint8Array>) };
  }
  throw new TypeError("Unsupported registry request body type");
}

function boundedRequestBytes(body: Uint8Array): Uint8Array {
  if (body.byteLength > MAX_REGISTRY_REQUEST_BODY_BYTES) throw requestBodyTooLarge(body.byteLength);
  return body;
}

function boundedRequestStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          controller.error(new RegistryPinnedTransportError("Registry request body stream must contain byte chunks"));
          return;
        }
        total += chunk.byteLength;
        if (total > MAX_REGISTRY_REQUEST_BODY_BYTES) {
          controller.error(requestBodyTooLarge(total));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function requestBodyTooLarge(observedBytes: number): RegistryPinnedTransportError {
  return new RegistryPinnedTransportError(
    `Registry request body exceeds ${MAX_REGISTRY_REQUEST_BODY_BYTES} bytes (observed: ${observedBytes})`,
  );
}

function requestHeaders(headers: Headers, url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) result[name] = value;
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete result[name];
  }
  // Never let a caller pair the validated socket/TLS identity with an
  // unrelated HTTP virtual host.
  result.host = url.host;
  return result;
}

async function writeRequestBody(
  request: ClientRequest,
  body: Uint8Array | ReadableStream<Uint8Array> | undefined,
): Promise<void> {
  if (!body) {
    request.end();
    return;
  }
  if (body instanceof Uint8Array) {
    request.end(body);
    return;
  }
  const readable = Readable.fromWeb(body as never);
  readable.once("error", (error) => request.destroy(error));
  readable.pipe(request);
}

function responseFromIncoming(
  incoming: IncomingMessage,
  method: string,
  signal: AbortSignal | null | undefined,
): Response {
  return responseFromRaw(
    incoming,
    {
      status: incoming.statusCode ?? 500,
      statusText: incoming.statusMessage ?? "",
      rawHeaders: incoming.rawHeaders,
    },
    method,
    signal,
    () => incoming.destroy(),
  );
}

function responseFromRaw(
  raw: Readable,
  metadata: HelperResponsePrelude,
  method: string,
  signal: AbortSignal | null | undefined,
  onCancel: () => void,
): Response {
  const headers = responseHeaders(metadata.rawHeaders);
  const { status, statusText } = metadata;
  if (responseMustNotHaveBody(method, status)) {
    // Draining is unsafe here: a hostile peer can attach an endless chunked
    // body to a null-body status and retain the pinned socket/helper forever.
    // Terminate the underlying transport before exposing the bodyless response.
    onCancel();
    if (!raw.destroyed) raw.destroy();
    return new Response(null, { status, statusText, headers });
  }

  const decoded = decodeResponseStream(raw, headers.get("content-encoding") ?? "");
  const onAbort = (): void => {
    const reason = signal?.reason;
    decoded.destroy(reason instanceof Error ? reason : new Error("Registry response body aborted"));
    onCancel();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    decoded.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  decoded.once("error", onCancel);
  decoded.once("close", onCancel);
  const body = Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, statusText, headers });
}

/** Fetch null-body cases accepted by the helper's final-response protocol. */
function responseMustNotHaveBody(method: string, status: number): boolean {
  // Interim 1xx responses never enter this function: node:http reports them
  // separately and the helper protocol accepts final statuses from 200 onward.
  return method === "HEAD" || status === 204 || status === 205 || status === 304;
}

function responseHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function decodeResponseStream(raw: Readable, contentEncoding: string): Readable {
  const encodings = contentEncoding
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean)
    .reverse();
  let stream = raw;
  for (const encoding of encodings) {
    if (encoding === "gzip" || encoding === "x-gzip") stream = stream.pipe(createGunzip());
    else if (encoding === "deflate") stream = stream.pipe(createInflate());
    else if (encoding === "br") stream = stream.pipe(createBrotliDecompress());
  }
  return stream;
}

function asTransportError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new RegistryPinnedTransportError(String(error));
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
