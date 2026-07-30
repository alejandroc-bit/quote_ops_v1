import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Socket } from "node:net";
import tls from "node:tls";
import { isPublicInternetAddress } from "./cloudflareStep.js";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MACBOOK_ACCEPTANCE_ORIGIN =
  "http://host.docker.internal:19091";

export class TmsTransportError extends Error {
  readonly code: string;

  constructor(code: string, name = "TmsTransportError") {
    super(code);
    this.name = name;
    this.code = code;
  }
}

export type TmsAbsoluteDeadline = {
  signal: AbortSignal;
  expiresAt: number;
  dispose(): void;
};

export type PinnedTmsRequest = {
  url: URL;
  init: RequestInit;
  pinnedAddresses: readonly string[];
  signal: AbortSignal;
};

export type PinnedTmsRequestExecutor = (
  input: PinnedTmsRequest
) => Promise<Response>;

export type PinnedTmsTransport = {
  fetch: typeof fetch;
};

export type PinnedTmsTransportOptions = {
  baseUrlOrigin: string;
  resolveHostname?: (
    hostname: string,
    signal: AbortSignal
  ) => Promise<string[]>;
  request?: PinnedTmsRequestExecutor;
  timeoutMs?: number;
  maximumBodyBytes?: number;
  maximumRedirects?: number;
  acceptanceMode?: string;
  deadline?: TmsAbsoluteDeadline;
};

export function createTmsAbsoluteDeadline(
  timeoutMs: number,
  parentSignal?: AbortSignal
): TmsAbsoluteDeadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        new DOMException("request_timeout", "TimeoutError")
      );
    }
  };
  const timer = setTimeout(abort, timeoutMs);
  const parentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        parentSignal?.reason ??
          new DOMException("request_aborted", "AbortError")
      );
    }
  };
  if (parentSignal?.aborted) parentAbort();
  else {
    parentSignal?.addEventListener("abort", parentAbort, {
      once: true
    });
  }
  return {
    signal: controller.signal,
    expiresAt,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", parentAbort);
    }
  };
}

export function createPinnedTmsTransport(
  options: PinnedTmsTransportOptions
): PinnedTmsTransport {
  const maximumBodyBytes =
    options.maximumBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maximumRedirects =
    options.maximumRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolver = options.resolveHostname ?? resolveInternetAddresses;
  const request = options.request ?? executePinnedTmsNodeRequest;

  const pinnedFetch = async (
    requestInput: URL | RequestInfo,
    init: RequestInit = {}
  ): Promise<Response> => {
    const ownedDeadline = options.deadline
      ? null
      : createTmsAbsoluteDeadline(options.timeoutMs ?? 10_000);
    const deadline = options.deadline ?? ownedDeadline!;
    const composed = composeAbortSignals([
      deadline.signal,
      init.signal
    ]);
    try {
      let url = parseRequestUrl(requestInput);
      if (url.origin !== options.baseUrlOrigin) {
        throw new TmsTransportError("request_origin_changed");
      }
      for (
        let redirectCount = 0;
        redirectCount <= maximumRedirects;
        redirectCount += 1
      ) {
        throwIfAborted(composed.signal);
        const pinnedAddresses = await resolveAndValidateAddresses({
          url,
          resolver,
          signal: composed.signal,
          acceptanceMode: options.acceptanceMode
        });
        const response = await raceWithAbort(
          request({
            url,
            init: {
              ...init,
              redirect: "manual",
              signal: composed.signal
            },
            pinnedAddresses,
            signal: composed.signal
          }),
          composed.signal
        );
        if (response.status < 300 || response.status >= 400) {
          return await bufferResponseWithinDeadline(
            response,
            maximumBodyBytes,
            composed.signal
          );
        }

        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location || redirectCount === maximumRedirects) {
          throw new TmsTransportError("request_redirect_rejected");
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new TmsTransportError("request_redirect_rejected");
        }
        if (next.origin !== options.baseUrlOrigin) {
          throw new TmsTransportError("request_redirect_rejected");
        }
        url = next;
      }
      throw new TmsTransportError("request_redirect_rejected");
    } finally {
      composed.dispose();
      ownedDeadline?.dispose();
    }
  };

  return { fetch: pinnedFetch as typeof fetch };
}

async function resolveAndValidateAddresses(input: {
  url: URL;
  resolver: (
    hostname: string,
    signal: AbortSignal
  ) => Promise<string[]>;
  signal: AbortSignal;
  acceptanceMode?: string;
}): Promise<string[]> {
  const allowMacbookAcceptanceAddress =
    input.acceptanceMode === "macbook" &&
    input.url.origin === MACBOOK_ACCEPTANCE_ORIGIN;
  const hostname = input.url.hostname;
  const addresses = isIP(hostname)
    ? [hostname]
    : await raceWithAbort(
        input.resolver(hostname, input.signal),
        input.signal
      );
  const normalized = [
    ...new Set(addresses.map(normalizeAddress))
  ];
  if (
    normalized.length === 0 ||
    normalized.some(
      (address) =>
        isIP(address) === 0 ||
        (!allowMacbookAcceptanceAddress &&
          !isPublicInternetAddress(address))
    )
  ) {
    throw new TmsTransportError("base_url_unsafe");
  }
  return normalized;
}

