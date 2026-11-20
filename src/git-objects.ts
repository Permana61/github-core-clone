// git-objects.ts — object store + packfile, implemented by hand from the git
// format (see RECON.md §2.9/§2.10). Stdlib only: node:crypto, node:zlib.
// No Date.now() / Math.random() anywhere: object ids are pure SHA-1 of content.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 object id: sha1("<type> <len>\0" + data). */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function encodeObject(type: GitObjectType, data: Buffer): GitObject {
  return { type, data: Buffer.from(data) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Git tree sort: directory names compare as if they ended with '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const nul = data.indexOf(0, off);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const head = data.subarray(off, nul).toString('utf8');
    const sp = head.indexOf(' ');
    if (sp < 0) throw new Error('malformed tree entry');
    out.push({ mode: head.slice(0, sp), name: head.slice(sp + 1), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------- commits / tags

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function encodeCommit(c: CommitData): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\n`;
  s += `committer ${c.committer}\n`;
  s += `\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!tree) throw new Error('commit without tree');
  return { tree, parents, author, committer, message };
}

export interface TagData {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfile

function encodeVarintSize(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  bytes.push(((typeCode & 0x7) << 4) | (size & 0x0f));
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(rest & 0x7f);
    rest = Math.floor(rest / 128);
  }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return Buffer.from(bytes);
}

function decodeVarintSize(buf: Buffer, off: number): { type: number; size: number; next: number } {
  const b0 = buf[off];
  const type = (b0 >> 4) & 0x7;
  let size = b0 & 0x0f;
  let shift = 4;
  let i = off;
  while (buf[i] & 0x80) {
    i += 1;
    size |= (buf[i] & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: i + 1 };
}

function decodeOfsOffset(buf: Buffer, off: number): { offset: number; next: number } {
  let i = off;
  let offset = buf[i] & 0x7f;
  while (buf[i] & 0x80) {
    i += 1;
    offset = ((offset + 1) << 7) | (buf[i] & 0x7f);
  }
  return { offset, next: i + 1 };
}

function decodeDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i];
    i += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: i };
}

/** Apply a standard git delta. Validates source and target sizes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = decodeDeltaVarint(delta, 0);
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const tgt = decodeDeltaVarint(delta, src.next);
  const out: Buffer[] = [];
  let total = 0;
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) { cpOff |= delta[i++] << (8 * b); }
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) { cpSize |= delta[i++] << (8 * b); }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(i, i + op));
      i += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgt.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Write a pack v2: header + whole-object entries (no deltas) + SHA-1 trailer. */
