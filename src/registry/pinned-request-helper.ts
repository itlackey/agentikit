// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

interface ParsedHelperRequest {
  addressFamily: 4 | 6;
  bodyPresent: boolean;
  headers: Record<string, string>;
  initialBody: Buffer;
  iterator: AsyncIterator<Uint8Array>;
  method: string;
  pinnedAddress: string;
  timeoutMs: number;
  url: URL;
}

/** Parse and validate the private stdin request before any socket is opened. */
async function readNodePinnedHelperRequest(isIP: typeof import("node:net")["isIP"]): Promise<ParsedHelperRequest> {
  const MAX_PRELUDE_BYTES = 64 * 1024;
  const iterator = process.stdin[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const readExact = async (length: number): Promise<Buffer> => {
    while (buffered.byteLength < length) {
      const next = await iterator.next();
      if (next.done) throw new Error("Registry helper input ended before the request prelude was complete");
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  };

  const preludeLength = (await readExact(4)).readUInt32BE(0);
  if (preludeLength === 0 || preludeLength > MAX_PRELUDE_BYTES) {
    throw new Error("Registry helper request prelude exceeds its protocol limit");
  }
  const raw = JSON.parse((await readExact(preludeLength)).toString("utf8")) as {
    url?: unknown;
    address?: unknown;
    method?: unknown;
    headers?: unknown;
    timeoutMs?: unknown;
    bodyPresent?: unknown;
  };
  if (typeof raw.url !== "string" || typeof raw.address !== "string") {
    throw new Error("Registry helper request prelude is invalid");
  }
  const url = new URL(raw.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Registry helper accepts only credential-free HTTP(S) URLs");
  }
  const addressFamily = isIP(raw.address);
  if (addressFamily === 0) throw new Error("Registry helper requires a numeric pinned address");
  if (typeof raw.timeoutMs !== "number" || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
    throw new Error("Registry helper timeout is invalid");
  }
  if (!Array.isArray(raw.headers) || raw.headers.length > 256) {
    throw new Error("Registry helper headers are invalid");
  }
  const headers: Record<string, string> = {};
  for (const pair of raw.headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      pair[0].length > 256 ||
      pair[1].length > 16_384
    ) {
      throw new Error("Registry helper header entry is invalid");
    }
    headers[pair[0].toLowerCase()] = pair[1];
  }
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
    delete headers[name];
  }
  headers.host = url.host;
  return {
    addressFamily: addressFamily as 4 | 6,
    bodyPresent: raw.bodyPresent === true,
    headers,
    initialBody: buffered,
    iterator,
    method: typeof raw.method === "string" ? raw.method.toUpperCase() : "GET",
    pinnedAddress: raw.address,
    timeoutMs: raw.timeoutMs,
    url,
  };
}

/**
 * The body of the one-request Node helper used by Bun's registry transport.
 * Its parser is passed explicitly when the parent serializes both functions.
 */