async function resolveInternetAddresses(
  hostname: string,
  signal: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal);
  const records = await lookup(hostname, {
    all: true,
    verbatim: true
  }).catch(() => []);
  throwIfAborted(signal);
  return records.map((record) => record.address);
}

export async function executePinnedTmsNodeRequest(
  input: PinnedTmsRequest
): Promise<Response> {
  let lastError: unknown;
  for (const address of input.pinnedAddresses) {
    throwIfAborted(input.signal);
    try {
      return await nodePinnedRequestToAddress(input, address);
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new TmsTransportError("request_unreachable");
}

async function nodePinnedRequestToAddress(
  input: PinnedTmsRequest,
  address: string
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const isHttps = input.url.protocol === "https:";
    if (!isHttps && input.url.protocol !== "http:") {
      reject(new TmsTransportError("request_url_invalid"));
      return;
    }
    let peerVerified = false;
    const pinnedSet = new Set(
      input.pinnedAddresses.map(normalizeAddress)
    );
    const verifyPeer = (socket: Socket): void => {
      const remoteAddress = normalizeAddress(
        socket.remoteAddress ?? ""
      );
      if (!pinnedSet.has(remoteAddress)) {
        socket.destroy(
          new TmsTransportError("request_peer_mismatch")
        );
        return;
      }
      peerVerified = true;
    };
    const port = Number(
      input.url.port || (isHttps ? "443" : "80")
    );
    const createConnection = isHttps
      ? () => {
          const rawSocket = new Socket();
          rawSocket.once("connect", () => verifyPeer(rawSocket));
           const secureSocket = tls.connect({
             socket: rawSocket,
             servername:
               isIP(input.url.hostname) === 0
                 ? input.url.hostname
                 : undefined,
             rejectUnauthorized: true,
             checkServerIdentity: (_hostname, certificate) =>
               tls.checkServerIdentity(
                 input.url.hostname,
                 certificate
               ),
             ALPNProtocols: ["http/1.1"]
           });
          secureSocket.once("secureConnect", () =>
            verifyPeer(secureSocket)
          );
          rawSocket.connect(port, address);
          return secureSocket;
        }
      : () => {
          const socket = new Socket();
          socket.once("connect", () => verifyPeer(socket));
          socket.connect(port, address);
          return socket;
        };
    const headers = Object.fromEntries(
      new Headers(input.init.headers).entries()
    );
    const agent = isHttps
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });
    agent.createConnection = createConnection;
    const request = (isHttps ? https.request : http.request)(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.init.method ?? "GET",
        headers,
        agent,
        signal: input.signal,
      },
      (response) => {
        if (!peerVerified) {
          response.destroy(
            new TmsTransportError("request_peer_mismatch")
          );
          return;
        }
        const responseHeaders = new Headers();
        for (
          let index = 0;
          index < response.rawHeaders.length;
          index += 2
        ) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name && value) responseHeaders.append(name, value);
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            response.once("end", () => controller.close());
            response.once("error", (error) =>
              controller.error(error)
            );
          },
          cancel() {
            response.destroy();
          }
        });
        resolve(
          new Response(body, {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers: responseHeaders
          })
        );
      }
    );
    request.once("error", reject);
    const body = input.init.body;
    if (typeof body === "string" || body instanceof Uint8Array) {
      request.write(body);
    } else if (body !== null && body !== undefined) {
      request.destroy(
        new TmsTransportError("request_body_unsupported")
      );
      return;
    }
    request.end();
  });
}

async function bufferResponseWithinDeadline(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Response> {
  const declaredLength = Number(
    response.headers.get("content-length")
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TmsTransportError("response_body_too_large");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TmsTransportError("response_body_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return new Response(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }
  );
}

function parseRequestUrl(input: URL | RequestInfo): URL {
  try {
    return new URL(
      input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : String(input)
    );
  } catch {
    throw new TmsTransportError("request_url_invalid");
  }
}

function normalizeAddress(address: string): string {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  return normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
}

function composeAbortSignals(
  signals: Array<AbortSignal | null | undefined>
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const active = signals.filter(
    (signal): signal is AbortSignal => Boolean(signal)
  );
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of active) {
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          signal.reason ??
            new DOMException("request_aborted", "AbortError")
        );
      }
    };
    listeners.set(signal, abort);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(
        signal.reason ??
          new DOMException("request_aborted", "AbortError")
      );
    signal.addEventListener("abort", abortListener, {
      once: true
    });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (
      signal.reason ??
      new DOMException("request_aborted", "AbortError")
    );
  }
}