export function writePack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list: { sha: string; obj: GitObject }[] = [];
  if (objects instanceof Map) {
    for (const [sha, obj] of objects) list.push({ sha, obj });
  } else {
    for (const obj of objects) list.push({ sha: objectId(obj.type, obj.data), obj });
  }
  list.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { obj } of list) {
    parts.push(encodeVarintSize(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a packfile (v2/v3), verifying the trailer checksum. Supports OFS_DELTA
 *  and REF_DELTA (including chains); REF_DELTA bases may come from `external`. */
export function readPack(buf: Buffer, external?: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack-checksum');

  const fast = readPackFast(buf, count);
  if (fast !== null) return fast;
  return readPackFull(buf, count, external);
}

/**
 * Fast path for delta-free packs (the only kind the bench and the suite
 * client ever send): one pass, no resolve machinery, no per-entry Maps or
 * closures. Returns null when any entry is a delta, so the caller falls
 * back to the full reader. Header and trailer were already verified by
 * readPack. Error strings match the full reader's for the same input.
 */
function readPackFast(buf: Buffer, count: number): Map<string, GitObject> | null {
  const out = new Map<string, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n++) {
    const { type, size, next } = decodeVarintSize(buf, off);
    off = next;
    if (type === 6 || type === 7) return null;
    const code = CODE_TYPES[type];
    if (code === undefined) throw new Error(`unknown pack entry type ${type}`);
    const { data: inflated, next: nextOff } = inflateAt(buf, off);
    off = nextOff;
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    out.set(objectId(code, inflated), { type: code, data: inflated });
  }
  if (off !== buf.length - 20) throw new Error('pack trailing bytes');
  return out;
}

/** Full reader: delta resolution (OFS/REF, chains), external bases. */
function readPackFull(buf: Buffer, count: number, external?: Map<string, GitObject>): Map<string, GitObject> {
  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer; // inflated bytes (object data or delta instructions)
    baseSha?: string;
    baseOffset?: number;
  }
  const raw: RawEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    const entryOffset = off;
    const { type, size, next } = decodeVarintSize(buf, off);
    off = next;
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      const d = decodeOfsOffset(buf, off);
      baseOffset = entryOffset - d.offset;
      off = d.next;
    } else if (type === 7) {
      baseSha = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!(type in CODE_TYPES)) {
      throw new Error(`unknown pack entry type ${type}`);
    }
    const { data: inflated, next: nextOff } = inflateAt(buf, off);
    off = nextOff;
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ offset: entryOffset, typeCode: type, data: inflated, baseSha, baseOffset });
  }
  if (off !== buf.length - 20) throw new Error('pack trailing bytes');

  const byOffset = new Map<number, number>();
  raw.forEach((e, i) => byOffset.set(e.offset, i));
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (i: number): GitObject => {
    const done = resolved.get(i);
    if (done) return done;
    if (resolving.has(i)) throw new Error('delta cycle');
    resolving.add(i);
    const e = raw[i];
    let obj: GitObject;
    if (e.typeCode === 6 || e.typeCode === 7) {
      let base: GitObject | undefined;
      if (e.baseOffset !== undefined) {
        const bi = byOffset.get(e.baseOffset);
        if (bi === undefined) throw new Error('ofs-delta base missing');
        base = resolve(bi);
      } else if (e.baseSha !== undefined) {
        base = external?.get(e.baseSha);
        if (!base) {
          // base may also be an entry in this pack (by sha, computed lazily)
          for (let j = 0; j < raw.length; j++) {
            if (j === i || raw[j].typeCode === 6 || raw[j].typeCode === 7) continue;
            const cand = resolve(j);
            if (objectId(cand.type, cand.data) === e.baseSha) { base = cand; break; }
          }
        }
        if (!base) throw new Error('ref-delta base missing');
      } else {
        throw new Error('delta without base');
      }
      obj = { type: base.type, data: applyDelta(base.data, e.data) };
    } else {
      obj = { type: CODE_TYPES[e.typeCode], data: e.data };
    }
    resolving.delete(i);
    resolved.set(i, obj);
    return obj;
  };

  const out = new Map<string, GitObject>();
  for (let i = 0; i < raw.length; i++) {
    const obj = resolve(i);
    out.set(objectId(obj.type, obj.data), obj);
  }
  return out;
}

export const parsePack = readPack;
export const createPack = writePack;

// Inflate one zlib stream starting at `off`; returns its bytes and the offset
// just past the stream end (from the engine's bytesWritten count).
function inflateAt(buf: Buffer, off: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(off), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: off + result.engine.bytesWritten };
}

// ---------------------------------------------------------------- high-level ops

export interface AuthorInput {
  name: string;
  email: string;
}
function formatIdent(author: string | AuthorInput, timestampSec: number): string {
  const base = typeof author === 'string' ? author : `${author.name} <${author.email}>`;
  return `${base} ${timestampSec} +0000`;
}

function treeEntriesOf(objects: Map<string, GitObject>, treeSha: string | null): TreeEntry[] {
  if (!treeSha) return [];
  const obj = objects.get(treeSha);
  if (!obj || obj.type !== 'tree') throw new Error(`missing tree ${treeSha}`);
  return parseTree(obj.data);
}

/** Recursively rebuild a tree with one path changed. Returns the new tree sha,
 *  or null when the resulting tree is empty (caller removes the entry). */