export async function nodePinnedRequestHelperMain(
  readRequest: (isIP: typeof import("node:net")["isIP"]) => Promise<ParsedHelperRequest>,
  http: typeof import("node:http"),
  https: typeof import("node:https"),
  isIP: typeof import("node:net")["isIP"],
): Promise<void> {
  const MAX_FRAME_BYTES = 1024 * 1024;
  const FRAME_PRELUDE = 0;
  const FRAME_BODY = 1;
  const FRAME_END = 2;
  const FRAME_ERROR = 3;

  const writeBuffer = async (value: Uint8Array): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
    });
  };

  const writeFrame = async (type: number, payload: Uint8Array = new Uint8Array()): Promise<void> => {
    if (payload.byteLength > MAX_FRAME_BYTES && type !== FRAME_BODY) {
      throw new Error("Registry helper frame exceeds its protocol limit");
    }
    if (type === FRAME_BODY && payload.byteLength > MAX_FRAME_BYTES) {
      for (let offset = 0; offset < payload.byteLength; offset += MAX_FRAME_BYTES) {
        await writeFrame(type, payload.subarray(offset, Math.min(payload.byteLength, offset + MAX_FRAME_BYTES)));
      }
      return;
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = type;
    header.writeUInt32BE(payload.byteLength, 1);
    await writeBuffer(header);
    if (payload.byteLength > 0) await writeBuffer(payload);
  };

  const errorPayload = (error: unknown): Uint8Array => {
    const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
    return Buffer.from(
      JSON.stringify({
        name: typeof candidate?.name === "string" ? candidate.name.slice(0, 128) : "Error",
        message:
          typeof candidate?.message === "string" ? candidate.message.slice(0, 8_192) : String(error).slice(0, 8_192),
        code: typeof candidate?.code === "string" ? candidate.code.slice(0, 128) : undefined,
      }),
    );
  };

  try {
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
      throw new Error(`The pinned registry helper requires Node.js >= 24; found ${process.versions.node}`);
    }

    const { addressFamily, bodyPresent, headers, initialBody, iterator, method, pinnedAddress, timeoutMs, url } =
      await readRequest(isIP);

    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
    const lookup: import("node:net").LookupFunction = (_hostname, options, callback) => {
      if (typeof options === "object" && options !== null && "all" in options && options.all === true) {
        callback(null, [{ address: pinnedAddress, family: addressFamily }]);
      } else {
        callback(null, pinnedAddress, addressFamily);
      }
    };
    const requestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup,
      // One helper owns exactly one fresh connection. It never pools a socket
      // selected for an earlier DNS answer.
      agent: false,
      ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };

    let responseStarted = false;
    let requestFinished = false;
    let request: import("node:http").ClientRequest | undefined;
    const responseDone = new Promise<void>((resolve, reject) => {
      const requestFn = url.protocol === "https:" ? https.request : http.request;
      request = requestFn(requestOptions, async (response) => {
        responseStarted = true;
        try {
          await writeFrame(
            FRAME_PRELUDE,
            Buffer.from(
              JSON.stringify({
                status: response.statusCode ?? 500,
                statusText: response.statusMessage ?? "",
                rawHeaders: response.rawHeaders,
              }),
            ),
          );
          for await (const chunk of response) {
            await writeFrame(FRAME_BODY, Buffer.from(chunk));
          }
          await writeFrame(FRAME_END);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      const headerTimer = setTimeout(() => {
        request?.destroy(new Error(`Registry request timed out after ${timeoutMs}ms while awaiting response headers`));
      }, timeoutMs);
      request.once("response", () => clearTimeout(headerTimer));
      request.once("error", (error) => {
        clearTimeout(headerTimer);
        if (!responseStarted) reject(error);
      });
    });

    const writeRequestChunk = async (chunk: Uint8Array): Promise<void> => {
      if (!request || request.destroyed) throw new Error("Registry helper request closed while streaming its body");
      const activeRequest = request;
      if (activeRequest.write(chunk)) return;
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
          activeRequest.off("drain", onDrain);
          activeRequest.off("error", onError);
        };
        activeRequest.once("drain", onDrain);
        activeRequest.once("error", onError);
      });
    };

    const bodyDone = (async (): Promise<void> => {
      if (!request) throw new Error("Registry helper request was not initialized");
      if (bodyPresent) {
        if (initialBody.byteLength > 0) {
          await writeRequestChunk(initialBody);
        }
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          await writeRequestChunk(Buffer.from(next.value));
        }
      }
      requestFinished = true;
      request.end();
    })();

    try {
      await Promise.all([responseDone, bodyDone]);
    } catch (error) {
      if (!requestFinished && !responseStarted) request?.destroy(error as Error);
      throw error;
    }
  } catch (error) {
    try {
      await writeFrame(FRAME_ERROR, errorPayload(error));
    } catch {
      // The parent also treats an unframed EOF as a transport failure.
    }
    process.exitCode = 1;
  }
}

/** Materialize both self-contained passes into a one-request Node program. */
export function nodePinnedRequestHelperSource(): string {
  return (
    `import * as http from "node:http";\n` +
    `import * as https from "node:https";\n` +
    `import { isIP } from "node:net";\n` +
    `(${nodePinnedRequestHelperMain.toString()})(${readNodePinnedHelperRequest.toString()}, http, https, isIP).catch((error) => {\n` +
    `  console.error(error instanceof Error ? error.message : String(error));\n` +
    `  process.exitCode = 1;\n` +
    `});\n`
  );
}
