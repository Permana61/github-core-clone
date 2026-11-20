// GraphQL v4 (GitHub API) — hand-written, stdlib only, no GraphQL library.
//
// One shared in-memory store with REST/MCP/git: the Store from ./store.ts
// (the same Repo/Issue/Pull/Comment objects REST reads and writes) and the
// git-object helpers from ./git-objects.ts (listFilesAt / applyFileChange —
// the same helpers REST uses for diffs and squash merges, so GraphQL and
// REST can never disagree about files, conflicts, or merge commits).
// It never touches Date.now()/Math.random(); every timestamp comes from
// store.now / MAKEFUN_TRIAL_NOW.
//
// Exports:
//   executeGraphQL({query, variables, operationName}, store, opts)
//     -> {data, errors}   (pure executor, no HTTP)
//   createGraphQLHandler(store, opts) -> (req, res) => void
//     HTTP wrapper: POST /api/graphql only, Bearer auth (401 without token),
//     single operation or batched array (answers in order).
//   handleGraphQLRequest(req, res, store, opts)
//
// Supported documents: the 16 verbatim documents in RECON.md §5.1 plus
// variations (aliases, $variables, inline enums, inline fragments
// `... on Repository`, named fragments). Unknown fields / bad arguments are
// GraphQL-level errors: HTTP 200 + errors[{message}] naming the bad field.

import { applyFileChange, listFilesAt } from './git-objects.ts';
import { invalidateIssue } from './rest.ts';
import type { Comment, Issue, Label, Pull, PullFile, Repo, Store, User } from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Store types re-exported under the Gql* names (kept for import compat).
export type GqlStore = Store;
export type GqlRepo = Repo;
export type GqlIssue = Issue;
export type GqlPull = Pull;
export type GqlPullFile = PullFile;
export type GqlComment = Comment;
export type GqlUser = User;
export type GqlLabel = Label;

export interface GraphQLOptions {
  /** Expected bearer token. Defaults to process.env.MAKEFUN_SHOP_TOKEN.
   *  When unset, any non-empty Bearer header is accepted (RECON §8.2). */
  token?: string;
  /** Override the viewer (defaults to store.viewer, else adaiversen). */
  viewer?: User;
}

export interface GqlErrorOut {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors: GqlErrorOut[];
}

// ---------------------------------------------------------------------------
// Small helpers: ids, time, base64
// ---------------------------------------------------------------------------