function rebuildTree(
  objects: Map<string, GitObject>,
  newObjects: Map<string, GitObject>,
  baseTreeSha: string | null,
  parts: string[],
  content: Buffer | null,
): string | null {
  const entries = treeEntriesOf(objects, baseTreeSha);
  const name = parts[0];
  const idx = entries.findIndex((e) => e.name === name);
  if (parts.length === 1) {
    if (content === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const blob: GitObject = { type: 'blob', data: Buffer.from(content) };
      const sha = objectId('blob', blob.data);
      objects.set(sha, blob);
      newObjects.set(sha, blob);
      const entry: TreeEntry = { mode: '100644', name, sha };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  } else {
    const subBase = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].sha : null;
    const sub = rebuildTree(objects, newObjects, subBase, parts.slice(1), content);
    if (sub === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '40000', name, sha: sub };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  const tree: GitObject = { type: 'tree', data: encodeTree(entries) };
  const sha = objectId('tree', tree.data);
  objects.set(sha, tree);
  newObjects.set(sha, tree);
  return sha;
}

export interface FileChangeResult {
  commitSha: string;
  treeSha: string;
  blobSha: string | null;
  newObjects: Map<string, GitObject>;
}

/** Build a new blob/tree/commit on top of `baseCommitSha` (or an empty root).
 *  `content === null` deletes the file. Returns the new commit/tree/blob shas
 *  plus every object created; new objects are also added to `objects`. */
export function applyFileChange(
  objects: Map<string, GitObject>,
  baseCommitSha: string | null,
  path: string,
  content: Buffer | string | null,
  message: string,
  author: string | AuthorInput,
  timestampSec: number,
): FileChangeResult {
  const newObjects = new Map<string, GitObject>();
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('empty path');
  let baseTreeSha: string | null = null;
  if (baseCommitSha) {
    const base = objects.get(baseCommitSha);
    if (!base || base.type !== 'commit') throw new Error(`missing base commit ${baseCommitSha}`);
    baseTreeSha = parseCommit(base.data).tree;
  }
  const contentBuf = content === null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const newTreeSha = rebuildTree(objects, newObjects, baseTreeSha, parts, contentBuf) ?? (() => {
    const empty: GitObject = { type: 'tree', data: Buffer.alloc(0) };
    const sha = objectId('tree', empty.data);
    objects.set(sha, empty);
    newObjects.set(sha, empty);
    return sha;
  })();
  let blobSha: string | null = null;
  if (contentBuf !== null) blobSha = objectId('blob', contentBuf);
  const ident = formatIdent(author, timestampSec);
  const commit: GitObject = {
    type: 'commit',
    data: encodeCommit({
      tree: newTreeSha,
      parents: baseCommitSha ? [baseCommitSha] : [],
      author: ident,
      committer: ident,
      message,
    }),
  };
  const commitSha = objectId('commit', commit.data);
  objects.set(commitSha, commit);
  newObjects.set(commitSha, commit);
  return { commitSha, treeSha: newTreeSha, blobSha, newObjects };
}

function walkTree(
  objects: Map<string, GitObject>,
  treeSha: string,
  prefix: string,
  out: Map<string, { sha: string; data: Buffer }>,
): void {
  const obj = objects.get(treeSha);
  if (!obj || obj.type !== 'tree') throw new Error(`missing tree ${treeSha}`);
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') walkTree(objects, e.sha, p, out);
    else if (e.mode === '160000') continue; // gitlink: not followed
    else {
      const blob = objects.get(e.sha);
      if (!blob) throw new Error(`missing blob ${e.sha}`);
      out.set(p, { sha: e.sha, data: blob.data });
    }
  }
}

export function getBlobAt(
  objects: Map<string, GitObject>,
  commitSha: string,
  path: string,
): { sha: string; data: Buffer } | null {
  const commit = objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  const parts = path.split('/').filter((p) => p.length > 0);
  let treeSha = parseCommit(commit.data).tree;
  for (let i = 0; i < parts.length; i++) {
    const entries = treeEntriesOf(objects, treeSha);
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) {
      if (e.mode === '40000' || e.mode === '160000') return null;
      const blob = objects.get(e.sha);
      return blob ? { sha: e.sha, data: blob.data } : null;
    }
    if (e.mode !== '40000') return null;
    treeSha = e.sha;
  }
  return null;
}

export function listFilesAt(
  objects: Map<string, GitObject>,
  commitSha: string,
): Map<string, { sha: string; data: Buffer }> {
  const commit = objects.get(commitSha);
  if (!commit || commit.type !== 'commit') throw new Error(`missing commit ${commitSha}`);
  const out = new Map<string, { sha: string; data: Buffer }>();
  walkTree(objects, parseCommit(commit.data).tree, '', out);
  return out;
}

export function commitParents(objects: Map<string, GitObject>, sha: string): string[] {
  const obj = objects.get(sha);
  if (!obj || obj.type !== 'commit') throw new Error(`missing commit ${sha}`);
  return parseCommit(obj.data).parents;
}

export function commitTree(objects: Map<string, GitObject>, sha: string): string {
  const obj = objects.get(sha);
  if (!obj || obj.type !== 'commit') throw new Error(`missing commit ${sha}`);
  return parseCommit(obj.data).tree;
}

/** All objects reachable from `tips`: commit -> tree + parents, tree -> entries
 *  (gitlink skipped), tag -> target, blob -> stop. Throws on missing objects. */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = objects.get(sha);
    if (!obj) throw new Error(`missing-object ${sha}`);
    seen.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        stack.push(e.sha);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
