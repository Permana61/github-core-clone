// Shared REST helpers: JSON answers, auth, body parsing, pagination.
// Every response goes through sendJson / sendNoContent so it always carries
// `application/json` and a non-empty `X-GitHub-Request-Id`.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Deterministic request id: `req-<n>`, never empty, no clock / randomness. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/**
 * Answer with a JSON body. Always `application/json` + a non-empty
 * `X-GitHub-Request-Id`, on every status including errors.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** 204 with no body, but still the request-id header. */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
  });
  res.end();
}

/** Shorthand for a `{"message": ...}` JSON error. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false };

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read the request body. Empty body -> `{ok:true, value:undefined}`.
 * Non-empty body that is not valid JSON -> `{ok:false}` (caller answers 400).
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buf);
  }
  if (size === 0) return { ok: true, value: undefined };
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Bearer auth against MAKEFUN_SHOP_TOKEN. No token configured -> any non-empty
 * Bearer header passes, but a missing header still fails (RECON §8.2).
 * A wrong token never passes.
 */
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (match === null) return false;
  const presented = (match[1] ?? '').trim();
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

/** Origin of this request, for absolute pagination URLs (`Link` stays same-origin). */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export interface PageParams {
  page: number;
  perPage: number;
}

/** `page` (default 1) and `per_page` (default 30, clamped 1..100). */
export function parsePagination(query: URLSearchParams): PageParams {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage)
    ? Math.min(100, Math.max(1, rawPerPage))
    : 30;
  return { page, perPage };
}

/** Slice one page out of a list, in order. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/**
 * GitHub-style `Link` header with absolute same-origin URLs. `rel="next"` only
 * when a further page exists; `first`/`prev`/`last` included when meaningful.
 * Extra query params (e.g. `state`) are carried over unchanged.
 */
export function buildLinkHeader(
  origin: string,
  path: string,
  query: URLSearchParams,
  page: number,
  perPage: number,
  total: number,
): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.length === 0 ? null : parts.join(', ');
}
