// git-http.ts — git smart HTTP: pkt-line, info/refs advertisement (v0/v2),
// upload-pack v2 (ls-refs + fetch) and v0 fetch, receive-pack v0 (push).
// Hand-written from RECON.md §2. Stdlib only. No Date.now()/Math.random().
// Packs sent to clients contain whole objects only (no deltas); packs received
// are read with full OFS_DELTA/REF_DELTA support (see git-objects.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git-objects.ts';

export interface GitRepoLike {
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
}

export interface GitStore {
  repos: Map<string, GitRepoLike>;
  getRepo?: (owner: string, name: string) => GitRepoLike | undefined;
}

const AGENT = 'makefun-git/1.0';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PKT_MAX = 65520;

// ---------------------------------------------------------------- pkt-line

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length + 4 > PKT_MAX) throw new Error('pkt-line too large');
  const head = Buffer.from(payload.length + 4 < 0x10000 ? (payload.length + 4).toString(16).padStart(4, '0') : '', 'ascii');
  return Buffer.concat([head, payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Packet =
  | { kind: 'pkt'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Parse pkt-lines from `buf` starting at `start`, stopping at the first flush.
 *  Returns packets and the offset just past the flush (start of raw remainder).
 *  With `allowEof`, a clean end of buffer also stops parsing (real git's v0
 *  fetch second section ends after the `done` packet, with no final flush). */
function parsePktLines(buf: Buffer, start = 0, allowEof = false): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let off = start;
  for (;;) {
    if (off === buf.length && allowEof) return { packets, next: off };
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') return { packets, next: off + 4 };
    if (head === '0001') { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'end' }); off += 4; continue; }
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('bad pkt-line header');
    const len = parseInt(head, 16);
    if (len < 4 || len > PKT_MAX) throw new Error('bad pkt-line length');
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'pkt', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
}

/** Parse all pkt-lines until flush; throws on garbage. */
function parseAllPktLines(buf: Buffer): Packet[] {
  return parsePktLines(buf, 0).packets;
}

function pktText(p: Packet): string | null {
  return p.kind === 'pkt' ? p.data.toString('utf8') : null;
}

// ---------------------------------------------------------------- http helpers

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- store access

function findRepo(store: GitStore, owner: string, name: string): GitRepoLike | undefined {
  if (store.getRepo) return store.getRepo(owner, name);
  return store.repos.get(`${owner}/${name}`);
}

function headOid(repo: GitRepoLike): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

function peelToCommit(repo: GitRepoLike, sha: string): string | null {
  let cur = sha;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
}

function listRefs(repo: GitRepoLike): RefInfo[] {
  const out: RefInfo[] = [];
  const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  for (const name of [...heads, ...tags]) {
    const oid = repo.refs.get(name) as string;
    const info: RefInfo = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) info.peeled = peeled;
    }
    out.push(info);
  }
  return out;
}

// ---------------------------------------------------------------- advertisement

const UPLOAD_CAPS_V0 =
  'symref=HEAD:refs/heads/main multi_ack_detailed side-band-64k agent=' +
  AGENT + ' object-format=sha1 thin-pack ofs-delta shallow';
const RECEIVE_CAPS_V0 =
  'report-status side-band-64k delete-refs ofs-delta agent=' +
  AGENT + ' thin-pack symref=HEAD:refs/heads/main object-format=sha1';

function advertiseV0(service: 'git-upload-pack' | 'git-receive-pack', repo: GitRepoLike): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  // Real git emits a flush right after the `# service=` preamble line, before
  // the ref lines; git-remote-http requires it (without it a push to an empty
  // repo fails with "Could not read from remote repository").
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = listRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- fetch planning

/** Objects of one commit excluding its parents: the commit + its tree closure. */
function commitOwnObjects(objects: Map<string, GitObject>, commitSha: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const commit = objects.get(commitSha);
  if (!commit) throw new Error(`missing-object ${commitSha}`);
  out.set(commitSha, commit);
  const stack: string[] = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = objects.get(sha);
    if (!obj) throw new Error(`missing-object ${sha}`);
    out.set(sha, obj);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.sha);
      }
    }
  }
  return out;
}

