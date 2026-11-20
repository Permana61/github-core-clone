// Entry router: one shared Store, mounted in order:
// healthz -> git smart-HTTP -> REST v3 -> GraphQL v4 -> MCP -> 404 JSON.
// main.ts is untouched; this file owns the whole contest surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore } from './src/store.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQLRequest } from './src/graphql.ts';
import { mcpHandler } from './src/mcp.ts';
import { requestUrl, sendJson } from './src/util.ts';

function pathOf(req: IncomingMessage): string {
  return requestUrl(req).pathname;
}

export function createApp(): Server {
  const store = createStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart-HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
    // handleGit answers (incl. 401/404) and returns true when the path matches.
    if (handleGit(req, res, store, token)) return;

    // REST v3 (includes GET /api/v3 and /api/v3/ root + /meta). Async; it
    // returns false only for paths outside /api/v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      void handleRest(req, res, store).then((handled) => {
        if (!handled) sendJson(res, 404, { message: 'Not Found' });
      }).catch((err: unknown) => {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      });
      return;
    }

    // GraphQL v4: POST /api/graphql only (handler answers 405 otherwise).
    if (path === '/api/graphql') {
      void handleGraphQLRequest(req, res, store, token ? { token } : {}).catch((err: unknown) => {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      });
      return;
    }

    // MCP streamable HTTP: POST (+ DELETE to close a legacy session).
    if (path === '/mcp') {
      void mcpHandler(req, res, store).catch((err: unknown) => {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      });
      return;
    }

    // Everything else: GitHub's 404 body, still with X-GitHub-Request-Id.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
