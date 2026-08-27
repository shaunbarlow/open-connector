export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  bearerToken?: string;
}

/**
 * Resolves an absolute-looking API path (e.g. "/api/providers") against an
 * explicit `<base>` tag when one is present, instead of the browser's
 * default behavior of always treating a leading "/" as relative to the
 * origin root.
 *
 * Why this matters: when Claworc's control plane reverse-proxies this app at
 * `/connector/*`, it injects `<base href="/connector/">` into the served
 * HTML (see `writeProxyResponse` in the Claworc control plane) so relative
 * asset URLs resolve under the proxy prefix. But `fetch("/api/...")` with a
 * leading slash is an absolute path and browsers resolve it against the
 * origin root regardless of any `<base>` tag, bypassing the proxy prefix
 * entirely and hitting Claworc's own `/api/...` routes instead of this
 * server's.
 *
 * This only rewrites the path when a `<base>` element actually exists in the
 * document. Falling back to `document.baseURI` unconditionally would be
 * wrong in the standalone (non-proxied) deployment: with no `<base>` tag,
 * `document.baseURI` equals the current SPA route's URL (e.g.
 * "/actions/123" for the `/actions/:actionId` route), and relative URL
 * resolution only replaces the last path segment — "api/foo" against
 * "/actions/123" resolves to "/actions/api/foo", not "/api/foo". Gating on
 * an explicit `<base>` element keeps standalone behavior exactly as before
 * (origin-relative) while making the proxied deployment correct.
 *
 * `document` is unavailable under the Node test environment this project's
 * unit tests run in; falling back to the raw path there preserves existing
 * test behavior (tests assert against literal "/api/..." strings).
 */
function resolveApiPath(path: string): string {
  if (typeof document === "undefined") {
    return path;
  }
  const base = document.querySelector("base")?.href;
  if (!base) {
    return path;
  }
  return new URL(path.replace(/^\//, ""), base).toString();
}

export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(resolveApiPath(path), {
      headers: headersFor(options),
      credentials: "same-origin",
    }),
  );
}

export async function apiPost<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(resolveApiPath(path), {
      method: "POST",
      headers: headersFor(options, true),
      credentials: "same-origin",
      body: JSON.stringify(body),
    }),
  );
}

export async function apiPut<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(resolveApiPath(path), {
      method: "PUT",
      headers: headersFor(options, true),
      credentials: "same-origin",
      body: JSON.stringify(body),
    }),
  );
}

export async function apiDelete<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(resolveApiPath(path), {
      method: "DELETE",
      headers: headersFor(options),
      credentials: "same-origin",
    }),
  );
}

function headersFor(options: RequestOptions, json = false): Headers {
  const headers = new Headers();
  if (json) {
    headers.set("content-type", "application/json");
  }
  const token = options.bearerToken?.trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = parseJson(await response.text());
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload) ?? `Request failed with ${response.status}`);
  }
  // A successful response whose body is not JSON means something rewrote it in
  // transit. Returning the failed parse as T would hand the caller a null typed
  // as the payload, and the first property read off it crashes far from the
  // cause; a compressing proxy did exactly that to the whole dashboard once.
  if (payload === undefined) {
    throw new ApiError(response.status, `Request succeeded with ${response.status} but the response body was not JSON`);
  }
  return payload as T;
}

/** Returns `undefined` for a body that is not JSON. `JSON.parse` never does. */
function parseJson(body: string): unknown {
  if (body === "") {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  if ("errorMessage" in payload && typeof payload.errorMessage === "string") {
    return payload.errorMessage;
  }
  if ("message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  if ("error" in payload && payload.error && typeof payload.error === "object") {
    const error = payload.error as { message?: unknown };
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
