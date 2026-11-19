// REST v3 handler (`/api/v3/*`). Mounted by the app router; this module owns
// nothing but the REST surface and talks to the shared Store + git-objects.
// Every answer is JSON with a non-empty X-GitHub-Request-Id (see util.ts).
// All timestamps are the store's `now`; no Date.now() / Math.random() here.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Comment,
  GitObject,
  Issue,
  Label,
  Pull,
  PullFile,
  Repo,
  Store,
  User,
} from './store.ts';
import {
  applyFileChange,
  commitParents,
  commitTree,
  getBlobAt,
  listFilesAt,
} from './git-objects.ts';
import {
  buildLinkHeader,
  isAuthorized,
  originOf,
  paginate,
  parsePagination,
  readJsonBody,
  sendError,
  sendJson,
  sendNoContent,
} from './util.ts';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// -------------------------------------------------------------------------------------------
// Serializers (extra fields are allowed by the suite; the checked fields are exact)
// -------------------------------------------------------------------------------------------

function userJson(u: User): JsonObject {
  return {
    login: u.login,
    id: u.id,
    node_id: u.node_id,
    type: 'User',
    name: u.name,
    email: u.email,
    avatar_url: '',
    html_url: '',
    site_admin: false,
  };
}

function repoJson(r: Repo): JsonObject {
  return {
    id: r.id,
    node_id: r.node_id,
    name: r.name,
    full_name: r.full_name,
    owner: userJson(r.owner),
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    has_issues: r.has_issues,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(l: Label): JsonObject {
  return {
    id: l.id,
    node_id: l.node_id,
    name: l.name,
    color: l.color,
    description: l.description,
    default: false,
  };
}

function issueJson(i: Issue): JsonObject {
  return {
    id: i.id,
    node_id: i.node_id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(labelJson),
    user: userJson(i.user),
    created_at: i.created_at,
    updated_at: i.updated_at,
    comments: i.comments.length,
  };
}

function commentJson(c: Comment): JsonObject {
  return {
    id: c.id,
    node_id: c.node_id,
    body: c.body,
    user: userJson(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function pullJson(p: Pull): JsonObject {
  return {
    id: p.id,
    node_id: p.node_id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    head: { ref: p.head.ref, sha: p.head.sha },
    base: { ref: p.base.ref, sha: p.base.sha },
    merged: p.merged,
    mergeable: p.mergeable,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    user: userJson(p.user),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function pullFileJson(f: PullFile): JsonObject {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    sha: f.sha,
  };
}

// -------------------------------------------------------------------------------------------
// Git object helpers
// -------------------------------------------------------------------------------------------

function gitObjectSha(obj: GitObject): string {
  const header = `${obj.type} ${obj.data.length}\0`;
  return createHash('sha1').update(header, 'utf8').update(obj.data).digest('hex');
}

/** Store the objects a git-objects call produced (idempotent if already stored).
 * Accepts the Map<string, GitObject> that applyFileChange returns, or an array. */
function insertObjects(repo: Repo, objs: Map<string, GitObject> | readonly GitObject[]): void {
  if (objs instanceof Map) {
    for (const [sha, obj] of objs) repo.objects.set(sha, obj);
    return;
  }
  for (const obj of objs) repo.objects.set(gitObjectSha(obj), obj);
}

function authorIdent(store: Store): string {
  return `${store.viewer.name} <${store.viewer.email}>`;
}

function timestampSec(store: Store): number {
  return Math.floor(Date.parse(store.now) / 1000);
}

function touch(repo: Repo, store: Store): void {
  repo.updated_at = store.now;
  repo.pushed_at = store.now;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorDate: '',
    committerName: '',
    committerEmail: '',
    committerDate: '',
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const id = parseIdent(line.slice(7));
      out.authorName = id.name;
      out.authorEmail = id.email;
      out.authorDate = id.date;
    } else if (line.startsWith('committer ')) {
      const id = parseIdent(line.slice(10));
      out.committerName = id.name;
      out.committerEmail = id.email;
      out.committerDate = id.date;
    }
  }
  return out;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTreeEntries(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    out.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

/** Tree sha of `dirPath` ('' = root) under a commit, or null when it is not a directory. */
function findDirTreeSha(repo: Repo, commitSha: string, dirPath: string): string | null {
  let treeSha: string;
  try {
    treeSha = commitTree(repo.objects, commitSha);
  } catch {
    return null;
  }
  if (treeSha === '') return null;
  if (dirPath === '') return treeSha;
  for (const part of dirPath.split('/')) {
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTreeEntries(obj.data).find(
      (e) => e.name === part && e.mode === '40000',
    );
    if (entry === undefined) return null;
    treeSha = entry.sha;
  }
  return treeSha;
}

/**
 * Resolve a `?ref=` / branch argument to a commit sha.
 * Returns `{ ok: false }` when the ref names nothing, `{ ok: true, sha }` otherwise
 * (`sha` is null for an unborn branch / empty repo).
 */
function resolveRef(repo: Repo, ref: string | undefined): { ok: boolean; sha: string | null } {
  if (ref === undefined || ref === '') {
    return { ok: true, sha: repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null };
  }
  if (ref.startsWith('refs/')) {
    const sha = repo.refs.get(ref);
    return sha === undefined ? { ok: false, sha: null } : { ok: true, sha };
  }
  const branchSha = repo.refs.get(`refs/heads/${ref}`);
  if (branchSha !== undefined) return { ok: true, sha: branchSha };
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) {
    return { ok: true, sha: ref.toLowerCase() };
  }
  return { ok: false, sha: null };
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

function splitLines(buf: Buffer): string[] {
  const lines = buf.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Crude line diff: common prefix/suffix trimmed, the rest counts as added/deleted. */
function lineDiff(base: Buffer | null, head: Buffer | null): { additions: number; deletions: number } {
  const b = base === null ? [] : splitLines(base);
  const h = head === null ? [] : splitLines(head);
  let prefix = 0;
  while (prefix < b.length && prefix < h.length && b[prefix] === h[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < b.length - prefix &&
    suffix < h.length - prefix &&
    b[b.length - 1 - suffix] === h[h.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { additions: h.length - prefix - suffix, deletions: b.length - prefix - suffix };
}

function diffFiles(
  repo: Repo,
  baseSha: string,
  headSha: string,
): PullFile[] {
  const baseFiles = listFilesAt(repo.objects, baseSha);
  const headFiles = listFilesAt(repo.objects, headSha);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: PullFile[] = [];
  for (const name of [...names].sort()) {
    const inBase = baseFiles.get(name);
    const inHead = headFiles.get(name);
    if (inBase !== undefined && inHead === undefined) {
      const { deletions } = lineDiff(inBase.data, null);
      out.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions, sha: inBase.sha });
    } else if (inBase === undefined && inHead !== undefined) {
      const { additions } = lineDiff(null, inHead.data);
      out.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions, sha: inHead.sha });
    } else if (inBase !== undefined && inHead !== undefined && inBase.sha !== inHead.sha) {
      const { additions, deletions } = lineDiff(inBase.data, inHead.data);
      out.push({
        filename: name,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: inHead.sha,
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Handler
// -------------------------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  query: URLSearchParams;
  body: unknown;
  method: string;
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendError(res, 404, message);
}

function decodeSegments(pathname: string): string[] | null {
  const raw = pathname.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (const seg of raw) {
    try {
      out.push(decodeURIComponent(seg));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Handle one request. Returns true when the path is under `/api/v3` (handled,
 * even as a 404), false otherwise so the app router can try another surface.
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    // Keep pathname '/' and an empty query; routing below answers 404.
  }
  // Trailing slashes are insignificant (except the root itself).
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');

  const segments = decodeSegments(pathname);
  if (segments === null || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  // API root: public, carries X-OAuth-Scopes.
  if (rest.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // Meta: public.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // Everything else needs the bearer token (missing -> 401, never 404).
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // Body-bearing methods: malformed JSON -> 400.
  let body: unknown;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendError(res, 400, 'Invalid JSON body');
      return true;
    }
    body = parsed.value;
  }

  const ctx: Ctx = { req, res, store, query, body, method };

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, userJson(store.viewer));
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createUserRepo(ctx);
    notFound(res);
    return true;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    return handleRepoRoute(ctx, rest.slice(1));
  }

  notFound(res);
  return true;
}

/** Bound handler for the app router: `createServer(handleRestFor(store))` style. */
export function createRestHandler(store: Store): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return (req, res) => handleRest(req, res, store);
}

// -------------------------------------------------------------------------------------------
// /user/repos
// -------------------------------------------------------------------------------------------

function listUserRepos(ctx: Ctx): boolean {
  const { page, perPage } = parsePagination(ctx.query);
  const repos = ctx.store.listRepos(ctx.store.viewer.login);
  const link = buildLinkHeader(
    originOf(ctx.req),
    '/api/v3/user/repos',
    ctx.query,
    page,
    perPage,
    repos.length,
  );
  sendJson(ctx.res, 200, paginate(repos, page, perPage).map(repoJson), link === null ? {} : { link });
  return true;
}

function createUserRepo(ctx: Ctx): boolean {
  const body = asObject(ctx.body);
  const name = body === null ? null : asString(body.name);
  if (name === null || name === '') {
    sendError(ctx.res, 422, 'Repository name is required');
    return true;
  }
  if (ctx.store.getRepo(ctx.store.viewer.login, name) !== undefined) {
    sendError(ctx.res, 422, 'Repository already exists');
    return true;
  }
  const repo = ctx.store.createRepo(ctx.store.viewer.login, name, {
    private: body?.private === true,
    description: asString(body?.description) ?? '',
  });
  sendJson(ctx.res, 201, repoJson(repo));
  return true;
}

// -------------------------------------------------------------------------------------------
// /repos/{owner}/{name}/...
// -------------------------------------------------------------------------------------------

function handleRepoRoute(ctx: Ctx, parts: string[]): boolean {
  const [owner, name, ...tail] = parts as [string, string, ...string[]];
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    // A name under another owner is 404, never 403.
    notFound(ctx.res, 'Not Found');
    return true;
  }
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      sendNoContent(ctx.res);
      return true;
    }
    notFound(ctx.res);
    return true;
  }

  const [head, ...rest] = tail as [string, ...string[]];
  switch (head) {
    case 'branches':
      return rest.length === 0
        ? listBranches(ctx, repo)
        : getBranch(ctx, repo, rest.join('/'));
    case 'git':
      return handleGitRoute(ctx, repo, rest);
    case 'commits':
      return method === 'GET' ? listCommits(ctx, repo) : (notFound(ctx.res), true);
    case 'contents':
      return handleContents(ctx, repo, rest.join('/'));
    case 'labels':
      if (rest.length !== 0) {
        notFound(ctx.res);
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx.res, 200, repo.labels.map(labelJson));
        return true;
      }
      if (method === 'POST') return createLabel(ctx, repo);
      notFound(ctx.res);
      return true;
    case 'issues':
      return handleIssues(ctx, repo, rest);
    case 'pulls':
      return handlePulls(ctx, repo, rest);
    default:
      notFound(ctx.res);
      return true;
  }
}

function patchRepo(ctx: Ctx, repo: Repo): boolean {
  const body = asObject(ctx.body);
  if (body !== null) {
    const description = asString(body.description);
    if (description !== null) repo.description = description;
    if (typeof body.private === 'boolean') repo.private = body.private;
  }
  repo.updated_at = ctx.store.now;
  sendJson(ctx.res, 200, repoJson(repo));
  return true;
}

// -------------------------------------------------------------------------------------------
// Branches & refs
// -------------------------------------------------------------------------------------------

function listBranches(ctx: Ctx, repo: Repo): boolean {
  if (ctx.method !== 'GET') {
    notFound(ctx.res);
    return true;
  }
  const branches: JsonObject[] = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: repo.refs.get(ref) },
      protected: false,
    });
  }
  sendJson(ctx.res, 200, branches);
  return true;
}