const FALLBACK_NOW = '2026-11-14T06:30:00.000Z';
const VIEWER_LOGIN = 'adaiversen';

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string | null {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function nowIso(store: Store): string {
  return store.now || process.env.MAKEFUN_TRIAL_NOW || FALLBACK_NOW;
}

function getViewer(store: Store, opts: GraphQLOptions): User {
  if (opts.viewer) return opts.viewer;
  if (store.viewer) return store.viewer;
  return { login: VIEWER_LOGIN, id: 1000, node_id: '', type: 'User', name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid` };
}

/** Opaque Relay global id via the store (base64url("Kind:key")). */
function gid(store: Store, kind: string, key: string): string {
  return store.globalId(kind, key);
}

// node_id formats must match REST exactly (see rest.ts), so an object created
// over REST and read over GraphQL (or vice versa) always shows the same id:
//   Repository "5000", Issue "5000:3", PullRequest "5000:2",
//   IssueComment "5000:1:42", User "1000".
function repoNodeId(store: Store, repo: Repo): string {
  return repo.node_id || gid(store, 'Repository', String(repo.id));
}

function issueNodeId(store: Store, repo: Repo | undefined, issue: Issue): string {
  if (issue.node_id) return issue.node_id;
  if (repo) return gid(store, 'Issue', `${repo.id}:${issue.number}`);
  return gid(store, 'Issue', String(issue.id));
}

function pullNodeId(store: Store, repo: Repo | undefined, pull: Pull): string {
  if (pull.node_id) return pull.node_id;
  if (repo) return gid(store, 'PullRequest', `${repo.id}:${pull.number}`);
  return gid(store, 'PullRequest', String(pull.id));
}

function commentNodeId(store: Store, repo: Repo | undefined, issue: Issue | undefined, comment: Comment): string {
  if (comment.node_id) return comment.node_id;
  if (repo && issue) return gid(store, 'IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
  return gid(store, 'IssueComment', String(comment.id));
}

function userNodeId(store: Store, user: User): string {
  return user.node_id || gid(store, 'User', String(user.id));
}

interface ParsedGlobalId {
  kind: string;
  key: string;
}

function fromGlobalId(store: Store, raw: string): ParsedGlobalId | null {
  try {
    const v = store.parseGlobalId(raw);
    if (v) return { kind: v.kind, key: v.key };
  } catch { /* fall through to local decode */ }
  const decoded = b64urlDecode(raw);
  if (!decoded) return null;
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
}

function allRepos(store: Store): Repo[] {
  return [...store.repos.values()];
}

function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name) ?? allRepos(store).find((x) => x.name === name && x.owner.login === owner);
}

function findRepoByGlobalId(store: Store, raw: string): Repo | undefined {
  const p = fromGlobalId(store, raw);
  if (!p || p.kind !== 'Repository') return undefined;
  return allRepos(store).find((x) => x.id === Number(p.key));
}

function findIssueByGlobalId(store: Store, raw: string): { repo: Repo; issue: Issue } | undefined {
  const p = fromGlobalId(store, raw);
  if (!p || p.kind !== 'Issue') return undefined;
  const parts = p.key.split(':');
  if (parts.length === 2) {
    const repo = allRepos(store).find((r) => r.id === Number(parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(parts[1]));
    if (repo && issue) return { repo, issue };
  }
  const num = Number(p.key);
  if (Number.isInteger(num)) {
    for (const repo of allRepos(store)) {
      const issue = repo.issues.find((i) => i.id === num);
      if (issue) return { repo, issue };
    }
  }
  return undefined;
}

function findPullByGlobalId(store: Store, raw: string): { repo: Repo; pull: Pull } | undefined {
  const p = fromGlobalId(store, raw);
  if (!p || p.kind !== 'PullRequest') return undefined;
  const parts = p.key.split(':');
  if (parts.length === 2) {
    const repo = allRepos(store).find((r) => r.id === Number(parts[0]));
    const pull = repo?.pulls.find((x) => x.number === Number(parts[1]));
    if (repo && pull) return { repo, pull };
  }
  const num = Number(p.key);
  if (Number.isInteger(num)) {
    for (const repo of allRepos(store)) {
      const pull = repo.pulls.find((x) => x.id === num);
      if (pull) return { repo, pull };
    }
  }
  return undefined;
}

function findCommentByGlobalId(store: Store, raw: string): { repo: Repo; issue: Issue; comment: Comment } | undefined {
  const p = fromGlobalId(store, raw);
  if (!p || p.kind !== 'IssueComment') return undefined;
  const parts = p.key.split(':');
  if (parts.length === 3) {
    const repo = allRepos(store).find((r) => r.id === Number(parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(parts[1]));
    const comment = issue?.comments.find((c) => c.id === Number(parts[2]));
    if (repo && issue && comment) return { repo, issue, comment };
  }
  const num = Number(p.key);
  if (Number.isInteger(num)) {
    for (const repo of allRepos(store)) {
      for (const issue of repo.issues) {
        const comment = issue.comments.find((c) => c.id === num);
        if (comment) return { repo, issue, comment };
      }
    }
  }
  return undefined;
}

// Numeric ids come from the store counters — the same counters REST uses —
// so a GraphQL-created object can never collide with a REST-created one.
function allocIssueId(store: Store): number {
  return store.nextIssueId++;
}

function allocPullId(store: Store): number {
  return store.nextPullId++;
}

function allocCommentId(store: Store): number {
  return store.nextCommentId++;
}

// ---------------------------------------------------------------------------
// Git helpers — same rules as REST (rest.ts mergePull / diffFiles), built on
// ./git-objects.ts listFilesAt / applyFileChange. No duplicated tree logic.
// ---------------------------------------------------------------------------

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

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

function diffFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
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
      out.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions, sha: inHead.sha });
    }
  }
  return out;
}

/**
 * 3-way conflict test, identical to REST mergePull: for any file the PR
 * touches, the base moved since the PR was opened AND the head differs from
 * the current base for that same path.
 */
function prConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) return false;
  let baseAtCreation;
  let currentBase;
  let headFiles;
  try {
    baseAtCreation = listFilesAt(repo.objects, pull.base.sha);
    currentBase = listFilesAt(repo.objects, baseTip);
    headFiles = listFilesAt(repo.objects, pull.head.sha);
  } catch {
    return false;
  }
  for (const file of pull.files) {
    const atCreation = baseAtCreation.get(file.filename)?.data ?? null;
    const current = currentBase.get(file.filename)?.data ?? null;
    const head = headFiles.get(file.filename)?.data ?? null;
    if (!buffersEqual(current, atCreation) && !buffersEqual(head, current)) return true;
  }
  return false;
}

function mergeableState(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  if (pull.mergeable === false) return 'CONFLICTING';
  if (!repo.refs.has(`refs/heads/${pull.head.ref}`) || !repo.refs.has(`refs/heads/${pull.base.ref}`)) return 'UNKNOWN';
  return prConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash merge, identical to REST mergePull: chained applyFileChange, one
 * commit per changed file, the final commit carrying the merge message;
 * the base ref advances to it.
 */
function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) throw new Error(`base branch ${pull.base.ref} not found`);
  const headFiles = listFilesAt(repo.objects, pull.head.sha);
  const mergeMessage = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const author = `${store.viewer.name} <${store.viewer.email}>`;
  const ts = Math.floor(Date.parse(nowIso(store)) / 1000);
  let tip = baseTip;
  for (const file of pull.files) {
    const headEntry = headFiles.get(file.filename);
    const result = applyFileChange(
      repo.objects,
      tip,
      file.filename,
      headEntry === undefined ? null : headEntry.data,
      mergeMessage,
      author,
      ts,
    );
    tip = result.commitSha;
  }
  repo.refs.set(`refs/heads/${pull.base.ref}`, tip);
  repo.updated_at = nowIso(store);
  repo.pushed_at = nowIso(store);
  return tip;
}

// ---------------------------------------------------------------------------
// GraphQL parser (minimal, hand-written): tokenizer + recursive descent.
// Supports: query/mutation (+shorthand), operation names, variable
// definitions with defaults, aliases, arguments, enums, lists, objects,
// inline fragments (... on T), fragment spreads + fragment definitions.
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum' | 'null'; value: string | number | boolean | null }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type Selection =
  | { kind: 'field'; name: string; alias?: string; args: { name: string; value: ValueNode }[]; selections: Selection[] }
  | { kind: 'inlineFragment'; typeCondition?: string; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface VarDef {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: VarDef[];
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
  line: number;
  column: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (kind: Token['kind'], value: string, l: number, c: number): void => {
    tokens.push({ kind, value, line: l, column: c });
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { i += 1; line += 1; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; col += 1; continue; }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (ch === '"') {
      // Block string """...""" or plain "...".
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const raw = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        const adv = end < 0 ? src.length - i : end + 3 - i;
        for (const c of raw) if (c === '\n') { line += 1; col = 1; } else col += 1;
        i += adv; col += 3;
        push('string', raw, startLine, startCol);
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '"') { closed = true; break; }
        if (c === '\n') break;
        if (c === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[e] ?? e;
            j += 2;
          }
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new Error(`Unterminated string at ${startLine}:${startCol}`);
      col += j + 1 - i;
      i = j + 1;
      push('string', out, startLine, startCol);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (/[0-9]/.test(src[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < src.length && /[0-9]/.test(src[j])) j += 1;
        }
      }
      const raw = src.slice(i, j);
      col += j - i;
      i = j;
      push(isFloat ? 'float' : 'int', raw, startLine, startCol);
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      col += j - i;
      i = j;
      push('name', raw, startLine, startCol);
      continue;
    }
    if (src.startsWith('...', i)) {
      push('punct', '...', startLine, startCol);
      i += 3; col += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      push('punct', ch, startLine, startCol);
      i += 1; col += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${startLine}:${startCol}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column: col });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  readonly fragments = new Map<string, { typeCondition?: string; selections: Selection[] }>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  private expectPunct(v: string): Token {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected "${v}" but got ${JSON.stringify(t.value)} at ${t.line}:${t.column}`);
    return t;
  }

  private expectName(what = 'name'): Token {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but got ${JSON.stringify(t.value)} at ${t.line}:${t.column}`);
    return t;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name').value;
        const on = this.expectName('"on"');
        if (on.value !== 'on') throw new Error(`Expected "on" in fragment at ${on.line}:${on.column}`);
        const typeCondition = this.expectName('fragment type').value;
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selections });
        continue;
      }
      ops.push(this.parseOperation());
    }
    if (ops.length === 0) throw new Error('Empty GraphQL document');
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n.kind === 'name') name = this.next().value;
    }
    let varDefs: VarDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') varDefs = this.parseVariableDefinitions();
    // Skip directives (@foo...) — not needed by the 16 documents.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('variable name').value;
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') { this.next(); out += '!'; }
      return out;
    }
    const name = this.expectName('type name').value;
    let out = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') { this.next(); out += '!'; }
    return out;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value !== 'on') {
        return { kind: 'spread', name: this.next().value };
      }
      let typeCondition: string | undefined;
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        typeCondition = this.expectName('fragment type').value;
      }
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName('directive name');
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name').value;
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName('field name').value;
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('argument name').value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'var', name: this.expectName('variable name').value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('object field name').value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value ${JSON.stringify(t.value)} at ${t.line}:${t.column}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return variables[node.name];
    case 'list': return node.items.map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
    default: return node.value;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  viewer: User;
  opts: GraphQLOptions;
  errors: GqlErrorOut[];
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
}

// Introspection data: fields that must be present per RECON §5/§5.2.
const TYPE_INFO: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'labels', 'user', 'comments', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email'],
    enumValues: [],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'], enumValues: [] },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'MARKETPLACE', 'PULLREQUEST', 'REPOSITORY', 'USER'],
  },
};

// Wrappers carry __typename + a pointer to the underlying store object.
type Wrap = Record<string, unknown> & { __typename: string };

function repoWrap(repo: Repo): Wrap {
  return { __typename: 'Repository', __repo: repo };
}
function issueWrap(issue: Issue, repo?: Repo): Wrap {
  return { __typename: 'Issue', __issue: issue, __repo: repo };
}
function pullWrap(pull: Pull, repo?: Repo): Wrap {
  return { __typename: 'PullRequest', __pull: pull, __repo: repo };
}
function userWrap(user: User): Wrap {
  return { __typename: 'User', __user: user };
}
function commentWrap(comment: Comment, repo?: Repo, issue?: Issue): Wrap {
  return { __typename: 'IssueComment', __comment: comment, __repo: repo, __issue: issue };
}

function encodeCursor(index: number): string {
  return b64urlEncode(`cursor:${index}`);
}

function decodeCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const decoded = b64urlDecode(raw);
  if (!decoded) return null;
  const m = /^cursor:(\d+)$/.exec(decoded);
  return m ? Number(m[1]) : null;
}

interface ConnectionResult {
  nodes: Wrap[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null };
  totalCount: number;
}

function paginate<T>(items: T[], first: unknown, after: unknown, wrap: (x: T) => Wrap): ConnectionResult {
  let start = 0;
  if (after !== undefined && after !== null) {
    const idx = decodeCursor(after);
    if (idx === null) throw new Error(`Invalid cursor ${JSON.stringify(after)}`);
    start = idx + 1;
  }
  const total = items.length;
  let end = total;
  if (typeof first === 'number') end = Math.min(total, start + Math.max(0, first));
  if (start > total) start = total;
  if (end < start) end = start;
  const slice = items.slice(start, end);
  return {
    nodes: slice.map(wrap),
    pageInfo: {
      hasNextPage: end < total,
      hasPreviousPage: start > 0,
      endCursor: slice.length > 0 ? encodeCursor(start + slice.length - 1) : null,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
    },
    totalCount: total,
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const list = [...issues];
  const ob = (orderBy && typeof orderBy === 'object' ? orderBy as Record<string, unknown> : null);
  const direction = ob?.direction === 'ASC' ? 'ASC' : 'DESC';
  // created_at ties are the norm (store.now is fixed), so number breaks ties.
  list.sort((a, b) => {
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    let cmp = ca < cb ? -1 : ca > cb ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'DESC' ? -cmp : cmp;
  });
  // No orderBy at all: creation order (number ASC), as in IssuesPage.
  if (!ob) list.sort((a, b) => a.number - b.number);
  return list;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Wrap {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  list = sortIssues(list, args.orderBy);
  const page = paginate(list, args.first, args.after, (i) => issueWrap(i, repo));
  return { __typename: 'IssueConnection', __page: page };
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Wrap {
  let list = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => {
      const st = p.merged ? 'MERGED' : p.state.toUpperCase();
      return wanted.has(st) || wanted.has(p.state.toUpperCase());
    });
  }
  list.sort((a, b) => a.number - b.number);
  const page = paginate(list, args.first, args.after, (p) => pullWrap(p, repo));
  return { __typename: 'PullRequestConnection', __page: page };
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

interface FieldDef {
  args?: string[];
  required?: string[];
  resolve: (parent: Wrap, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

const FIELD_DEFS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      resolve: (_p, _a, ctx) => userWrap(ctx.viewer),
    },
    repository: {
      args: ['owner', 'name'],
      required: ['owner', 'name'],
      resolve: (_p, args, ctx) => {
        const repo = findRepo(ctx.store, String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoWrap(repo) : null;
      },
    },
    node: {
      args: ['id'],
      required: ['id'],
      resolve: (_p, args, ctx) => {
        const raw = String(args.id ?? '');
        const parsed = fromGlobalId(ctx.store, raw);
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = allRepos(ctx.store).find((r) => r.id === Number(parsed.key));
          return repo ? repoWrap(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const hit = findIssueByGlobalId(ctx.store, raw);
          return hit ? issueWrap(hit.issue, hit.repo) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const hit = findPullByGlobalId(ctx.store, raw);
          return hit ? pullWrap(hit.pull, hit.repo) : null;
        }
        if (parsed.kind === 'IssueComment') {
          const hit = findCommentByGlobalId(ctx.store, raw);
          return hit ? commentWrap(hit.comment, hit.repo, hit.issue) : null;
        }
        if (parsed.kind === 'User' && Number(parsed.key) === ctx.viewer.id) return userWrap(ctx.viewer);
        return null;
      },
    },
    __type: {
      args: ['name'],
      required: ['name'],
      resolve: (_p, args) => {
        const name = String(args.name ?? '');
        if (!TYPE_INFO[name]) return null;
        return { __typename: '__Type', __typeName: name };
      },
    },
  },
  Mutation: {
    createIssue: {
      args: ['input'],
      required: ['input'],
      resolve: (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error(`repository not found for id ${String(input.repositoryId ?? '')}`);
        const title = String(input.title ?? '');
        if (!title) throw new Error('createIssue requires a title');
        const now = nowIso(ctx.store);
        const number = repo.nextIssueNumber++;
        const issue: Issue = {
          id: allocIssueId(ctx.store),
          node_id: '',
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          user: ctx.viewer,
          created_at: now,
          updated_at: now,
          comments: [],
        };
        issue.node_id = gid(ctx.store, 'Issue', `${repo.id}:${number}`);
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', __issue: issue, __repo: repo };
      },
    },
    closeIssue: {
      args: ['input'],
      required: ['input'],
      resolve: (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findIssueByGlobalId(ctx.store, String(input.issueId ?? ''));
        if (!hit) throw new Error(`issue not found for id ${String(input.issueId ?? '')}`);
        hit.issue.state = 'closed';
        hit.issue.updated_at = nowIso(ctx.store);
        invalidateIssue(hit.issue);
        return { __typename: 'CloseIssuePayload', __issue: hit.issue, __repo: hit.repo };
      },
    },
    createPullRequest: {
      args: ['input'],
      required: ['input'],
      resolve: (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error(`repository not found for id ${String(input.repositoryId ?? '')}`);
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const title = String(input.title ?? '');
        if (!headRef || !baseRef) throw new Error('createPullRequest requires headRefName and baseRefName');
        if (!title) throw new Error('createPullRequest requires a title');
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headSha) throw new Error(`head branch ${headRef} not found`);
        if (!baseSha) throw new Error(`base branch ${baseRef} not found`);
        const now = nowIso(ctx.store);
        const number = repo.nextPullNumber++;
        const pull: Pull = {
          id: allocPullId(ctx.store),
          node_id: '',
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          head: { ref: headRef, sha: headSha },
          base: { ref: baseRef, sha: baseSha },
          merged: false,
          mergeable: true,
          merged_at: null,
          merge_commit_sha: null,
          user: ctx.viewer,
          created_at: now,
          updated_at: now,
          files: diffFiles(repo, baseSha, headSha),
        };
        pull.node_id = gid(ctx.store, 'PullRequest', `${repo.id}:${number}`);
        repo.pulls.push(pull);
        return { __typename: 'CreatePullRequestPayload', __pull: pull, __repo: repo };
      },
    },
    mergePullRequest: {
      args: ['input'],
      required: ['input'],
      resolve: (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findPullByGlobalId(ctx.store, String(input.pullRequestId ?? ''));
        if (!hit) throw new Error(`pull request not found for id ${String(input.pullRequestId ?? '')}`);
        const { repo, pull } = hit;
        if (pull.merged) return { __typename: 'MergePullRequestPayload', __pull: pull, __repo: repo };
        if (prConflicts(repo, pull)) {
          pull.mergeable = false;
          throw new Error(`Merge conflict: pull request #${pull.number} cannot be merged into ${pull.base.ref}`);
        }
        const mergeSha = squashMerge(ctx.store, repo, pull);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeable = true;
        pull.merged_at = nowIso(ctx.store);
        pull.merge_commit_sha = mergeSha;
        pull.updated_at = nowIso(ctx.store);
        return { __typename: 'MergePullRequestPayload', __pull: pull, __repo: repo };
      },
    },
    addComment: {
      args: ['input'],
      required: ['input'],
      resolve: (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findIssueByGlobalId(ctx.store, String(input.subjectId ?? ''));
        if (!hit) throw new Error(`subject not found for id ${String(input.subjectId ?? '')}`);
        const body = String(input.body ?? '');
        if (!body) throw new Error('addComment requires a body');
        const now = nowIso(ctx.store);
        const comment: Comment = {
          id: allocCommentId(ctx.store),
          node_id: '',
          body,
          user: ctx.viewer,
          created_at: now,
          updated_at: now,
        };
        comment.node_id = gid(ctx.store, 'IssueComment', `${hit.repo.id}:${hit.issue.number}:${comment.id}`);
        hit.issue.comments.push(comment);
        invalidateIssue(hit.issue);
        return { __typename: 'AddCommentPayload', __comment: comment, __issue: hit.issue, __repo: hit.repo };
      },
    },
  },
  Repository: {
    id: { resolve: (p, _a, ctx) => repoNodeId(ctx.store, p.__repo as Repo) },
    databaseId: { resolve: (p) => (p.__repo as Repo).id },
    name: { resolve: (p) => (p.__repo as Repo).name },
    nameWithOwner: { resolve: (p) => `${(p.__repo as Repo).owner.login}/${(p.__repo as Repo).name}` },
    owner: { resolve: (p) => userWrap((p.__repo as Repo).owner) },
    defaultBranchRef: { resolve: (p) => ({ __typename: 'Ref', name: (p.__repo as Repo).default_branch }) },
    viewerPermission: { resolve: () => 'ADMIN' },
    hasIssuesEnabled: { resolve: (p) => (p.__repo as Repo).has_issues ?? true },
    description: { resolve: (p) => (p.__repo as Repo).description ?? '' },
    private: { resolve: (p) => (p.__repo as Repo).private ?? false },
    createdAt: { resolve: (p) => (p.__repo as Repo).created_at ?? null },
    updatedAt: { resolve: (p) => (p.__repo as Repo).updated_at ?? null },
    issue: {
      args: ['number'],
      required: ['number'],
      resolve: (p, args) => {
        const repo = p.__repo as Repo;
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueWrap(issue, repo) : null;
      },
    },
    issues: {
      args: ['first', 'after', 'states', 'orderBy'],
      resolve: (p, args, ctx) => issuesConnection(ctx, p.__repo as Repo, args),
    },
    pullRequests: {
      args: ['first', 'after', 'states', 'orderBy'],
      resolve: (p, args, ctx) => pullsConnection(ctx, p.__repo as Repo, args),
    },
    pullRequest: {
      args: ['number'],
      required: ['number'],
      resolve: (p, args) => {
        const repo = p.__repo as Repo;
        const pull = repo.pulls.find((x) => x.number === Number(args.number));
        return pull ? pullWrap(pull, repo) : null;
      },
    },
  },
  User: {
    id: { resolve: (p, _a, ctx) => userNodeId(ctx.store, p.__user as User) },
    login: { resolve: (p) => (p.__user as User).login },
    name: { resolve: (p) => (p.__user as User).name ?? (p.__user as User).login },
    email: { resolve: (p) => (p.__user as User).email ?? `${(p.__user as User).login}@example.invalid` },
  },
  Issue: {
    id: { resolve: (p, _a, ctx) => issueNodeId(ctx.store, p.__repo as Repo | undefined, p.__issue as Issue) },
    databaseId: { resolve: (p) => (p.__issue as Issue).id },
    number: { resolve: (p) => (p.__issue as Issue).number },
    title: { resolve: (p) => (p.__issue as Issue).title },
    body: { resolve: (p) => (p.__issue as Issue).body ?? '' },
    state: { resolve: (p) => (p.__issue as Issue).state.toUpperCase() },
    labels: {
      resolve: (p) => (p.__issue as Issue).labels.map((l) => ({ __typename: 'Label', __label: l })),
    },
    user: { resolve: (p) => userWrap((p.__issue as Issue).user) },
    comments: {
      args: ['first'],
      resolve: (p) => {
        const issue = p.__issue as Issue;
        return issue.comments.map((c) => commentWrap(c, p.__repo as Repo | undefined, issue));
      },
    },
    createdAt: { resolve: (p) => (p.__issue as Issue).created_at ?? null },
    updatedAt: { resolve: (p) => (p.__issue as Issue).updated_at ?? null },
  },
  Label: {
    id: { resolve: (p, _a, ctx) => (p.__label as Label).node_id || gid(ctx.store, 'Label', String((p.__label as Label).id)) },
    name: { resolve: (p) => (p.__label as Label).name },
    color: { resolve: (p) => (p.__label as Label).color ?? '' },
    description: { resolve: (p) => (p.__label as Label).description ?? '' },
  },
  IssueComment: {
    id: { resolve: (p, _a, ctx) => commentNodeId(ctx.store, p.__repo as Repo | undefined, p.__issue as Issue | undefined, p.__comment as Comment) },
    body: { resolve: (p) => (p.__comment as Comment).body },
  },
  PullRequest: {
    id: { resolve: (p, _a, ctx) => pullNodeId(ctx.store, p.__repo as Repo | undefined, p.__pull as Pull) },
    databaseId: { resolve: (p) => (p.__pull as Pull).id },
    number: { resolve: (p) => (p.__pull as Pull).number },
    title: { resolve: (p) => (p.__pull as Pull).title },
    body: { resolve: (p) => (p.__pull as Pull).body ?? '' },
    state: { resolve: (p) => prState(p.__pull as Pull) },
    merged: { resolve: (p) => (p.__pull as Pull).merged },
    mergeable: {
      resolve: (p) => {
        const repo = p.__repo as Repo | undefined;
        if (!repo) return 'UNKNOWN';
        return mergeableState(repo, p.__pull as Pull);
      },
    },
    headRefName: { resolve: (p) => (p.__pull as Pull).head.ref },
    baseRefName: { resolve: (p) => (p.__pull as Pull).base.ref },
    headRefOid: { resolve: (p) => (p.__pull as Pull).head.sha },
    baseRefOid: { resolve: (p) => (p.__pull as Pull).base.sha },
    files: {
      args: ['first'],
      resolve: (p, args) => {
        const files = (p.__pull as Pull).files ?? [];
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, Math.max(0, first)).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename }));
        return { __typename: 'PullRequestChangedFileConnection', __nodes: nodes };
      },
    },
    createdAt: { resolve: (p) => (p.__pull as Pull).created_at ?? null },
    updatedAt: { resolve: (p) => (p.__pull as Pull).updated_at ?? null },
  },
  PullRequestChangedFile: {
    path: { resolve: (p) => (p as { path: string }).path },
  },
  PullRequestChangedFileConnection: {
    nodes: { resolve: (p) => (p as { __nodes: Wrap[] }).__nodes },
  },
  IssueConnection: {
    nodes: { resolve: (p) => (p as { __page: ConnectionResult }).__page.nodes },
    pageInfo: {
      resolve: (p) => ({ __typename: 'PageInfo', ...(p as { __page: ConnectionResult }).__page.pageInfo }),
    },
    totalCount: { resolve: (p) => (p as { __page: ConnectionResult }).__page.totalCount },
  },
  PullRequestConnection: {
    nodes: { resolve: (p) => (p as { __page: ConnectionResult }).__page.nodes },
    pageInfo: {
      resolve: (p) => ({ __typename: 'PageInfo', ...(p as { __page: ConnectionResult }).__page.pageInfo }),
    },
    totalCount: { resolve: (p) => (p as { __page: ConnectionResult }).__page.totalCount },
  },
  PageInfo: {
    hasNextPage: { resolve: (p) => (p as { hasNextPage: boolean }).hasNextPage },
    hasPreviousPage: { resolve: (p) => (p as { hasPreviousPage: boolean }).hasPreviousPage },
    endCursor: { resolve: (p) => (p as { endCursor: string | null }).endCursor },
    startCursor: { resolve: (p) => (p as { startCursor: string | null }).startCursor },
  },
  Ref: {
    name: { resolve: (p) => (p as { name: string }).name },
  },
  __Type: {
    name: { resolve: (p) => (p as { __typeName: string }).__typeName },
    kind: { resolve: (p) => TYPE_INFO[(p as { __typeName: string }).__typeName].kind },
    description: { resolve: () => null },
    fields: {
      args: ['includeDeprecated'],
      resolve: (p) => {
        const info = TYPE_INFO[(p as { __typeName: string }).__typeName];
        if (info.kind === 'ENUM') return null;
        return info.fields.map((name) => ({ __typename: '__Field', name }));
      },
    },
    enumValues: {
      args: ['includeDeprecated'],
      resolve: (p) => {
        const info = TYPE_INFO[(p as { __typeName: string }).__typeName];
        if (info.kind !== 'ENUM') return null;
        return info.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      },
    },
  },
  __Field: {
    name: { resolve: (p) => (p as { name: string }).name },
    description: { resolve: () => null },
  },
  __EnumValue: {
    name: { resolve: (p) => (p as { name: string }).name },
    description: { resolve: () => null },
  },
  CreateIssuePayload: {
    issue: { resolve: (p) => issueWrap((p as { __issue: Issue }).__issue, (p as { __repo: Repo }).__repo) },
    clientMutationId: { resolve: () => null },
  },
  CloseIssuePayload: {
    issue: { resolve: (p) => issueWrap((p as { __issue: Issue }).__issue, (p as { __repo: Repo }).__repo) },
    clientMutationId: { resolve: () => null },
  },
  CreatePullRequestPayload: {
    pullRequest: { resolve: (p) => pullWrap((p as { __pull: Pull }).__pull, (p as { __repo: Repo }).__repo) },
    clientMutationId: { resolve: () => null },
  },
  MergePullRequestPayload: {
    pullRequest: { resolve: (p) => pullWrap((p as { __pull: Pull }).__pull, (p as { __repo: Repo }).__repo) },
    clientMutationId: { resolve: () => null },
  },
  AddCommentPayload: {
    commentEdge: {
      resolve: (p) => ({ __typename: 'IssueCommentEdge', __comment: (p as { __comment: Comment }).__comment, __repo: (p as { __repo: Repo }).__repo, __issue: (p as { __issue: Issue }).__issue }),
    },
    comment: { resolve: (p) => commentWrap((p as { __comment: Comment }).__comment, (p as { __repo: Repo }).__repo, (p as { __issue: Issue }).__issue) },
    clientMutationId: { resolve: () => null },
  },
  IssueCommentEdge: {
    node: { resolve: (p) => commentWrap((p as { __comment: Comment }).__comment, (p as { __repo: Repo }).__repo, (p as { __issue: Issue }).__issue) },
    cursor: { resolve: () => null },
  },
};

