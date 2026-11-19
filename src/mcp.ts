// MCP Streamable HTTP — era MODERN (2026-07-28), JSON-RPC 2.0 satu JSON per POST.
// Ditulis tangan dari RECON.md §6. Stdlib only, tanpa Date.now()/Math.random().
// Satu store dishare dengan REST/GraphQL/git; handler ini tidak membuat store sendiri.
//
// Tanda tangan: mcpHandler(req, res, store). `store` adalah objek store yang sama
// dengan yang dipakai REST (kontrak PLUMBING.md); bentuk yang dipakai di sini
// didefinisikan secara struktural di bawah (McpStore) supaya handler ini tidak
// bergantung pada file store.ts yang ditulis worker lain — selama bentuknya sama,
// typing struktural membuatnya kompatibel.
//
// Catatan integrasi: app.ts (worker lain/koordinator) yang me-mount handler ini di
// POST /mcp (+ DELETE /mcp) dan yang menciptakan/mengoper store-nya.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Bentuk store (kontrak PLUMBING.md, struktural — bukan import dari store.ts)
// ---------------------------------------------------------------------------

export interface McpUser {
  login: string;
  id: number;
  node_id: string;
  type: string;
}

export interface McpLabel {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string;
}

export interface McpComment {
  id: number;
  node_id: string;
  body: string;
  user: McpUser;
  created_at: string;
  updated_at: string;
}

export interface McpIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: McpLabel[];
  user: McpUser;
  created_at: string;
  updated_at: string;
  comments: McpComment[];
}

export interface McpPullFile {
  filename: string;
  sha: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface McpPull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
  merge_commit_sha: string | null;
  merged_at?: string | null;
  user: McpUser;
  created_at: string;
  updated_at: string;
  files: McpPullFile[];
}

export interface McpGitObject {
  type: string;
  data: Buffer;
}

export interface McpRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: McpUser;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  has_issues: boolean;
  refs: Map<string, string>;
  objects: Map<string, McpGitObject>;
  issues: McpIssue[];
  pulls: McpPull[];
  labels: McpLabel[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface McpStore {
  repos: Map<string, McpRepo>;
  viewer?: McpUser;
  users?: Map<string, McpUser>;
  nextRepoId?: number;
  nextIssueId?: number;
  nextPullId?: number;
}

// ---------------------------------------------------------------------------
// Util deterministik
// ---------------------------------------------------------------------------

const FALLBACK_NOW = '2026-11-14T06:30:00.000Z';

function nowIso(): string {
  const v = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const d = v ? Date.parse(v) : NaN;
  return Number.isNaN(d) ? FALLBACK_NOW : new Date(d).toISOString();
}

function nowEpochSec(): number {
  const ms = Date.parse(nowIso());
  return Math.floor(ms / 1000);
}

function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64url');
}

function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function viewerOf(store: McpStore): McpUser {
  if (store.viewer) return store.viewer;
  const u = store.users?.get('adaiversen');
  if (u) return u;
  return { login: 'adaiversen', id: 1000, node_id: nodeId('User', 1000), type: 'User' };
}

function emailOf(user: McpUser): string {
  return `${user.login}@example.invalid`;
}

/** ID global berikutnya per jenis: hormati counter store bila ada (supaya tidak
 *  tabrakan dengan REST), dan selalu di atas id yang sudah ada di store. */
function nextId(store: McpStore, kind: 'repo' | 'issue' | 'pull'): number {
  let max = 0;
  for (const repo of store.repos.values()) {
    if (kind === 'repo') max = Math.max(max, repo.id);
    if (kind === 'issue') for (const i of repo.issues) max = Math.max(max, i.id);
    if (kind === 'pull') for (const p of repo.pulls) max = Math.max(max, p.id);
  }
  const counter =
    kind === 'repo' ? store.nextRepoId : kind === 'issue' ? store.nextIssueId : store.nextPullId;
  const id = Math.max(counter ?? 1, max + 1, 1);
  if (kind === 'repo') store.nextRepoId = id + 1;
  else if (kind === 'issue') store.nextIssueId = id + 1;
  else store.nextPullId = id + 1;
  return id;
}

function findRepo(store: McpStore, owner: string, repo: string): McpRepo | undefined {
  const hit = store.repos.get(`${owner}/${repo}`);
  if (hit) return hit;
  // Fallback: cocokkan nama repo + login owner (tahan terhadap selisih key).
  for (const r of store.repos.values()) {
    if (r.name === repo && r.owner.login === owner) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Auth: token dari MAKEFUN_SHOP_TOKEN. Bila env tidak tahu tokennya, terima
// header Bearer apa pun yang non-empty; tanpa header selalu tolak (RECON §8.2).
// Hanya tools/call yang diwajibkan auth (mcp.auth-required); discover/list
// tetap dilayani.
// ---------------------------------------------------------------------------

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length);
  if (token.length === 0) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' ? true : token === expected;
}