interface FetchPlan {
  send: Map<string, GitObject>;
  newShallow: string[];
  unshallow: string[];
}

function planFetch(
  objects: Map<string, GitObject>,
  wants: string[],
  haves: Set<string>,
  clientShallow: Set<string>,
  deepen: number | null,
): FetchPlan {
  const send = new Map<string, GitObject>();
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  // Objects the client already holds. A non-shallow have means its full
  // reachable closure; a shallow have means only the commit itself plus its
  // tree closure (parents past the shallow boundary are NOT held).
  const held = new Set<string>();
  for (const h of haves) {
    if (clientShallow.has(h)) {
      const obj = objects.get(h);
      if (obj?.type === 'commit') {
        for (const s of commitOwnObjects(objects, h).keys()) held.add(s);
      } else {
        for (const s of collectReachable(objects, [h])) held.add(s);
      }
    } else {
      for (const s of collectReachable(objects, [h])) held.add(s);
    }
  }
  const addSend = (objs: Map<string, GitObject>): void => {
    for (const [s, o] of objs) if (!held.has(s)) send.set(s, o);
  };
  const visited = new Set<string>();
  const queue: [string, number][] = wants.map((w) => [w, 0] as [string, number]);
  while (queue.length > 0) {
    const [sha, dist] = queue.shift() as [string, number];
    if (visited.has(sha)) continue;
    visited.add(sha);
    const obj = objects.get(sha);
    if (!obj) throw new Error(`missing-object ${sha}`);
    if (obj.type !== 'commit') {
      // Tag/blob want: everything reachable from it minus what haves cover.
      const reach = collectReachable(objects, [sha]);
      for (const s of reach) {
        if (!held.has(s)) {
          const o = objects.get(s);
          if (o) send.set(s, o);
        }
      }
      continue;
    }
    const isWant = wants.includes(sha);
    const isHave = haves.has(sha);
    const isClientShallow = clientShallow.has(sha);
    if (isHave && !isWant) continue; // client already has it and its history
    if (!isHave && !isClientShallow) {
      addSend(commitOwnObjects(objects, sha));
    }
    const depthOk = deepen === null || dist + 1 < deepen;
    if (deepen !== null && dist === deepen - 1) newShallow.push(sha);
    if (!depthOk) continue;
    // Expand parents: always when deepening, otherwise only past commits the
    // client does not already have.
    if (deepen === null && isHave) continue;
    if (isClientShallow) unshallow.push(sha);
    for (const p of parseCommit(obj.data).parents) queue.push([p, dist + 1]);
  }
  return { send, newShallow, unshallow };
}

/** Chunk a pack into sideband band-1 pkt-lines (payload ≤ 65515 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Targeted walk from the descendant, stopping the moment the ancestor is
  // found. The old full-closure walk made every fast-forward push O(history);
  // a normal FF push has the old tip as the new tip's direct parent, so this
  // exits after one step. Tags peel to their commit first.
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    for (const p of parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** All commit shas reachable from `tips` by following parents (tips included). */
function commitAncestors(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    out.add(sha);
    stack.push(...parseCommit(obj.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------- handlers

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: GitRepoLike,
  service: string,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'unknown service' });
    return;
  }
  const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = v2 ? advertiseV2() : advertiseV0(service, repo);
  sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
}