function getBranch(ctx: Ctx, repo: Repo, branch: string): boolean {
  if (ctx.method !== 'GET') {
    notFound(ctx.res);
    return true;
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(ctx.res, 'Branch not found');
    return true;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha }, protected: false });
  return true;
}

function handleGitRoute(ctx: Ctx, repo: Repo, parts: string[]): boolean {
  const { method } = ctx;
  // POST /git/refs — create a branch / tag ref.
  if (parts.length === 1 && parts[0] === 'refs') {
    if (method === 'POST') return createRef(ctx, repo);
    if (method === 'GET') {
      const refs = [...repo.refs.keys()].sort().map((ref) => ({
        ref,
        node_id: ctx.store.globalId('Ref', ref),
        object: { sha: repo.refs.get(ref), type: 'commit' },
      }));
      sendJson(ctx.res, 200, refs);
      return true;
    }
    notFound(ctx.res);
    return true;
  }
  // GET /git/refs/heads/{branch} and /git/refs/tags/{tag} (names may contain '/').
  if (parts.length >= 3 && parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'tags')) {
    if (method !== 'GET') {
      notFound(ctx.res);
      return true;
    }
    const ref = `refs/${parts[1]}/${parts.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      notFound(ctx.res, 'Reference not found');
      return true;
    }
    sendJson(ctx.res, 200, {
      ref,
      node_id: ctx.store.globalId('Ref', ref),
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
    });
    return true;
  }
  notFound(ctx.res);
  return true;
}

function createRef(ctx: Ctx, repo: Repo): boolean {
  const body = asObject(ctx.body);
  const ref = body === null ? null : asString(body.ref);
  const sha = body === null ? null : asString(body.sha);
  if (ref === null || !ref.startsWith('refs/') || sha === null || !/^[0-9a-f]{40}$/i.test(sha)) {
    sendError(ctx.res, 422, 'Invalid ref or sha');
    return true;
  }
  const lowerSha = sha.toLowerCase();
  if (!repo.objects.has(lowerSha)) {
    sendError(ctx.res, 422, 'Object does not exist');
    return true;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return true;
  }
  repo.refs.set(ref, lowerSha);
  sendJson(ctx.res, 201, {
    ref,
    node_id: ctx.store.globalId('Ref', ref),
    object: { sha: lowerSha, type: repo.objects.get(lowerSha)?.type ?? 'commit' },
  });
  return true;
}

// -------------------------------------------------------------------------------------------
// Commits
// -------------------------------------------------------------------------------------------

function listCommits(ctx: Ctx, repo: Repo): boolean {
  const refParam = ctx.query.get('sha') ?? undefined;
  const resolved = resolveRef(repo, refParam);
  if (!resolved.ok || resolved.sha === null) {
    if (!resolved.ok) {
      notFound(ctx.res, 'Reference not found');
      return true;
    }
    sendJson(ctx.res, 200, []);
    return true;
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const stack: string[] = [resolved.sha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    order.push(sha);
    let parents: string[] = [];
    try {
      parents = commitParents(repo.objects, sha);
    } catch {
      parents = [];
    }
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  const out: JsonObject[] = [];
  for (const sha of order) {
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    const parsed = parseCommit(obj.data);
    out.push({
      sha,
      commit: {
        message: parsed.message,
        author: { name: parsed.authorName, email: parsed.authorEmail, date: parsed.authorDate },
        committer: { name: parsed.committerName, email: parsed.committerEmail, date: parsed.committerDate },
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((p) => ({ sha: p })),
      tree: { sha: parsed.tree },
    });
  }
  sendJson(ctx.res, 200, out);
  return true;
}

// -------------------------------------------------------------------------------------------
// Contents
// -------------------------------------------------------------------------------------------

function handleContents(ctx: Ctx, repo: Repo, path: string): boolean {
  if (ctx.method === 'GET') return getContents(ctx, repo, path);
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  notFound(ctx.res);
  return true;
}

function getContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const resolved = resolveRef(repo, ctx.query.get('ref') ?? undefined);
  if (!resolved.ok || resolved.sha === null) {
    notFound(ctx.res, resolved.ok ? 'Not Found' : 'Reference not found');
    return true;
  }
  const commitSha = resolved.sha;
  const blob = path === '' ? null : getBlobAt(repo.objects, commitSha, path);
  if (blob !== null) {
    const name = path.split('/').pop() as string;
    sendJson(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      sha: blob.sha,
      content: blob.data.toString('base64'),
    });
    return true;
  }
  const treeSha = findDirTreeSha(repo, commitSha, path);
  if (treeSha === null) {
    notFound(ctx.res, 'Not Found');
    return true;
  }
  const treeObj = repo.objects.get(treeSha);
  if (treeObj === undefined) {
    notFound(ctx.res, 'Not Found');
    return true;
  }
  const entries = parseTreeEntries(treeObj.data)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const blobObj = isDir ? undefined : repo.objects.get(entry.sha);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.sha,
        size: blobObj === undefined ? 0 : blobObj.data.length,
      };
    });
  sendJson(ctx.res, 200, entries);
  return true;
}

function putContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const body = asObject(ctx.body);
  const message = body === null ? null : asString(body.message);
  const contentB64 = body === null ? null : asString(body.content);
  if (message === null || contentB64 === null) {
    sendError(ctx.res, 422, 'message and content are required');
    return true;
  }
  const branch = (body !== null && asString(body.branch)) ?? repo.default_branch;
  // A branch named in the body that does not exist yet is created, from the
  // default branch tip (or from nothing when the repo is unborn).
  let tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (tip === null && branch !== repo.default_branch) {
    tip = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  }
  const existing = tip === null ? null : getBlobAt(repo.objects, tip, path);
  const givenSha = body !== null ? asString(body.sha) : null;
  if (givenSha !== null && existing !== null && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
    sendError(ctx.res, 409, 'sha does not match the current blob');
    return true;
  }
  const content = Buffer.from(contentB64, 'base64');
  const result = applyFileChange(
    repo.objects,
    tip,
    path,
    content,
    message,
    authorIdent(ctx.store),
    timestampSec(ctx.store),
  );
  insertObjects(repo, result.newObjects);
  repo.refs.set(`refs/heads/${branch}`, result.commitSha);
  touch(repo, ctx.store);
  const blobSha = result.blobSha ?? gitObjectSha({ type: 'blob', data: content });
  const name = path.split('/').pop() as string;
  sendJson(ctx.res, existing !== null ? 200 : 201, {
    content: { name, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
  return true;
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const body = asObject(ctx.body);
  const message = body === null ? null : asString(body.message);
  if (message === null) {
    sendError(ctx.res, 422, 'message is required');
    return true;
  }
  const branch = (body !== null && asString(body.branch)) ?? repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const existing = tip === null ? null : getBlobAt(repo.objects, tip, path);
  if (existing === null) {
    notFound(ctx.res, 'Not Found');
    return true;
  }
  const result = applyFileChange(
    repo.objects,
    tip,
    path,
    null,
    message,
    authorIdent(ctx.store),
    timestampSec(ctx.store),
  );
  insertObjects(repo, result.newObjects);
  repo.refs.set(`refs/heads/${branch}`, result.commitSha);
  touch(repo, ctx.store);
  sendJson(ctx.res, 200, { commit: { sha: result.commitSha, message } });
  return true;
}

// -------------------------------------------------------------------------------------------
// Labels
// -------------------------------------------------------------------------------------------

function createLabel(ctx: Ctx, repo: Repo): boolean {
  const body = asObject(ctx.body);
  const name = body === null ? null : asString(body.name);
  if (name === null || name === '') {
    sendError(ctx.res, 422, 'Label name is required');
    return true;
  }
  const existing = repo.labels.find((l) => l.name === name);
  if (existing !== undefined) {
    sendJson(ctx.res, 201, labelJson(existing));
    return true;
  }
  const id = ctx.store.nextLabelId++;
  const label: Label = {
    id,
    node_id: ctx.store.globalId('Label', `${repo.id}:${id}`),
    name,
    color: (body !== null && asString(body.color)) ?? 'ededed',
    description: (body !== null && asString(body.description)) ?? '',
  };
  repo.labels.push(label);
  sendJson(ctx.res, 201, labelJson(label));
  return true;
}

// -------------------------------------------------------------------------------------------
// Issues
// -------------------------------------------------------------------------------------------

function handleIssues(ctx: Ctx, repo: Repo, parts: string[]): boolean {
  const { method } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') return listIssues(ctx, repo);
    if (method === 'POST') return createIssue(ctx, repo);
    notFound(ctx.res);
    return true;
  }
  const number = Number.parseInt(parts[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) {
    notFound(ctx.res);
    return true;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (parts.length === 1) {
    if (issue === undefined) {
      notFound(ctx.res, 'Issue not found');
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx.res, 200, issueJson(issue));
      return true;
    }
    if (method === 'PATCH') return patchIssue(ctx, issue);
    notFound(ctx.res);
    return true;
  }
  if (parts.length === 2 && parts[1] === 'comments') {
    if (issue === undefined) {
      notFound(ctx.res, 'Issue not found');
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx.res, 200, issue.comments.map(commentJson));
      return true;
    }
    if (method === 'POST') return createComment(ctx, repo, issue);
    notFound(ctx.res);
    return true;
  }
  notFound(ctx.res);
  return true;
}

function listIssues(ctx: Ctx, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let items = repo.issues;
  if (state === 'open') items = items.filter((i) => i.state === 'open');
  else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
  else if (state !== 'all') items = items.filter((i) => i.state === 'open');
  const sorted = [...items].sort((a, b) =>
    direction === 'asc' ? a.number - b.number : b.number - a.number,
  );
  const { page, perPage } = parsePagination(ctx.query);
  const link = buildLinkHeader(
    originOf(ctx.req),
    `/api/v3/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/issues`,
    ctx.query,
    page,
    perPage,
    sorted.length,
  );
  sendJson(ctx.res, 200, paginate(sorted, page, perPage).map(issueJson), link === null ? {} : { link });
  return true;
}

function createIssue(ctx: Ctx, repo: Repo): boolean {
  const body = asObject(ctx.body);
  const rawLabels = body === null ? [] : (body.labels as unknown);
  const labelNames: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      if (typeof entry === 'string') labelNames.push(entry);
      else if (typeof entry === 'object' && entry !== null) {
        const n = asString((entry as JsonObject).name);
        if (n !== null) labelNames.push(n);
      }
    }
  }
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const found = repo.labels.find((l) => l.name === labelName);
    if (found === undefined) {
      sendError(ctx.res, 422, `Label '${labelName}' does not exist`);
      return true;
    }
    labels.push(found);
  }
  const id = ctx.store.nextIssueId++;
  const number = repo.nextIssueNumber++;
  const issue: Issue = {
    id,
    node_id: ctx.store.globalId('Issue', `${repo.id}:${number}`),
    number,
    title: (body !== null && asString(body.title)) ?? '',
    body: (body !== null && asString(body.body)) ?? '',
    state: 'open',
    labels,
    user: ctx.store.viewer,
    created_at: ctx.store.now,
    updated_at: ctx.store.now,
    comments: [],
  };
  repo.issues.push(issue);
  sendJson(ctx.res, 201, issueJson(issue));
  return true;
}

function patchIssue(ctx: Ctx, issue: Issue): boolean {
  const body = asObject(ctx.body);
  if (body !== null) {
    const state = asString(body.state);
    if (state !== null) {
      if (state !== 'open' && state !== 'closed') {
        sendError(ctx.res, 422, 'Invalid state');
        return true;
      }
      issue.state = state;
    }
    const title = asString(body.title);
    if (title !== null) issue.title = title;
    const text = asString(body.body);
    if (text !== null) issue.body = text;
  }
  issue.updated_at = ctx.store.now;
  sendJson(ctx.res, 200, issueJson(issue));
  return true;
}

function createComment(ctx: Ctx, repo: Repo, issue: Issue): boolean {
  const body = asObject(ctx.body);
  const text = body === null ? null : asString(body.body);
  if (text === null) {
    sendError(ctx.res, 422, 'Comment body is required');
    return true;
  }
  const id = ctx.store.nextCommentId++;
  const comment: Comment = {
    id,
    node_id: ctx.store.globalId('IssueComment', `${repo.id}:${issue.number}:${id}`),
    body: text,
    user: ctx.store.viewer,
    created_at: ctx.store.now,
    updated_at: ctx.store.now,
  };
  issue.comments.push(comment);
  sendJson(ctx.res, 201, commentJson(comment));
  return true;
}

// -------------------------------------------------------------------------------------------
// Pulls
// -------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, repo: Repo, parts: string[]): boolean {
  const { method } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') return listPulls(ctx, repo);
    if (method === 'POST') return createPull(ctx, repo);
    notFound(ctx.res);
    return true;
  }
  const number = Number.parseInt(parts[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) {
    notFound(ctx.res);
    return true;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (parts.length === 1) {
    if (pull === undefined) {
      notFound(ctx.res, 'Pull request not found');
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx.res, 200, pullJson(pull));
      return true;
    }
    notFound(ctx.res);
    return true;
  }
  if (parts.length === 2 && parts[1] === 'files') {
    if (pull === undefined) {
      notFound(ctx.res, 'Pull request not found');
      return true;
    }
    if (method !== 'GET') {
      notFound(ctx.res);
      return true;
    }
    sendJson(ctx.res, 200, pull.files.map(pullFileJson));
    return true;
  }
  if (parts.length === 2 && parts[1] === 'merge') {
    if (pull === undefined) {
      notFound(ctx.res, 'Pull request not found');
      return true;
    }
    if (method !== 'PUT') {
      notFound(ctx.res);
      return true;
    }
    return mergePull(ctx, repo, pull);
  }
  notFound(ctx.res);
  return true;
}

function listPulls(ctx: Ctx, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  let items = repo.pulls;
  if (state === 'open') items = items.filter((p) => p.state === 'open');
  else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
  else if (state !== 'all') items = items.filter((p) => p.state === 'open');
  const sorted = [...items].sort((a, b) => b.number - a.number);
  const { page, perPage } = parsePagination(ctx.query);
  const link = buildLinkHeader(
    originOf(ctx.req),
    `/api/v3/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/pulls`,
    ctx.query,
    page,
    perPage,
    sorted.length,
  );
  sendJson(ctx.res, 200, paginate(sorted, page, perPage).map(pullJson), link === null ? {} : { link });
  return true;
}

function branchFromRef(value: string): string {
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function createPull(ctx: Ctx, repo: Repo): boolean {
  const body = asObject(ctx.body);
  const headRaw = body === null ? null : asString(body.head);
  const baseRaw = body === null ? null : asString(body.base);
  if (headRaw === null || baseRaw === null) {
    sendError(ctx.res, 422, 'head and base are required');
    return true;
  }
  const headRef = branchFromRef(headRaw);
  const baseRef = branchFromRef(baseRaw);
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
  if (headSha === null || baseSha === null) {
    sendError(ctx.res, 422, 'head or base branch does not exist');
    return true;
  }
  const files = diffFiles(repo, baseSha, headSha);
  const id = ctx.store.nextPullId++;
  const number = repo.nextPullNumber++;
  const pull: Pull = {
    id,
    node_id: ctx.store.globalId('PullRequest', `${repo.id}:${number}`),
    number,
    title: (body !== null && asString(body.title)) ?? '',
    body: (body !== null && asString(body.body)) ?? '',
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    merged: false,
    mergeable: true,
    merged_at: null,
    merge_commit_sha: null,
    user: ctx.store.viewer,
    created_at: ctx.store.now,
    updated_at: ctx.store.now,
    files,
  };
  repo.pulls.push(pull);
  sendJson(ctx.res, 201, pullJson(pull));
  return true;
}

function mergePull(ctx: Ctx, repo: Repo, pull: Pull): boolean {
  if (pull.merged) {
    sendError(ctx.res, 405, 'Pull request is already merged');
    return true;
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? null;
  if (baseTip === null) {
    notFound(ctx.res, 'Base branch not found');
    return true;
  }
  // Conflict: for any file the PR touches, the base moved since the PR was
  // opened AND the head differs from the current base for that same path.
  const baseAtCreation = listFilesAt(repo.objects, pull.base.sha);
  const currentBase = listFilesAt(repo.objects, baseTip);
  const headFiles = listFilesAt(repo.objects, pull.head.sha);
  for (const file of pull.files) {
    const atCreation = baseAtCreation.get(file.filename)?.data ?? null;
    const current = currentBase.get(file.filename)?.data ?? null;
    const head = headFiles.get(file.filename)?.data ?? null;
    if (!buffersEqual(current, atCreation) && !buffersEqual(head, current)) {
      pull.mergeable = false;
      sendError(ctx.res, 405, 'Merge conflict: the base branch changed the same file');
      return true;
    }
  }
  // Squash merge: one new commit on the base branch whose tree is the base
  // tree plus the head's files, parent = base tip (single file: exactly one
  // commit; several files: chained one-per-file, final commit carries the
  // merge message and the full merged tree).
  const mergeMessage = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  let tip = baseTip;
  for (const file of pull.files) {
    const headEntry = headFiles.get(file.filename);
    const result = applyFileChange(
      repo.objects,
      tip,
      file.filename,
      headEntry === undefined ? null : headEntry.data,
      mergeMessage,
      authorIdent(ctx.store),
      timestampSec(ctx.store),
    );
    insertObjects(repo, result.newObjects);
    tip = result.commitSha;
  }
  const mergeSha = tip;
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
  touch(repo, ctx.store);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeable = true;
  pull.merged_at = ctx.store.now;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = ctx.store.now;
  sendJson(ctx.res, 200, { merged: true, sha: mergeSha, message: mergeMessage });
  return true;
}