function executeSelectionSet(
  typename: string,
  parent: Wrap,
  selections: Selection[],
  path: (string | number)[],
  ctx: Ctx,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typename) continue;
      Object.assign(out, executeSelectionSet(typename, parent, sel.selections, path, ctx, variables));
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path: [...path] });
        continue;
      }
      if (frag.typeCondition && frag.typeCondition !== typename) continue;
      Object.assign(out, executeSelectionSet(typename, parent, frag.selections, path, ctx, variables));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    const def = FIELD_DEFS[typename]?.[sel.name];
    if (!def) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${typename}".`,
        path: fieldPath,
      });
      continue;
    }
    const args: Record<string, unknown> = {};
    let argError = false;
    for (const a of sel.args) {
      if (def.args && !def.args.includes(a.name)) {
        ctx.errors.push({
          message: `Unknown argument "${a.name}" on field "${typename}.${sel.name}".`,
          path: fieldPath,
        });
        argError = true;
        continue;
      }
      args[a.name] = resolveValue(a.value, variables);
    }
    if (argError) continue;
    for (const req of def.required ?? []) {
      if (args[req] === undefined || args[req] === null) {
        ctx.errors.push({
          message: `Field "${sel.name}" argument "${req}" of type "${req}!" is required but not provided.`,
          path: fieldPath,
        });
        argError = true;
      }
    }
    if (argError) continue;
    let value: unknown;
    try {
      value = def.resolve(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: fieldPath,
      });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, sel.selections, fieldPath, ctx, variables);
  }
  return out;
}