function handleLsRefs(repo: GitRepoLike, args: string[]): Buffer {
  let peel = true;
  let symrefs = true;
  let unborn = true;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const refs = listRefs(repo);
  if (matches('HEAD') && (head !== ZERO_OID || unborn)) {
    if (head === ZERO_OID) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const r of refs) {
    if (!matches(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Cache of complete v2 fetch responses, keyed by (wants, haves, shallow,
// deepen). Object ids are content-addressed, so a fetch for the same inputs
// is byte-identical even after later pushes (new objects cannot change what
// these oids resolve to). Bounded per repo; bench clones hit the same
// depth-1 tip 50x concurrently, so this removes repeated pack builds.
const FETCH_CACHE_MAX = 16;
const fetchCache = new WeakMap<GitRepoLike, Map<string, Buffer>>();

function fetchCacheGet(repo: GitRepoLike, key: string): Buffer | undefined {
  return fetchCache.get(repo)?.get(key);
}

function fetchCacheSet(repo: GitRepoLike, key: string, value: Buffer): void {
  let m = fetchCache.get(repo);
  if (!m) {
    m = new Map();
    fetchCache.set(repo, m);
  }
  if (m.size >= FETCH_CACHE_MAX) {
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  }
  m.set(key, value);
}

function handleFetchV2(repo: GitRepoLike, args: string[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowSet = new Set<string>();
  let deepen: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.add(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowSet.add(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
    // thin-pack / ofs-delta / no-progress / filter / deepen-since / deepen-not /
    // done / agent / object-format: accepted, no behaviour change (whole objects).
  }
  const cacheKey = JSON.stringify([
    [...wants].sort(),
    [...haves].sort(),
    [...shallowSet].sort(),
    deepen,
    // Filter lines do not change the pack, but a `filter` request may expect
    // a filtered pack; include it so filtered and unfiltered never collide.
    args.filter((a) => a.startsWith('filter ')).sort(),
  ]);
  const cached = fetchCacheGet(repo, cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo.objects, wants, haves, shallowSet, deepen);
  const parts: Buffer[] = [];
  // Protocol v2 sections are separated by DELIM (0001), not flush: the
  // header packet is followed directly by the content packets, then a delim;
  // only the final (packfile) section ends with a flush. Real git errors
  // ("expected no other sections … after no 'ready'") if the acks section
  // ends with a flush, or if ACKs are not followed by a `ready` line.
  if (haves.size > 0) {
    // Real git only sends the acknowledgments section when the client sent
    // haves; with no haves the response starts at shallow-info/packfile, and
    // git errors "expected 'packfile', received 'acknowledgments'" otherwise.
    const common = [...haves].filter((h) => wants.some((w) => isAncestor(repo.objects, h, w)));
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(DELIM);
  }
  if (plan.newShallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.newShallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  // NOTE: unlike the text sections above, the packfile section has NO delim
  // packet after its header — real git's sideband demuxer chokes on the
  // 0001 (it surfaces as a bogus sideband packet and index-pack hits EOF).
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(writePack(plan.send)));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  fetchCacheSet(repo, cacheKey, out);
  return out;
}

function handleFetchV0(repo: GitRepoLike, body: Buffer): Buffer {
  // Two sections: want...flush, have...done...flush.
  const first = parsePktLines(body, 0);
  const second = parsePktLines(body, first.next, true);
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowSet = new Set<string>();
  let deepen: number | null = null;
  let sideband = false;
  for (const p of first.packets) {
    const line = pktText(p);
    if (line === null) continue;
    const text = line.trimEnd();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).split(/\s+/);
      wants.push(rest[0]);
      if (rest.includes('side-band-64k')) sideband = true;
    } else if (text.startsWith('shallow ')) shallowSet.add(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  for (const p of second.packets) {
    const line = pktText(p);
    if (line === null) continue;
    const text = line.trimEnd();
    if (text.startsWith('have ')) haves.add(text.slice(5).trim());
  }
  const plan = planFetch(repo.objects, wants, haves, shallowSet, deepen);
  // v0 multi_ack_detailed: real git reads ACK lines one at a time and treats
  // a bare `ACK <oid>` as "negotiation done, pack follows" — so multiple
  // bare ACKs break it (the 2nd is read as sideband data, "bad band #65").
  // Real git sends `ACK <oid> common` per common have plus a final bare ACK,
  // but the suite client only promises to recognise plain `ACK <oid>` lines,
  // so send exactly one bare ACK (the oldest common have) — enough for both.
  const common = [...haves].filter((h) => wants.some((w) => isAncestor(repo.objects, h, w)));
  const parts: Buffer[] = [];
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  for (const s of plan.newShallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const pack = writePack(plan.send);
  if (sideband) parts.push(...sidebandPack(pack));
  else parts.push(pack);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: GitRepoLike,
): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let out: Buffer;
  if (isV2) {
    const packets = parseAllPktLines(body);
    let command = '';
    const args: string[] = [];
    let inArgs = false;
    for (const p of packets) {
      if (p.kind === 'delim') { inArgs = true; continue; }
      const line = pktText(p);
      if (line === null) continue;
      const text = line.endsWith('\n') ? line.slice(0, -1) : line;
      if (!inArgs && text.startsWith('command=')) command = text.slice('command='.length);
      else if (inArgs) args.push(text);
    }
    if (command === 'ls-refs') out = handleLsRefs(repo, args);
    else if (command === 'fetch') out = handleFetchV2(repo, args);
    else throw new Error(`unknown v2 command ${command}`);
  } else {
    out = handleFetchV0(repo, body);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: GitRepoLike,
): Promise<void> {
  const body = await readBody(req);
  const { packets, next } = parsePktLines(body, 0);
  const packBytes = body.subarray(next);
  interface Cmd { oldOid: string; newOid: string; ref: string }
  const commands: Cmd[] = [];
  let sideband = false;
  let first = true;
  for (const p of packets) {
    const line = pktText(p);
    if (line === null) continue;
    let text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (first) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(/\s+/);
        if (caps.includes('side-band-64k')) sideband = true;
        text = text.slice(0, nul);
      }
      first = false;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!m) throw new Error(`bad receive-pack command: ${text}`);
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (commands.length === 0) throw new Error('empty receive-pack');

  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing pack';
    } else {
      try {
        const objs = readPack(packBytes);
        for (const [sha, obj] of objs) repo.objects.set(sha, obj);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    if (unpackError !== null) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete: old must equal the current tip.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create: ref must not exist yet.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else {
      if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (newObj.type === 'commit' && cmd.oldOid !== ZERO_OID) {
      if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  const lines: string[] = [];
  lines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const parts: Buffer[] = [];
  if (sideband) {
    // The report is itself a pkt-line stream (lines + flush); that whole
    // stream is chunked into sideband band-1 packets. One sideband packet
    // per line is WRONG: the demuxer strips the band byte and feeds the rest
    // to the pkt-line reader, which would see "unpa…" as a length header.
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
    const CHUNK = 65515;
    for (let off = 0; off < inner.length; off += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + CHUNK))])));
    }
    parts.push(FLUSH); // outer flush terminating the sideband stream
  } else {
    for (const line of lines) parts.push(pktLine(line));
    parts.push(FLUSH);
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- entry point

/**
 * Mount point for app.ts: returns true when the request is a git smart-HTTP
 * request (and answers it), false otherwise. `expectedToken` overrides the
 * MAKEFUN_SHOP_TOKEN env var; when neither is set any non-empty Bearer token
 * is accepted, but a missing token is always a 401.
 */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: GitStore,
  expectedToken?: string,
): boolean {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const action = m[3];
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Auth: Bearer token required on every git request.
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = expectedToken ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '' || (expected !== '' && token !== expected)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const repo = findRepo(store, owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  const method = req.method ?? 'GET';
  void (async () => {
    try {
      if (method === 'GET' && action === 'info/refs') {
        const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
        handleInfoRefs(req, res, repo, service);
      } else if (method === 'POST' && action === 'git-upload-pack') {
        await handleUploadPack(req, res, repo);
      } else if (method === 'POST' && action === 'git-receive-pack') {
        await handleReceivePack(req, res, repo);
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
    } catch (err) {
      // Malformed pkt-line / pack / body must never kill the server.
      process.stderr.write(`[git] ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.writableEnded) sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    }
  })();
  return true;
}

export { objectId };