// ---------------------------------------------------------------------------
// tools/list — SATU array konstanta modul; tidak pernah dimutasi, jadi dua
// panggilan menghasilkan JSON.stringify yang byte-identik.
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
        body: { type: 'string', description: 'Body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch using squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Pemetaan argumen: terima nama kanonis DAN sinonim yang dikenali client
// (RECON §6.2). `_meta` dan kunci lain diabaikan.
// ---------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

type Args = Record<string, unknown>;

function arg(args: Args, key: string): unknown {
  for (const n of SYNONYMS[key] ?? [key]) {
    const v = args[n];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function argStr(args: Args, key: string): string | undefined {
  const v = arg(args, key);
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function argNum(args: Args, key: string): number | undefined {
  const v = arg(args, key);
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return undefined;
}

function argBool(args: Args, key: string): boolean | undefined {
  const v = arg(args, key);
  if (typeof v === 'boolean') return v;
  return undefined;
}

/** Ambil owner/repo; fallback ke full_name "owner/repo" bila salah satunya hilang. */
function ownerRepo(args: Args): { owner?: string; repo?: string } {
  let owner = argStr(args, 'owner');
  let repo = argStr(args, 'repo');
  if ((!owner || !repo) && typeof args['full_name'] === 'string') {
    const parts = (args['full_name'] as string).split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  if ((!owner || !repo) && typeof args['repo_full_name'] === 'string') {
    const parts = (args['repo_full_name'] as string).split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Git object minimal (untuk merge squash) — format RECON §2.9.
// git-objects.ts (worker lain) belum ada saat file ini ditulis, jadi helper
// minimal ini tinggal di mcp.ts; JANGAN duplikasi ke file lain.
// ---------------------------------------------------------------------------

function storeObject(repo: McpRepo, type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const id = sha1Hex(Buffer.concat([header, data]));
  if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
  return id;
}

function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(text)?.[1] ?? '';
  const parents: string[] = [];
  for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) parents.push(m[1]);
  return { tree, parents };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Semua file (path -> blob) pada tip commit; gitlink dilewati. */
function listFilesAt(repo: McpRepo, commitSha: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return out;
  const { tree } = parseCommit(commit.data);
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000') continue; // gitlink
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(tree, '');
  return out;
}

/** Bangun tree (rekursif) dari peta file; kembalikan oid tree root. */
function buildTree(repo: McpRepo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (paths: string[], prefix: string): string => {
    // Kelompokkan berdasarkan segmen pertama setelah prefix.
    const children = new Map<string, { file?: { oid: string; mode: string }; sub: string[] }>();
    for (const p of paths) {
      const rest = prefix ? p.slice(prefix.length + 1) : p;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { file: files.get(p), sub: [] });
      } else {
        const dir = rest.slice(0, slash);
        const cur = children.get(dir) ?? { sub: [] };
        cur.sub.push(p);
        children.set(dir, cur);
      }
    }
    const entries: TreeEntry[] = [];
    for (const [name, c] of children) {
      if (c.file) entries.push({ mode: c.file.mode, name, oid: c.file.oid });
      else entries.push({ mode: '40000', name, oid: build(c.sub, prefix ? `${prefix}/${name}` : name) });
    }
    // Urutan git: nama direktori dibandingkan seolah berakhir '/'.
    entries.sort((a, b) => {
      const ka = a.name + (a.mode === '40000' ? '/' : '');
      const kb = b.name + (b.mode === '40000' ? '/' : '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of entries) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(parts));
  };
  return build([...files.keys()], '');
}

// ---------------------------------------------------------------------------
// Bentuk hasil tool
// ---------------------------------------------------------------------------

type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

function issueJson(i: McpIssue): Record<string, unknown> {
  return {
    id: i.id,
    node_id: i.node_id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => ({ name: l.name })),
    user: { login: i.user.login, id: i.user.id },
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

function repoJson(r: McpRepo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: r.node_id,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    owner: { login: r.owner.login, id: r.owner.id },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function pullJson(p: McpPull): Record<string, unknown> {
  return {
    id: p.id,
    node_id: p.node_id,
    number: p.number,
    pull_number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    head: { ref: p.head.ref, sha: p.head.sha },
    base: { ref: p.base.ref, sha: p.base.sha },
    merged: p.merged,
    merge_commit_sha: p.merge_commit_sha,
    merged_at: p.merged_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Implementasi tool (efek ke store yang sama dengan REST)
// ---------------------------------------------------------------------------

function doCreateRepo(store: McpStore, args: Args): ToolResult {
  const name = argStr(args, 'name');
  if (!name) return { ok: false, message: 'missing required argument: name' };
  const viewer = viewerOf(store);
  if (findRepo(store, viewer.login, name)) {
    return { ok: false, message: `repository ${viewer.login}/${name} already exists` };
  }
  const now = nowIso();
  const id = nextId(store, 'repo');
  const repo: McpRepo = {
    id,
    node_id: nodeId('Repository', id),
    name,
    full_name: `${viewer.login}/${name}`,
    owner: viewer,
    private: argBool(args, 'private') ?? false,
    description: argStr(args, 'description') ?? '',
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    pushed_at: now,
    has_issues: true,
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: [],
    nextIssueNumber: 1,
    nextPullNumber: 1,
  };
  store.repos.set(repo.full_name, repo);
  return { ok: true, data: repoJson(repo) };
}

function doGetRepo(store: McpStore, args: Args): ToolResult {
  const { owner, repo } = ownerRepo(args);
  if (!owner || !repo) return { ok: false, message: 'missing required arguments: owner, repo' };
  const r = findRepo(store, owner, repo);
  if (!r) return { ok: false, message: `repository ${owner}/${repo} not found` };
  return { ok: true, data: repoJson(r) };
}

function doCreateIssue(store: McpStore, args: Args): ToolResult {
  const { owner, repo } = ownerRepo(args);
  const title = argStr(args, 'title');
  const missing: string[] = [];
  if (!owner) missing.push('owner');
  if (!repo) missing.push('repo');
  if (!title) missing.push('title');
  if (missing.length > 0) return { ok: false, message: `missing required arguments: ${missing.join(', ')}` };
  const r = findRepo(store, owner as string, repo as string);
  if (!r) return { ok: false, message: `repository ${owner}/${repo} not found` };
  const now = nowIso();
  const id = nextId(store, 'issue');
  const issue: McpIssue = {
    id,
    node_id: nodeId('Issue', id),
    number: r.nextIssueNumber,
    title: title as string,
    body: argStr(args, 'body') ?? '',
    state: 'open',
    labels: [],
    user: viewerOf(store),
    created_at: now,
    updated_at: now,
    comments: [],
  };
  r.nextIssueNumber += 1;
  r.issues.push(issue);
  r.updated_at = now;
  return { ok: true, data: issueJson(issue) };
}

function doListIssues(store: McpStore, args: Args): ToolResult {
  const { owner, repo } = ownerRepo(args);
  if (!owner || !repo) return { ok: false, message: 'missing required arguments: owner, repo' };
  const r = findRepo(store, owner, repo);
  if (!r) return { ok: false, message: `repository ${owner}/${repo} not found` };
  const state = argStr(args, 'state') ?? 'all';
  const list = r.issues
    .filter((i) => state === 'all' || i.state === state)
    .map((i) => issueJson(i));
  return { ok: true, data: { issues: list, total_count: list.length } };
}

function doCreatePullRequest(store: McpStore, args: Args): ToolResult {
  const { owner, repo } = ownerRepo(args);
  const title = argStr(args, 'title');
  const head = argStr(args, 'head');
  const base = argStr(args, 'base');
  const missing: string[] = [];
  if (!owner) missing.push('owner');
  if (!repo) missing.push('repo');
  if (!title) missing.push('title');
  if (!head) missing.push('head');
  if (!base) missing.push('base');
  if (missing.length > 0) return { ok: false, message: `missing required arguments: ${missing.join(', ')}` };
  const r = findRepo(store, owner as string, repo as string);
  if (!r) return { ok: false, message: `repository ${owner}/${repo} not found` };
  const headSha = r.refs.get(`refs/heads/${head as string}`);
  const baseSha = r.refs.get(`refs/heads/${base as string}`);
  if (!headSha) return { ok: false, message: `head branch ${head} not found` };
  if (!baseSha) return { ok: false, message: `base branch ${base} not found` };
  // File yang berubah head vs base (untuk GET /pulls/{n}/files di REST).
  const headFiles = listFilesAt(r, headSha);
  const baseFiles = listFilesAt(r, baseSha);
  const lineCount = (oid: string): number => {
    const data = r.objects.get(oid)?.data.toString('utf8') ?? '';
    if (data === '') return 0;
    const parts = data.split('\n');
    return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
  };
  const files: McpPullFile[] = [];
  for (const [path, f] of headFiles) {
    const b = baseFiles.get(path);
    if (!b) {
      const additions = Math.max(1, lineCount(f.oid));
      files.push({ filename: path, sha: f.oid, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b.oid !== f.oid) {
      const additions = Math.max(1, lineCount(f.oid));
      const deletions = lineCount(b.oid);
      files.push({ filename: path, sha: f.oid, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const [path, b] of baseFiles) {
    if (!headFiles.has(path)) {
      const deletions = Math.max(1, lineCount(b.oid));
      files.push({ filename: path, sha: b.oid, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const now = nowIso();
  const id = nextId(store, 'pull');
  const pull: McpPull = {
    id,
    node_id: nodeId('PullRequest', id),
    number: r.nextPullNumber,
    title: title as string,
    body: argStr(args, 'body') ?? '',
    state: 'open',
    head: { ref: head as string, sha: headSha },
    base: { ref: base as string, sha: baseSha },
    merged: false,
    mergeable: true,
    merge_commit_sha: null,
    merged_at: null,
    user: viewerOf(store),
    created_at: now,
    updated_at: now,
    files,
  };
  r.nextPullNumber += 1;
  r.pulls.push(pull);
  r.updated_at = now;
  return { ok: true, data: pullJson(pull) };
}

function doMergePullRequest(store: McpStore, args: Args): ToolResult {
  const { owner, repo } = ownerRepo(args);
  const pullNumber = argNum(args, 'pull_number');
  const missing: string[] = [];
  if (!owner) missing.push('owner');
  if (!repo) missing.push('repo');
  if (pullNumber === undefined) missing.push('pull_number');
  if (missing.length > 0) return { ok: false, message: `missing required arguments: ${missing.join(', ')}` };
  const r = findRepo(store, owner as string, repo as string);
  if (!r) return { ok: false, message: `repository ${owner}/${repo} not found` };
  const pr = r.pulls.find((p) => p.number === pullNumber);
  if (!pr) return { ok: false, message: `pull request ${pullNumber} not found` };
  if (pr.merged || pr.state !== 'open') {
    return { ok: false, message: `pull request ${pullNumber} is already ${pr.merged ? 'merged' : pr.state}` };
  }
  const baseTip = r.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = r.refs.get(`refs/heads/${pr.head.ref}`);
  if (!baseTip) return { ok: false, message: `base branch ${pr.base.ref} not found` };
  if (!headTip) return { ok: false, message: `head branch ${pr.head.ref} not found` };

  // Squash merge: terapkan isi file head ke base.
  const baseFiles = listFilesAt(r, baseTip);
  const headFiles = listFilesAt(r, headTip);
  const origBaseFiles = listFilesAt(r, pr.base.sha);
  // Deteksi konflik: file yang diubah head sejak PR dibuat DAN diubah juga di base.
  for (const [path, hf] of headFiles) {
    const orig = origBaseFiles.get(path);
    const cur = baseFiles.get(path);
    if (orig && orig.oid !== hf.oid && cur && cur.oid !== orig.oid && cur.oid !== hf.oid) {
      return { ok: false, message: `merge conflict in ${path}` };
    }
  }
  for (const [path, orig] of origBaseFiles) {
    if (!headFiles.has(path)) {
      const cur = baseFiles.get(path);
      if (cur && cur.oid !== orig.oid) {
        return { ok: false, message: `merge conflict in ${path}` };
      }
    }
  }
  const merged = new Map(baseFiles);
  for (const [path, f] of headFiles) merged.set(path, f);
  for (const [path] of origBaseFiles) {
    if (!headFiles.has(path) && baseFiles.get(path)?.oid === origBaseFiles.get(path)?.oid) {
      merged.delete(path);
    }
  }
  const newTree = buildTree(r, merged);
  const viewer = viewerOf(store);
  const epoch = nowEpochSec();
  const ident = `${viewer.login} <${emailOf(viewer)}> ${epoch} +0000`;
  const commitText =
    `tree ${newTree}\n` +
    `parent ${baseTip}\n` +
    `author ${ident}\n` +
    `committer ${ident}\n` +
    `\n` +
    `Merge pull request #${pr.number}\n`;
  const mergeSha = storeObject(r, 'commit', Buffer.from(commitText, 'utf8'));
  r.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
  const now = nowIso();
  pr.state = 'closed';
  pr.merged = true;
  pr.merge_commit_sha = mergeSha;
  pr.merged_at = now;
  pr.updated_at = now;
  r.updated_at = now;
  r.pushed_at = now;
  return {
    ok: true,
    data: {
      merged: true,
      number: pr.number,
      pull_number: pr.number,
      sha: mergeSha,
      message: `Merge pull request #${pr.number}`,
    },
  };
}

function callTool(store: McpStore, name: string, args: Args): ToolResult {
  switch (name) {
    case 'create_repo':
      return doCreateRepo(store, args);
    case 'get_repo':
      return doGetRepo(store, args);
    case 'create_issue':
      return doCreateIssue(store, args);
    case 'list_issues':
      return doListIssues(store, args);
    case 'create_pull_request':
      return doCreatePullRequest(store, args);
    case 'merge_pull_request':
      return doMergePullRequest(store, args);
    default:
      return { ok: false, message: `unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC + HTTP
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Ambil id dari body JSON yang rusak (untuk parse-error: id 424242). */
function extractId(raw: string): unknown {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return Number(v);
}

export async function mcpHandler(req: IncomingMessage, res: ServerResponse, store: McpStore): Promise<void> {
  const method = req.method ?? 'GET';

  // DELETE /mcp: tutup sesi (legacy, best-effort). Era modern tanpa session:
  // selalu sukses, tanpa efek.
  if (method === 'DELETE') {
    req.resume();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'method not allowed'));
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const text = raw.toString('utf8');

  let msg: unknown;
  try {
    msg = JSON.parse(text) as unknown;
  } catch {
    // Body bukan JSON -> HTTP 400 + JSON-RPC -32700 (id 424242 bila ada).
    sendJson(res, 400, rpcError(extractId(text), -32700, 'Parse error'));
    return;
  }

  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const reqObj = msg as Record<string, unknown>;
  const id = reqObj['id'] ?? null;
  const rpcMethod = reqObj['method'];

  // Notifikasi (tanpa id): tidak ada respons JSON-RPC.
  if (id === null || id === undefined) {
    if (typeof rpcMethod === 'string' && rpcMethod.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  if (typeof rpcMethod !== 'string' || rpcMethod.length === 0) {
    sendJson(res, 200, rpcError(id, -32600, 'Invalid Request'));
    return;
  }

  // Auth diputuskan sebelum tool ada — tapi hanya untuk tools/call (RECON §6.4 #15).
  if (rpcMethod === 'tools/call' && !authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }

  if (rpcMethod === 'server/discover') {
    sendJson(
      res,
      200,
      rpcResult(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    );
    return;
  }

  // Legacy handshake — bukan jalur utama (modern cukup), tapi murah dan menolong
  // bila client jatuh ke fallback: jawab sesuai revisi yang ditawarkan.
  if (rpcMethod === 'initialize') {
    const params = (reqObj['params'] ?? {}) as Record<string, unknown>;
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
    sendJson(
      res,
      200,
      rpcResult(id, {
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2026-07-28',
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      }),
    );
    return;
  }

  if (rpcMethod === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (rpcMethod === 'tools/call') {
    const params = (reqObj['params'] ?? {}) as Record<string, unknown>;
    const name = params['name'];
    const args = (params['arguments'] ?? {}) as Args;
    if (typeof name !== 'string' || name.length === 0) {
      sendJson(res, 200, rpcError(id, -32602, 'Invalid params: tool name is required'));
      return;
    }
    if (!TOOL_NAMES.has(name)) {
      // Unknown tool -> JSON-RPC error -32602 (BUKAN HTTP 500).
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    if (typeof params['arguments'] !== 'object' || params['arguments'] === null || Array.isArray(params['arguments'])) {
      sendJson(res, 200, rpcError(id, -32602, 'Invalid params: arguments must be an object'));
      return;
    }
    // Tanpa state global per-request: semua state hidup di `store` yang dioper
    // masuk; dua call bersamaan tidak bisa tertukar id/argumennya.
    const out = callTool(store, name, args);
    if (!out.ok) {
      // Tool gagal = isError:true dalam result (bukan JSON-RPC error).
      const textOut = JSON.stringify({ error: out.message });
      sendJson(
        res,
        200,
        rpcResult(id, {
          content: [{ type: 'text', text: textOut }],
          structuredContent: { error: out.message },
          isError: true,
        }),
      );
      return;
    }
    const textOut = JSON.stringify(out.data);
    sendJson(
      res,
      200,
      rpcResult(id, {
        content: [{ type: 'text', text: textOut }],
        structuredContent: out.data,
        isError: false,
      }),
    );
    return;
  }

  // Method tak dikenal -> -32601 (server/discover yang dijawab -32601 juga
  // memicu fallback legacy di client; di sini discover selalu sukses).
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${rpcMethod}`));
}