function completeValue(
  value: unknown,
  selections: Selection[],
  path: (string | number)[],
  ctx: Ctx,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (v && typeof v === 'object' && (v as Wrap).__typename) {
        return executeSelectionSet((v as Wrap).__typename, v as Wrap, selections, [...path, i], ctx, variables);
      }
      return v;
    });
  }
  if (typeof value === 'object' && (value as Wrap).__typename) {
    return executeSelectionSet((value as Wrap).__typename, value as Wrap, selections, path, ctx, variables);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public executor
// ---------------------------------------------------------------------------

export interface GraphQLRequest {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(
  req: GraphQLRequest,
  store: Store,
  opts: GraphQLOptions = {},
): GqlResult {
  const ctx: Ctx = {
    store,
    viewer: getViewer(store, opts),
    opts,
    errors: [],
    fragments: new Map(),
  };
  if (typeof req.query !== 'string' || !req.query.trim()) {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let operations: Operation[];
  let parser: Parser;
  try {
    parser = new Parser(tokenize(req.query));
    operations = parser.parseDocument();
    ctx.fragments = parser.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variables: Record<string, unknown> = { ...(req.variables ?? {}) };
  let op: Operation | undefined;
  if (req.operationName) {
    op = operations.find((o) => o.name === req.operationName);
    if (!op) {
      return { data: null, errors: [{ message: `Unknown operation named "${req.operationName}".` }] };
    }
  } else {
    if (operations.length > 1) {
      return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    op = operations[0];
  }
  // Apply variable defaults.
  for (const vd of op.varDefs) {
    if (variables[vd.name] === undefined && vd.defaultValue !== undefined) {
      variables[vd.name] = resolveValue(vd.defaultValue, variables);
    }
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Wrap = { __typename: rootType };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(rootType, root, op.selections, [], ctx, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------
// HTTP wrapper: POST /api/graphql only
// ---------------------------------------------------------------------------

let requestSeq = 0;

function expectedToken(opts: GraphQLOptions): string | undefined {
  if (opts.token) return opts.token;
  const env = process.env.MAKEFUN_SHOP_TOKEN;
  return env ? env : undefined;
}

function isAuthorized(req: IncomingMessage, opts: GraphQLOptions): boolean {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header ?? '';
  const m = /^Bearer\s+(.+)$/.exec(value.trim());
  if (!m || !m[1]) return false;
  const expected = expectedToken(opts);
  if (!expected) return true; // token unknown to this process: any Bearer passes
  return m[1] === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `gql-${requestSeq}`,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleGraphQLRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  opts: GraphQLOptions = {},
): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { data: null, errors: [{ message: 'Method not allowed: GraphQL requires POST' }] });
    return;
  }
  if (!isAuthorized(req, opts)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { data: null, errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    // Batched operations: answer in the same order.
    const results = parsed.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as GraphQLRequest).query !== 'string') {
        return { data: null, errors: [{ message: 'Must provide query string.' }] } satisfies GqlResult;
      }
      return executeGraphQL(entry as GraphQLRequest, store, opts);
    });
    sendJson(res, 200, results);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as GraphQLRequest).query !== 'string') {
    sendJson(res, 400, { data: null, errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  const result = executeGraphQL(parsed as GraphQLRequest, store, opts);
  sendJson(res, 200, result);
}

/** Mountable handler for app.ts: `if (method === 'POST' && path === '/api/graphql') return handleGraphQLRequest(req, res, store);` */
export function createGraphQLHandler(
  store: Store,
  opts: GraphQLOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void handleGraphQLRequest(req, res, store, opts);
  };
}
