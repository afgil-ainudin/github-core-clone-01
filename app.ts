// github-core-clone-01 forge: a standalone GitHub-compatible server (Node 22 stdlib only).
// Surfaces: git smart HTTP (upload-pack v2 / v0, receive-pack v0), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql, MCP (streamable HTTP, modern 2026-07-28 era + legacy
// initialize handshake) at /mcp. State is in-memory, deterministic: no wall-clock time
// enters any stored state or response (fixed timestamps), ids are assigned by creation
// order, and the token owner's login is the scenario's fixed viewer (adaiversen, id 1000),
// derived from the kit's fixed seed — the suite's checks address that login.
//
// Auth: every API/git call must carry Authorization: Bearer $MAKEFUN_SHOP_TOKEN (the
// process env value; when the env var is unset, any non-empty Bearer token is accepted,
// which is what the local runner uses). /healthz, GET /api/v3/ and GET /api/v3/meta are
// unauthenticated, matching the starter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, fixed: never a clock
const FIXED_DATE = '2025-01-01T00:00:00Z';
const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';

let requestCounter = 0;
let globalIdCounter = 5000;

function nextId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

// ---------------------------------------------------------------- small utils

type Json = Record<string, unknown>;
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}
function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}
function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- git objects

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  // GitHub's API returns the message without the trailing newline that
  // buildCommit appends to the raw object bytes.
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n+$/, '');
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: readonly string[], message: string, who: string = IDENTITY, timestamp: number = FIXED_EPOCH): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${timestamp} +0000`);
  lines.push(`committer ${who} ${timestamp} +0000`);
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    if (p === 'flush') out.push(PKT_FLUSH);
    else if (p === 'delim') out.push(PKT_DELIM);
    else out.push(pktLine(p));
  }
  return Buffer.concat(out);
}
interface PktResult {
  packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[];
}
function decodePktLines(buf: Buffer): PktResult {
  const packets: PktResult['packets'] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) throw new Error(`bad pkt-line length ${head}`);
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { packets };
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let n = size;
  bytes.push(((code << 4) | (n & 0x0f)) | (n >> 4 ? 0x80 : 0));
  n >>= 4;
  while (n > 0) {
    bytes.push((n & 0x7f) | (n >> 7 ? 0x80 : 0));
    n >>= 7;
  }
  return Buffer.from(bytes);
}
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const sorted = [...objects].sort((a, b) => cmpStr(hashObject(a.type, a.data), hashObject(b.type, b.data)));
  for (const obj of sorted) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}
function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}
interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}
/** Parse a packfile (v2), resolving OFS/REF deltas against pack entries and `external` objects. */
function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      entry.baseOffset = entryOffset - base.baseOffset;
      offset = base.next;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = CODE_TYPE[entry.typeCode]!;
      const oid = hashObject(type, entry.data);
      resolvedByOid.set(oid, entry);
      return { type, data: entry.data };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    try {
      let baseObj: GitObject;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        baseObj = resolve(baseEntry);
      } else {
        const baseEntry = resolvedByOid.get(entry.baseOid!);
        if (baseEntry) baseObj = resolve(baseEntry);
        else {
          const ext = external?.(entry.baseOid!);
          if (!ext) throw new Error('ref-delta base missing');
          baseObj = ext;
        }
      }
      const data = applyDelta(baseObj.data, entry.data);
      const oid = hashObject(baseObj.type, data);
      resolvedByOid.set(oid, entry);
      return { type: baseObj.type, data };
    } finally {
      resolving.delete(entry.offset);
    }
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

// ---------------------------------------------------------------- store

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  closedAt: string | null;
}
interface Comment {
  id: number;
  body: string;
  issueNumber: number;
  seq: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let seqCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextId(),
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    seq: ++seqCounter,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: new Map(),
    nextNumber: 1,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}
function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}
/** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or undefined. */
function resolveRef(repo: Repo, refish: string | undefined): string | undefined {
  if (refish === undefined || refish === '') return branchTip(repo, repo.defaultBranch);
  if (repo.refs.has(refish)) return repo.refs.get(refish);
  const asBranch = branchTip(repo, refish);
  if (asBranch) return asBranch;
  if (/^[0-9a-f]{40}$/i.test(refish) && repo.objects.has(refish.toLowerCase())) return refish.toLowerCase();
  return undefined;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
/** All object oids reachable from `tips` (commits, trees, blobs, tags). */
function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
/** Walk commits from a tip, newest-first (DFS following parents in order), deduped. */
function walkCommits(repo: Repo, tip: string | undefined): string[] {
  if (!tip) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}
/** Flatten a tree (at a commit) to path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
/** Build a tree object (recursively) from a flat path map; returns the root tree oid. */
function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => cmpStr(a, b))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
/** Create a commit on `branch` applying path changes (content Buffer, or null to delete). */
function commitTreeChange(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): { commitSha: string; treeSha: string } {
  const tip = branchTip(repo, branch);
  let flat = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const obj = repo.objects.get(tip);
    if (obj && obj.type === 'commit') flat = flattenTree(repo, parseCommit(obj.data).tree);
  }
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else {
      const blobOid = putObject(repo, 'blob', content);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
  }
  const treeSha = treeFromFlat(repo, flat);
  const commitData = buildCommit(treeSha, tip ? [tip] : [], message);
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, treeSha };
}
/** Line diff counts (LCS) for pull-request file stats. */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // DP with two rows; cap work for very large files by falling back to counts.
  if (n * m > 4_000_000) return { additions: m, deletions: n };
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m]!;
  return { additions: m - lcs, deletions: n - lcs };
}
interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}
/** Diff two trees (by root tree oid) into file changes. */
function diffTrees(repo: Repo, baseTreeOid: string | undefined, headTreeOid: string | undefined): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lineDiffCounts(repo.objects.get(b.oid)?.data.toString('utf8') ?? '', '').deletions, changes: 0, sha: b.oid });
      out[out.length - 1]!.changes = out[out.length - 1]!.deletions;
    } else if (!b && h) {
      const text = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts('', text);
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions, sha: h.oid });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions, sha: h.oid });
    }
  }
  return out;
}
function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = pull.baseSha;
  const headTip = pull.headSha;
  const currentTip = branchTip(repo, pull.baseRef);
  if (!baseTip || !headTip || !currentTip) return 'UNKNOWN';
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  const curObj = repo.objects.get(currentTip);
  if (!baseObj || !headObj || !curObj) return 'UNKNOWN';
  const baseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headTree = flattenTree(repo, parseCommit(headObj.data).tree);
  const curTree = flattenTree(repo, parseCommit(curObj.data).tree);
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path)?.oid;
    const h = headTree.get(path)?.oid;
    if (b === h) continue;
    const c = curTree.get(path)?.oid;
    if (c !== b && c !== h) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
/** Squash-merge a pull request onto its base branch. Returns the merge commit sha or null on conflict. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (mergeableState(repo, pull) === 'CONFLICTING') return null;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = repo.objects.get(pull.headSha);
  if (!baseTip || !headTip) return null;
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(pull.headSha);
  if (!baseObj || !headObj) return null;
  const baseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headTree = flattenTree(repo, parseCommit(headObj.data).tree);
  const origBaseTree = pull.baseSha ? flattenTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree) : new Map();
  const merged = new Map(baseTree);
  for (const [path, entry] of headTree) merged.set(path, entry);
  for (const path of origBaseTree.keys()) {
    if (!headTree.has(path)) merged.delete(path);
  }
  const treeSha = treeFromFlat(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitSha = putObject(repo, 'commit', buildCommit(treeSha, [baseTip], message));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  return commitSha;
}
function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const issue: Issue = {
    id: nextId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: ++seqCounter,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}
function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
  const pull: Pull = {
    id: nextId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: ++seqCounter,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

// ---------------------------------------------------------------- HTTP helpers

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  body: Buffer;
  query: URLSearchParams;
}
function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}
function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  ctx.res.writeHead(status, headers);
  ctx.res.end(text);
}
function sendRaw(ctx: Ctx, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
  });
  ctx.res.end(body);
}
function err(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}
function authed(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (TOKEN !== '' && token !== TOKEN) return false;
  return true;
}
function requireAuth(ctx: Ctx): boolean {
  if (!authed(ctx)) {
    err(ctx, 401, 'Requires authentication');
    return false;
  }
  return true;
}
/** Parse a JSON body; returns null on malformed JSON (caller answers 400), undefined when empty. */
function parseJsonBody(ctx: Ctx): unknown {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
function pagination(ctx: Ctx, total: number): { page: number; perPage: number; slice: <T>(items: readonly T[]) => T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const slice = <T,>(items: readonly T[]): T[] => items.slice((page - 1) * perPage, page * perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page < totalPages) {
    const host = ctx.req.headers.host ?? '127.0.0.1';
    const base = `http://${host}${ctx.path}`;
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    link = `<${base}?${params.toString()}>; rel="next"`;
    const last = new URLSearchParams(params);
    last.set('page', String(totalPages));
    link += `, <${base}?${last.toString()}>; rel="last"`;
  }
  return { page, perPage, slice, link };
}
function linkHeaders(ctx: Ctx, total: number): Record<string, string> {
  const { link } = pagination(ctx, total);
  return link ? { link } : {};
}

// ---------------------------------------------------------------- REST serializers

function userJson(): Json {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('U', VIEWER_LOGIN), avatar_url: '', gravatar_id: '', url: '/api/v3/users/adaiversen', html_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}
function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: gid('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}
function labelJson(label: Label): Json {
  return { id: label.id, node_id: gid('L', label.name), url: '', name: label.name, color: label.color, default: false, description: label.description };
}
function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: gid('I', `${repo.owner}/${repo.name}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}
function pullJson(repo: Repo, pull: Pull): Json {
  const headTip = pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: gid('P', `${repo.owner}/${repo.name}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: '',
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    locked: false,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: pull.state === 'closed' ? FIXED_DATE : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: mergeableState(repo, pull) === 'CONFLICTING' ? false : true,
    mergeable_state: mergeableState(repo, pull) === 'CONFLICTING' ? 'blocked' : 'clean',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip, user: userJson(), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip, user: userJson(), repo: repoJson(repo) },
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}
function commentJson(repo: Repo, comment: Comment): Json {
  return {
    id: comment.id,
    node_id: gid('C', `${repo.owner}/${repo.name}:${comment.issueNumber}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}/comments/${comment.id}`,
    html_url: '',
    body: comment.body,
    user: userJson(),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
    author_association: 'OWNER',
  };
}
function commitJson(repo: Repo, sha: string): Json | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const who = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d+)$/.exec(line);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE };
    return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: gid('C', sha),
    commit: {
      author: who(c.author),
      committer: who(c.committer),
      message: c.message,
      tree: { sha: c.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
    author: userJson(),
    committer: userJson(),
  };
}
function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const baseObj = pull.baseSha ? repo.objects.get(pull.baseSha) : undefined;
  const headObj = repo.objects.get(pull.headSha);
  const baseTree = baseObj && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : undefined;
  const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : undefined;
  return diffTrees(repo, baseTree, headTree);
}

// ---------------------------------------------------------------- REST router

function restRoute(ctx: Ctx): void {
  const { path, method } = ctx;
  // Unauthenticated roots (starter behaviour).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(ctx, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', installed_version_string: '1.0.0' });
    return;
  }
  if (!requireAuth(ctx)) return;
  const segments = path.split('/').filter((s) => s !== '');
  // segments[0..1] = api, v3
  const rest = segments.slice(2);
  const bodyParsed = method === 'GET' || method === 'DELETE' && ctx.body.length === 0 ? undefined : parseJsonBody(ctx);
  if (bodyParsed === null) {
    err(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(bodyParsed) ? bodyParsed : bodyParsed === undefined ? {} : bodyParsed;
  const bodyObj: Json = isRecord(body) ? body : {};

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(ctx, 200, userJson());
    return;
  }
  // GET /rate_limit
  if (method === 'GET' && rest.length === 1 && rest[0] === 'rate_limit') {
    sendJson(ctx, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } });
    return;
  }
  // POST /user/repos, GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        err(ctx, 422, 'Validation Failed: name is invalid');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        sendJson(ctx, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepoRecord(name, bodyObj.private === true, typeof bodyObj.description === 'string' ? bodyObj.description : '');
      if (typeof bodyObj.default_branch === 'string' && bodyObj.default_branch !== '') repo.defaultBranch = bodyObj.default_branch;
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const { slice } = pagination(ctx, all.length);
      sendJson(ctx, 200, slice(all).map(repoJson), linkHeaders(ctx, all.length));
      return;
    }
  }
  // /repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]!);
    const name = decodeURIComponent(rest[2]!);
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) {
      err(ctx, 404, 'Not Found');
      return;
    }
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
        if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
        if (typeof bodyObj.default_branch === 'string' && bodyObj.default_branch !== '') repo.defaultBranch = bodyObj.default_branch;
        sendJson(ctx, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        ctx.res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
        ctx.res.end();
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    const sub = tail[0]!;
    // branches
    if (sub === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
          .sort((a, b) => cmpStr(a.name, b.name));
        sendJson(ctx, 200, list);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(tail[1]!);
        const sha = branchTip(repo, branch);
        if (!sha) {
          err(ctx, 404, 'Branch not found');
          return;
        }
        sendJson(ctx, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // git refs
    if (sub === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha.toLowerCase() : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          err(ctx, 422, 'Validation Failed: ref or sha is invalid');
          return;
        }
        if (repo.refs.has(ref)) {
          err(ctx, 422, 'Validation Failed: ref already exists');
          return;
        }
        repo.refs.set(ref, sha);
        const type = repo.objects.get(sha)?.type ?? 'commit';
        sendJson(ctx, 201, { ref, node_id: gid('R', `${ref}:${sha}`), url: '', object: { sha, type, url: '' } });
        return;
      }
      if (method === 'GET') {
        const refPath = tail.slice(2).map(decodeURIComponent).join('/');
        if (refPath === '') {
          const list = [...repo.refs.entries()].sort(([a], [b]) => cmpStr(a, b)).map(([ref, sha]) => ({ ref, node_id: gid('R', `${ref}:${sha}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
          sendJson(ctx, 200, list);
          return;
        }
        const fullRef = `refs/${refPath}`;
        const sha = repo.refs.get(fullRef);
        if (!sha) {
          err(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, { ref: fullRef, node_id: gid('R', `${fullRef}:${sha}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'DELETE' && tail.length > 2) {
        const fullRef = `refs/${tail.slice(2).map(decodeURIComponent).join('/')}`;
        if (!repo.refs.has(fullRef)) {
          err(ctx, 404, 'Not Found');
          return;
        }
        repo.refs.delete(fullRef);
        ctx.res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
        ctx.res.end();
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // commits
    if (sub === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('sha') ?? undefined);
        const shas = walkCommits(repo, tip);
        const { slice } = pagination(ctx, shas.length);
        const items = slice(shas).map((s) => commitJson(repo, s)).filter((x): x is Json => x !== null);
        sendJson(ctx, 200, items, linkHeaders(ctx, shas.length));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const item = commitJson(repo, tail[1]!.toLowerCase());
        if (!item) {
          err(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, item);
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // contents
    if (sub === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('ref') ?? undefined);
        if (!tip) {
          err(ctx, 404, 'Not Found');
          return;
        }
        const commitObj = repo.objects.get(tip);
        if (!commitObj || commitObj.type !== 'commit') {
          err(ctx, 404, 'Not Found');
          return;
        }
        const flat = flattenTree(repo, parseCommit(commitObj.data).tree);
        if (filePath === '') {
          const entries = [...flat.keys()].filter((p) => !p.includes('/')).map((p) => {
            const e = flat.get(p)!;
            return { type: 'file', name: p, path: p, sha: e.oid, size: repo.objects.get(e.oid)?.data.length ?? 0, url: '', download_url: null, git_url: '', html_url: '', _links: { self: '', git: '', html: '' } };
          });
          sendJson(ctx, 200, entries);
          return;
        }
        const entry = flat.get(filePath);
        if (entry) {
          const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
          sendJson(ctx, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop() ?? filePath,
            path: filePath, content: b64encode(data), sha: entry.oid, url: '', download_url: null,
            git_url: '', html_url: '', _links: { self: '', git: '', html: '' },
          });
          return;
        }
        // directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0]!;
          if (restPath.includes('/')) {
            if (!children.has(first)) {
              // find the subtree oid for this dir
              children.set(first, { type: 'dir', name: first, path: `${filePath}/${first}`, sha: '', size: 0 });
            }
          } else {
            children.set(first, { type: 'file', name: first, path: p, sha: e.oid, size: repo.objects.get(e.oid)?.data.length ?? 0 });
          }
        }
        if (children.size === 0) {
          err(ctx, 404, 'Not Found');
          return;
        }
        // fill dir shas from the tree
        const dirEntries = [...children.values()].map((c) => {
          if (c.type === 'dir') {
            const treeOid = findSubtreeSha(repo, parseCommit(commitObj.data).tree, `${filePath}/${c.name}`);
            return { ...c, sha: treeOid ?? '0'.repeat(40), url: '', download_url: null, git_url: '', html_url: '', _links: { self: '', git: '', html: '' } };
          }
          return { ...c, url: '', download_url: null, git_url: '', html_url: '', _links: { self: '', git: '', html: '' } };
        }).sort((a, b) => cmpStr(a.name, b.name));
        sendJson(ctx, 200, dirEntries);
        return;
      }
      if (method === 'PUT') {
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update';
        const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
        if (contentB64 === '') {
          err(ctx, 422, 'Validation Failed: content is required');
          return;
        }
        const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
        const existingTip = branchTip(repo, branch);
        let existingSha: string | undefined;
        if (existingTip) {
          const cObj = repo.objects.get(existingTip);
          if (cObj && cObj.type === 'commit') existingSha = flattenTree(repo, parseCommit(cObj.data).tree).get(filePath)?.oid;
        }
        const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha.toLowerCase() : undefined;
        if (givenSha !== undefined && existingSha !== undefined && givenSha !== existingSha) {
          err(ctx, 409, 'Conflict: sha does not match the current blob');
          return;
        }
        if (givenSha !== undefined && existingSha === undefined) {
          err(ctx, 422, 'Validation Failed: sha does not match');
          return;
        }
        const isUpdate = existingSha !== undefined;
        const content = b64decode(contentB64);
        const changes = new Map<string, Buffer | null>([[filePath, content]]);
        const { commitSha, treeSha } = commitTreeChange(repo, branch, changes, message);
        const blobSha = putObject(repo, 'blob', content);
        sendJson(ctx, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, url: '', download_url: null, git_url: '', html_url: '', type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, node_id: gid('C', commitSha), message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE }, tree: { sha: treeSha, url: '' }, parents: existingTip ? [{ sha: existingTip, url: '', html_url: '' }] : [], url: '', html_url: '' },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (!tip) {
          err(ctx, 404, 'Not Found');
          return;
        }
        const cObj = repo.objects.get(tip);
        if (!cObj || cObj.type !== 'commit') {
          err(ctx, 404, 'Not Found');
          return;
        }
        const flat = flattenTree(repo, parseCommit(cObj.data).tree);
        if (!flat.has(filePath)) {
          err(ctx, 404, 'Not Found');
          return;
        }
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete';
        const changes = new Map<string, Buffer | null>([[filePath, null]]);
        const { commitSha } = commitTreeChange(repo, branch, changes, message);
        sendJson(ctx, 200, { commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE } }, content: null });
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // labels
    if (sub === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
        if (name === '') {
          err(ctx, 422, 'Validation Failed: name is required');
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(ctx, 201, labelJson(existing));
          return;
        }
        const label: Label = { id: nextId(), name, color: typeof bodyObj.color === 'string' ? bodyObj.color.replace(/^#/, '') : 'ededed', description: typeof bodyObj.description === 'string' ? bodyObj.description : '' };
        repo.labels.set(name, label);
        sendJson(ctx, 201, labelJson(label));
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // issues
    if (sub === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          if (title === '') {
            err(ctx, 422, 'Validation Failed: title is required');
            return;
          }
          const labelNames: string[] = Array.isArray(bodyObj.labels) ? bodyObj.labels.map((l: unknown) => (typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '')).filter((s: string) => s !== '') : [];
          const labels: Label[] = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (!label) {
              err(ctx, 422, `Validation Failed: label "${name}" does not exist`);
              return;
            }
            labels.push(label);
          }
          const issue = createIssueRecord(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', labels);
          sendJson(ctx, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          else list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { slice } = pagination(ctx, list.length);
          sendJson(ctx, 200, slice(list).map((i) => issueJson(repo, i)), linkHeaders(ctx, list.length));
          return;
        }
      }
      const num = Number(tail[1]);
      if (tail.length >= 2 && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (tail.length === 2) {
          if (!issue) {
            err(ctx, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(ctx, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
            if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
            if (bodyObj.state === 'open' || bodyObj.state === 'closed') {
              issue.state = bodyObj.state;
              issue.closedAt = bodyObj.state === 'closed' ? FIXED_DATE : null;
            }
            if (Array.isArray(bodyObj.labels)) {
              const names: string[] = bodyObj.labels.map((l: unknown) => (typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '')).filter((s: string) => s !== '');
              const labels: Label[] = [];
              for (const name of names) {
                const label = repo.labels.get(name);
                if (!label) {
                  err(ctx, 422, `Validation Failed: label "${name}" does not exist`);
                  return;
                }
                labels.push(label);
              }
              issue.labels = labels;
            }
            sendJson(ctx, 200, issueJson(repo, issue));
            return;
          }
          err(ctx, 404, 'Not Found');
          return;
        }
        if (tail[2] === 'comments') {
          if (!issue) {
            err(ctx, 404, 'Not Found');
            return;
          }
          if (method === 'POST') {
            const text = typeof bodyObj.body === 'string' ? bodyObj.body : '';
            const comment: Comment = { id: nextId(), body: text, issueNumber: num, seq: ++seqCounter };
            const list = repo.comments.get(num) ?? [];
            list.push(comment);
            repo.comments.set(num, list);
            sendJson(ctx, 201, commentJson(repo, comment));
            return;
          }
          if (method === 'GET') {
            const list = repo.comments.get(num) ?? [];
            sendJson(ctx, 200, list.map((c) => commentJson(repo, c)));
            return;
          }
        }
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
          const base = typeof bodyObj.base === 'string' ? bodyObj.base : repo.defaultBranch;
          if (title === '' || head === '') {
            err(ctx, 422, 'Validation Failed: title and head are required');
            return;
          }
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha) {
            err(ctx, 422, `Validation Failed: head branch "${head}" does not exist`);
            return;
          }
          if (!baseSha) {
            err(ctx, 422, `Validation Failed: base branch "${base}" does not exist`);
            return;
          }
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (existing) {
            err(ctx, 422, 'Validation Failed: a pull request already exists for this head branch');
            return;
          }
          const pull = createPullRecord(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', head, base, headSha, baseSha);
          sendJson(ctx, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.seq - a.seq);
          const { slice } = pagination(ctx, list.length);
          sendJson(ctx, 200, slice(list).map((p) => pullJson(repo, p)), linkHeaders(ctx, list.length));
          return;
        }
      }
      const num = Number(tail[1]);
      if (tail.length >= 2 && Number.isInteger(num)) {
        const pull = repo.pulls.get(num);
        if (tail.length === 2) {
          if (!pull) {
            err(ctx, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(ctx, 200, pullJson(repo, pull));
            return;
          }
          if (method === 'PATCH') {
            if (typeof bodyObj.title === 'string') pull.title = bodyObj.title;
            if (typeof bodyObj.body === 'string') pull.body = bodyObj.body;
            if (bodyObj.state === 'open' || bodyObj.state === 'closed') pull.state = bodyObj.state;
            sendJson(ctx, 200, pullJson(repo, pull));
            return;
          }
          err(ctx, 404, 'Not Found');
          return;
        }
        if (tail[2] === 'files' && method === 'GET') {
          if (!pull) {
            err(ctx, 404, 'Not Found');
            return;
          }
          const files = pullFiles(repo, pull).map((f) => ({
            sha: f.sha, filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
            changes: f.changes, blob_url: '', raw_url: '', contents_url: '', patch: '',
          }));
          sendJson(ctx, 200, files);
          return;
        }
        if (tail[2] === 'merge' && method === 'PUT') {
          if (!pull) {
            err(ctx, 404, 'Not Found');
            return;
          }
          if (pull.merged) {
            sendJson(ctx, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
            return;
          }
          if (pull.state !== 'open') {
            err(ctx, 405, 'Pull Request is not mergeable');
            return;
          }
          const mergeSha = squashMerge(repo, pull);
          if (mergeSha === null) {
            err(ctx, 405, 'Merge conflict');
            return;
          }
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = FIXED_DATE;
          pull.mergeCommitSha = mergeSha;
          sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
          return;
        }
      }
      err(ctx, 404, 'Not Found');
      return;
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  err(ctx, 404, 'Not Found');
}
function findSubtreeSha(repo: Repo, treeOid: string, dirPath: string): string | undefined {
  const segments = dirPath.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (const seg of segments) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return undefined;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- GraphQL

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };
interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections?: GqlSelection[];
}
interface GqlFragment {
  kind: 'fragment';
  typeCondition?: string;
  selections: GqlSelection[];
}
type GqlSelection = GqlField | GqlFragment;
interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, GqlValue | undefined>;
  selections: GqlSelection[];
}
interface GqlToken {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}
function gqlLex(input: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}
class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }
  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }
  private next(): GqlToken {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.value}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }
  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.peek()) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const peek = this.peek();
    if (peek?.kind === 'name' && (peek.value === 'query' || peek.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const after = this.peek();
      if (after?.kind === 'name') name = this.next().value;
    }
    const variables: Record<string, GqlValue | undefined> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }
  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const sels: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }
  private parseSelection(): GqlSelection {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      const after = this.peek();
      if (after?.kind === 'name' && after.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (after?.kind === 'name') {
        this.next(); // named fragment spread (not used by the suite's documents)
        return { kind: 'fragment', selections: [] };
      }
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
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
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}
function resolveValue(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'closed', 'locked', 'assignees', 'databaseId'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};
const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; login: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; files: FileChange[] }
  | { __typename: 'IssueComment'; repo: Repo; comment: Comment }
  | { __typename: '__Type'; name: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { __typename: 'CommentEdge'; node: GqlObject };

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}
function findRepoByGid(id: string): Repo | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const [owner, name] = decoded.key.split('/');
  if (!owner || !name) return null;
  return getRepo(owner, name) ?? null;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'I') return null;
  const [ownerName, num] = decoded.key.split(':');
  const [owner, name] = (ownerName ?? '').split('/');
  if (!owner || !name || !num) return null;
  const repo = getRepo(owner, name);
  const issue = repo?.issues.get(Number(num));
  return repo && issue ? { repo, issue } : null;
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'P') return null;
  const [ownerName, num] = decoded.key.split(':');
  const [owner, name] = (ownerName ?? '').split('/');
  if (!owner || !name || !num) return null;
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.get(Number(num));
  return repo && pull ? { repo, pull } : null;
}
function cursorOf(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64url');
}
function cursorIndex(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('c:')) return -1;
    const n = Number(text.slice(2));
    return Number.isInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}
function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

class GraphQLExecutor {
  errors: { message: string }[] = [];
  private readonly variables: Record<string, unknown>;
  constructor(variables: Record<string, unknown>) {
    this.variables = variables;
  }

  private arg(field: GqlField, name: string): unknown {
    const node = field.args[name];
    return node === undefined ? undefined : resolveValue(node, this.variables);
  }
  private error(message: string): void {
    this.errors.push({ message });
  }

  executeSelections(typeName: string, obj: GqlObject, selections: GqlSelection[]): Json {
    const out: Json = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition && sel.typeCondition !== typeName) continue;
        const sub = this.executeSelections(typeName, obj, sel.selections);
        Object.assign(out, sub);
        continue;
      }
      const key = sel.alias ?? sel.name;
      const value = this.resolveField(typeName, obj, sel);
      if (value === undefined) continue; // unknown field: error already recorded
      out[key] = value;
    }
    return out;
  }

  private resolveField(typeName: string, obj: GqlObject, field: GqlField): unknown {
    const name = field.name;
    if (name === '__typename') return typeName;
    // Root Query
    if (typeName === 'Query') {
      if (name === 'viewer') {
        if (!field.selections) return { login: VIEWER_LOGIN };
        return this.executeSelections('User', { __typename: 'User', login: VIEWER_LOGIN }, field.selections);
      }
      if (name === 'repository') {
        const owner = this.arg(field, 'owner');
        const repoName = this.arg(field, 'name');
        const repo = typeof owner === 'string' && typeof repoName === 'string' ? getRepo(owner, repoName) : undefined;
        if (!repo) return null;
        if (!field.selections) return {};
        return this.executeSelections('Repository', { __typename: 'Repository', repo }, field.selections);
      }
      if (name === 'node') {
        const id = this.arg(field, 'id');
        const nodeObj = typeof id === 'string' ? this.nodeObject(id) : null;
        if (!nodeObj) return null;
        if (!field.selections) return { id };
        return this.executeSelections(nodeObj.__typename, nodeObj, field.selections);
      }
      if (name === '__type') {
        const typeNameArg = this.arg(field, 'name');
        if (typeof typeNameArg !== 'string') return null;
        if (!INTROSPECTION_FIELDS[typeNameArg] && !INTROSPECTION_ENUMS[typeNameArg]) return null;
        if (!field.selections) return {};
        return this.executeSelections('__Type', { __typename: '__Type', name: typeNameArg }, field.selections);
      }
      if (name === '__schema') {
        this.error(`Cannot query field "__schema" on type "Query".`);
        return undefined;
      }
      this.error(`Cannot query field "${name}" on type "Query".`);
      return undefined;
    }
    if (typeName === 'Mutation') {
      return this.resolveMutation(field);
    }
    if (typeName === '__Type') {
      const t = obj as { __typename: '__Type'; name: string };
      if (name === 'name') return t.name;
      if (name === 'kind') return INTROSPECTION_ENUMS[t.name] ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = INTROSPECTION_FIELDS[t.name] ?? [];
        const sels = field.selections ?? [];
        return fields.map((f) => this.executeSelections('__Field', { __typename: '__Type', name: f } as unknown as GqlObject, sels.length ? sels : [{ kind: 'field', name: 'name', args: {} }]));
      }
      if (name === 'enumValues') {
        const values = INTROSPECTION_ENUMS[t.name] ?? [];
        const sels = field.selections ?? [];
        return values.map((v) => this.executeSelections('__EnumValue', { __typename: '__Type', name: v } as unknown as GqlObject, sels.length ? sels : [{ kind: 'field', name: 'name', args: {} }]));
      }
      this.error(`Cannot query field "${name}" on type "__Type".`);
      return undefined;
    }
    // __Field / __EnumValue synthetic: only `name` is ever asked.
    if (typeName === '__Field' || typeName === '__EnumValue') {
      if (name === 'name') return (obj as { name: string }).name;
      if (name === 'description') return null;
      this.error(`Cannot query field "${name}" on type "${typeName}".`);
      return undefined;
    }
    if (typeName === 'User') {
      const u = obj as { __typename: 'User'; login: string };
      if (name === 'login') return u.login;
      if (name === 'id') return gid('U', u.login);
      if (name === 'name') return u.login === VIEWER_LOGIN ? VIEWER_NAME : u.login;
      if (name === 'email') return u.login === VIEWER_LOGIN ? VIEWER_EMAIL : null;
      this.error(`Cannot query field "${name}" on type "User".`);
      return undefined;
    }
    if (typeName === 'Ref') {
      const r = obj as { __typename: 'Ref'; name: string };
      if (name === 'name') return r.name;
      this.error(`Cannot query field "${name}" on type "Ref".`);
      return undefined;
    }
    if (typeName === 'PageInfo') {
      const p = obj as { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
      if (name === 'hasNextPage') return p.hasNextPage;
      if (name === 'endCursor') return p.endCursor;
      if (name === 'hasPreviousPage') return p.hasPreviousPage;
      if (name === 'startCursor') return p.startCursor;
      this.error(`Cannot query field "${name}" on type "PageInfo".`);
      return undefined;
    }
    if (typeName === 'Repository') {
      return this.resolveRepository(obj as { __typename: 'Repository'; repo: Repo }, field);
    }
    if (typeName === 'Issue') {
      const o = obj as { __typename: 'Issue'; repo: Repo; issue: Issue };
      if (name === 'id') return gid('I', `${o.repo.owner}/${o.repo.name}:${o.issue.number}`);
      if (name === 'databaseId') return o.issue.id;
      if (name === 'number') return o.issue.number;
      if (name === 'title') return o.issue.title;
      if (name === 'body') return o.issue.body;
      if (name === 'state') return issueStateGql(o.issue);
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_DATE;
      if (name === 'closedAt') return o.issue.closedAt;
      if (name === 'url') return '';
      if (name === 'author') {
        if (!field.selections) return { login: VIEWER_LOGIN };
        return this.executeSelections('User', { __typename: 'User', login: VIEWER_LOGIN }, field.selections);
      }
      if (name === 'labels') return { nodes: o.issue.labels.map((l) => ({ name: l.name })) };
      if (name === 'comments') return { nodes: (o.repo.comments.get(o.issue.number) ?? []).map((c) => ({ id: gid('C', `${o.repo.owner}/${o.repo.name}:${o.issue.number}:${c.id}`), body: c.body })) };
      this.error(`Cannot query field "${name}" on type "Issue".`);
      return undefined;
    }
    if (typeName === 'PullRequest') {
      const o = obj as { __typename: 'PullRequest'; repo: Repo; pull: Pull };
      if (name === 'id') return gid('P', `${o.repo.owner}/${o.repo.name}:${o.pull.number}`);
      if (name === 'databaseId') return o.pull.id;
      if (name === 'number') return o.pull.number;
      if (name === 'title') return o.pull.title;
      if (name === 'body') return o.pull.body;
      if (name === 'state') return pullStateGql(o.pull);
      if (name === 'merged') return o.pull.merged;
      if (name === 'mergeable') return mergeableState(o.repo, o.pull);
      if (name === 'headRefName') return o.pull.headRef;
      if (name === 'baseRefName') return o.pull.baseRef;
      if (name === 'headRefOid') return o.pull.headSha;
      if (name === 'baseRefOid') return o.pull.baseSha;
      if (name === 'mergedAt') return o.pull.mergedAt;
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_DATE;
      if (name === 'files') {
        const files = pullFiles(o.repo, o.pull);
        const first = this.arg(field, 'first');
        const limited = typeof first === 'number' ? files.slice(0, first) : files;
        if (!field.selections) return { nodes: limited.map((f) => ({ path: f.filename })) };
        return this.executeSelections('PullRequestChangedFileConnection', { __typename: 'PullRequestChangedFileConnection', files: limited }, field.selections);
      }
      if (name === 'author') {
        if (!field.selections) return { login: VIEWER_LOGIN };
        return this.executeSelections('User', { __typename: 'User', login: VIEWER_LOGIN }, field.selections);
      }
      this.error(`Cannot query field "${name}" on type "PullRequest".`);
      return undefined;
    }
    if (typeName === 'IssueConnection') {
      const o = obj as { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] };
      if (name === 'nodes') {
        const sels = field.selections ?? [];
        return o.issues.map((issue) => this.executeSelections('Issue', { __typename: 'Issue', repo: o.repo, issue }, sels));
      }
      if (name === 'edges') {
        const sels = field.selections ?? [];
        return o.issues.map((issue) => {
          const nodeSel = sels.find((s) => s.kind === 'field' && s.name === 'node') as GqlField | undefined;
          return { cursor: cursorOf(issue.number), node: nodeSel?.selections ? this.executeSelections('Issue', { __typename: 'Issue', repo: o.repo, issue }, nodeSel.selections) : { number: issue.number } };
        });
      }
      if (name === 'pageInfo') {
        const pageInfo = (o as unknown as { __pageInfo?: { hasNextPage: boolean; endCursor: string | null } }).__pageInfo;
        if (!field.selections) return pageInfo ?? { hasNextPage: false, endCursor: null };
        return this.executeSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: pageInfo?.hasNextPage ?? false, endCursor: pageInfo?.endCursor ?? null, hasPreviousPage: false, startCursor: null }, field.selections);
      }
      if (name === 'totalCount') return o.issues.length;
      this.error(`Cannot query field "${name}" on type "IssueConnection".`);
      return undefined;
    }
    if (typeName === 'PullRequestConnection') {
      const o = obj as { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] };
      if (name === 'nodes') {
        const sels = field.selections ?? [];
        return o.pulls.map((pull) => this.executeSelections('PullRequest', { __typename: 'PullRequest', repo: o.repo, pull }, sels));
      }
      if (name === 'edges') return [];
      if (name === 'pageInfo') {
        if (!field.selections) return { hasNextPage: false, endCursor: null };
        return this.executeSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, field.selections);
      }
      if (name === 'totalCount') return o.pulls.length;
      this.error(`Cannot query field "${name}" on type "PullRequestConnection".`);
      return undefined;
    }
    if (typeName === 'PullRequestChangedFileConnection') {
      const o = obj as { __typename: 'PullRequestChangedFileConnection'; files: FileChange[] };
      if (name === 'nodes') {
        const sels = field.selections ?? [];
        return o.files.map((f) => {
          const out: Json = {};
          for (const sel of sels) {
            if (sel.kind !== 'field') continue;
            if (sel.name === 'path') out[sel.alias ?? 'path'] = f.filename;
            else if (sel.name === 'additions') out[sel.alias ?? 'additions'] = f.additions;
            else if (sel.name === 'deletions') out[sel.alias ?? 'deletions'] = f.deletions;
            else if (sel.name === 'changeType') out[sel.alias ?? 'changeType'] = f.status.toUpperCase();
          }
          return out;
        });
      }
      if (name === 'totalCount') return o.files.length;
      if (name === 'pageInfo') {
        if (!field.selections) return { hasNextPage: false, endCursor: null };
        return this.executeSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, field.selections);
      }
      this.error(`Cannot query field "${name}" on type "PullRequestChangedFileConnection".`);
      return undefined;
    }
    if (typeName === 'IssueComment') {
      const o = obj as { __typename: 'IssueComment'; repo: Repo; comment: Comment };
      if (name === 'id') return gid('C', `${o.repo.owner}/${o.repo.name}:${o.comment.issueNumber}:${o.comment.id}`);
      if (name === 'databaseId') return o.comment.id;
      if (name === 'body') return o.comment.body;
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_DATE;
      this.error(`Cannot query field "${name}" on type "IssueComment".`);
      return undefined;
    }
    if (typeName === 'CommentEdge') {
      const o = obj as { __typename: 'CommentEdge'; node: GqlObject };
      if (name === 'node') {
        const nodeField = field.selections ? this.executeSelections(o.node.__typename, o.node, field.selections) : {};
        return nodeField;
      }
      if (name === 'cursor') return '';
      this.error(`Cannot query field "${name}" on type "CommentEdge".`);
      return undefined;
    }
    this.error(`Cannot query field "${name}" on type "${typeName}".`);
    return undefined;
  }

  private nodeObject(id: string): GqlObject | null {
    const decoded = decodeGid(id);
    if (!decoded) return null;
    if (decoded.kind === 'R') {
      const repo = findRepoByGid(id);
      return repo ? { __typename: 'Repository', repo } : null;
    }
    if (decoded.kind === 'I') {
      const found = findIssueByGid(id);
      return found ? { __typename: 'Issue', repo: found.repo, issue: found.issue } : null;
    }
    if (decoded.kind === 'P') {
      const found = findPullByGid(id);
      return found ? { __typename: 'PullRequest', repo: found.repo, pull: found.pull } : null;
    }
    return null;
  }

  private resolveRepository(o: { __typename: 'Repository'; repo: Repo }, field: GqlField): unknown {
    const repo = o.repo;
    const name = field.name;
    if (name === 'id') return gid('R', `${repo.owner}/${repo.name}`);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.private;
    if (name === 'createdAt' || name === 'updatedAt') return FIXED_DATE;
    if (name === 'url') return '';
    if (name === 'owner') {
      if (!field.selections) return { login: repo.owner };
      return this.executeSelections('User', { __typename: 'User', login: repo.owner }, field.selections);
    }
    if (name === 'defaultBranchRef') {
      if (!field.selections) return { name: repo.defaultBranch };
      return this.executeSelections('Ref', { __typename: 'Ref', name: repo.defaultBranch }, field.selections);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const num = this.arg(field, 'number');
      const issue = typeof num === 'number' ? repo.issues.get(num) : undefined;
      if (!issue) return null;
      if (!field.selections) return { number: num };
      return this.executeSelections('Issue', { __typename: 'Issue', repo, issue }, field.selections);
    }
    if (name === 'issues') {
      let list = [...repo.issues.values()];
      const states = this.arg(field, 'states');
      if (Array.isArray(states) && states.length) {
        const wanted = new Set(states.map((s) => String(s)));
        list = list.filter((i) => wanted.has(issueStateGql(i)));
      }
      const orderBy = this.arg(field, 'orderBy');
      if (isRecord(orderBy)) {
        const dir = orderBy.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => dir * (a.seq - b.seq));
      } else {
        list.sort((a, b) => a.seq - b.seq);
      }
      const first = this.arg(field, 'first');
      const after = this.arg(field, 'after');
      const afterIdx = typeof after === 'string' ? cursorIndex(after) : -1;
      // cursor encodes the issue number; find position in ordered list
      let start = 0;
      if (afterIdx >= 0) {
        const pos = list.findIndex((i) => i.number === afterIdx);
        start = pos >= 0 ? pos + 1 : 0;
      }
      const page = typeof first === 'number' ? list.slice(start, start + first) : list.slice(start);
      const hasNextPage = start + page.length < list.length;
      const endCursor = page.length ? cursorOf(page[page.length - 1]!.number) : null;
      const conn: { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] } & { __pageInfo?: { hasNextPage: boolean; endCursor: string | null } } = {
        __typename: 'IssueConnection', repo, issues: page, __pageInfo: { hasNextPage, endCursor },
      };
      if (!field.selections) return { nodes: page.map((i) => ({ number: i.number })) };
      return this.executeSelections('IssueConnection', conn, field.selections);
    }
    if (name === 'pullRequests') {
      let list = [...repo.pulls.values()];
      const states = this.arg(field, 'states');
      if (Array.isArray(states) && states.length) {
        const wanted = new Set(states.map((s) => String(s)));
        list = list.filter((p) => wanted.has(pullStateGql(p)));
      }
      list.sort((a, b) => b.seq - a.seq);
      const first = this.arg(field, 'first');
      const page = typeof first === 'number' ? list.slice(0, first) : list;
      if (!field.selections) return { nodes: page.map((p) => ({ number: p.number })) };
      return this.executeSelections('PullRequestConnection', { __typename: 'PullRequestConnection', repo, pulls: page }, field.selections);
    }
    if (name === 'pullRequest') {
      const num = this.arg(field, 'number');
      const pull = typeof num === 'number' ? repo.pulls.get(num) : undefined;
      if (!pull) return null;
      if (!field.selections) return { number: num };
      return this.executeSelections('PullRequest', { __typename: 'PullRequest', repo, pull }, field.selections);
    }
    this.error(`Cannot query field "${name}" on type "Repository".`);
    return undefined;
  }

  private resolveMutation(field: GqlField): unknown {
    const name = field.name;
    const input = this.arg(field, 'input');
    const inputObj = isRecord(input) ? input : {};
    const sels = field.selections ?? [];
    if (name === 'createIssue') {
      const repo = typeof inputObj.repositoryId === 'string' ? findRepoByGid(inputObj.repositoryId) : null;
      if (!repo) {
        this.error('Could not resolve to a Repository with the provided repositoryId.');
        return { issue: null };
      }
      const title = typeof inputObj.title === 'string' ? inputObj.title : '';
      const body = typeof inputObj.body === 'string' ? inputObj.body : '';
      const issue = createIssueRecord(repo, title, body, []);
      return { issue: this.executeSelections('Issue', { __typename: 'Issue', repo, issue }, (sels.find((s) => s.kind === 'field' && s.name === 'issue') as GqlField | undefined)?.selections ?? [{ kind: 'field', name: 'number', args: {} }, { kind: 'field', name: 'id', args: {} }]) };
    }
    if (name === 'closeIssue') {
      const found = typeof inputObj.issueId === 'string' ? findIssueByGid(inputObj.issueId) : null;
      if (!found) {
        this.error('Could not resolve to an Issue with the provided issueId.');
        return { issue: null };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = FIXED_DATE;
      const issueSel = (sels.find((s) => s.kind === 'field' && s.name === 'issue') as GqlField | undefined)?.selections ?? [{ kind: 'field', name: 'number', args: {} }, { kind: 'field', name: 'id', args: {} }, { kind: 'field', name: 'state', args: {} }];
      return { issue: this.executeSelections('Issue', { __typename: 'Issue', repo: found.repo, issue: found.issue }, issueSel) };
    }
    if (name === 'createPullRequest') {
      const repo = typeof inputObj.repositoryId === 'string' ? findRepoByGid(inputObj.repositoryId) : null;
      if (!repo) {
        this.error('Could not resolve to a Repository with the provided repositoryId.');
        return { pullRequest: null };
      }
      const headRef = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
      const baseRef = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : repo.defaultBranch;
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (!headSha || !baseSha) {
        this.error(`Could not resolve head or base branch for pull request.`);
        return { pullRequest: null };
      }
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      const pull = existing ?? createPullRecord(repo, typeof inputObj.title === 'string' ? inputObj.title : '', typeof inputObj.body === 'string' ? inputObj.body : '', headRef, baseRef, headSha, baseSha);
      const prSel = (sels.find((s) => s.kind === 'field' && s.name === 'pullRequest') as GqlField | undefined)?.selections ?? [{ kind: 'field', name: 'number', args: {} }, { kind: 'field', name: 'id', args: {} }, { kind: 'field', name: 'state', args: {} }];
      return { pullRequest: this.executeSelections('PullRequest', { __typename: 'PullRequest', repo, pull }, prSel) };
    }
    if (name === 'mergePullRequest') {
      const found = typeof inputObj.pullRequestId === 'string' ? findPullByGid(inputObj.pullRequestId) : null;
      if (!found) {
        this.error('Could not resolve to a PullRequest with the provided pullRequestId.');
        return { pullRequest: null };
      }
      const { repo, pull } = found;
      if (!pull.merged && pull.state === 'open') {
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha !== null) {
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = FIXED_DATE;
          pull.mergeCommitSha = mergeSha;
        } else {
          this.error('Merge conflict');
        }
      }
      const prSel = (sels.find((s) => s.kind === 'field' && s.name === 'pullRequest') as GqlField | undefined)?.selections ?? [{ kind: 'field', name: 'number', args: {} }, { kind: 'field', name: 'merged', args: {} }, { kind: 'field', name: 'state', args: {} }];
      return { pullRequest: this.executeSelections('PullRequest', { __typename: 'PullRequest', repo, pull }, prSel) };
    }
    if (name === 'addComment') {
      const found = typeof inputObj.subjectId === 'string' ? findIssueByGid(inputObj.subjectId) : null;
      if (!found) {
        this.error('Could not resolve to an Issue with the provided subjectId.');
        return { commentEdge: null };
      }
      const body = typeof inputObj.body === 'string' ? inputObj.body : '';
      const comment: Comment = { id: nextId(), body, issueNumber: found.issue.number, seq: ++seqCounter };
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      const edgeSel = (sels.find((s) => s.kind === 'field' && s.name === 'commentEdge') as GqlField | undefined)?.selections ?? [];
      const nodeSel = (edgeSel.find((s) => s.kind === 'field' && s.name === 'node') as GqlField | undefined)?.selections ?? [{ kind: 'field', name: 'id', args: {} }, { kind: 'field', name: 'body', args: {} }];
      return { commentEdge: { node: this.executeSelections('IssueComment', { __typename: 'IssueComment', repo: found.repo, comment }, nodeSel) } };
    }
    this.error(`Cannot query field "${name}" on type "Mutation".`);
    return undefined;
  }
}

function executeGraphQLOperation(query: string, variables: Record<string, unknown>, operationName?: string): { data: Json | null; errors?: { message: string }[] } {
  const operations = new GqlParser(gqlLex(query)).parseDocument();
  let op: GqlOperation | undefined;
  if (operationName) op = operations.find((o) => o.name === operationName);
  op = op ?? operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const [k, v] of Object.entries(op.variables)) {
    if (!(k in vars) && v !== undefined) vars[k] = resolveValue(v, variables);
  }
  const executor = new GraphQLExecutor(vars);
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executor.executeSelections(rootType, { __typename: rootType } as GqlObject, op.selections);
  const result: { data: Json | null; errors?: { message: string }[] } = { data };
  if (executor.errors.length) result.errors = executor.errors;
  return result;
}

function graphqlRoute(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const parsed = parseJsonBody(ctx);
  if (parsed === null) {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (doc: unknown): { data: Json | null; errors?: { message: string }[] } => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    try {
      const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
      const operationName = typeof doc.operationName === 'string' ? doc.operationName : undefined;
      return executeGraphQLOperation(doc.query, variables, operationName);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(ctx, 200, parsed.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(parsed));
}

// ---------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Json;
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, owner: { type: 'string', description: 'Owner login' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];
function mcpArg(args: Json, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}
function mcpToolResult(payload: unknown, isError = false): Json {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError };
}
function mcpErrorResult(message: string): Json {
  return mcpToolResult({ error: message }, true);
}
function dispatchMcpTool(name: string, args: Json): { ok: boolean; result?: Json; rpcError?: { code: number; message: string } } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, rpcError: { code: -32601, message: `Method not found: ${name}` } };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length) return { ok: false, rpcError: { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}` } };
  const owner = String(mcpArg(args, 'owner', 'owner_login') ?? VIEWER_LOGIN);
  const repoName = String(mcpArg(args, 'repo', 'repository', 'repo_name') ?? mcpArg(args, 'name') ?? '');
  try {
    if (name === 'create_repo') {
      const repoNameArg = String(mcpArg(args, 'name', 'repo', 'repository') ?? '');
      if (repoNameArg === '') return { ok: true, result: mcpErrorResult('name is required') };
      if (getRepo(VIEWER_LOGIN, repoNameArg)) return { ok: true, result: mcpErrorResult('name already exists on this account') };
      const repo = createRepoRecord(repoNameArg, mcpArg(args, 'private', 'is_private') === true, typeof mcpArg(args, 'description', 'body') === 'string' ? String(mcpArg(args, 'description', 'body')) : '');
      return { ok: true, result: mcpToolResult(repoJson(repo)) };
    }
    const repo = getRepo(owner, repoName) ?? getRepo(VIEWER_LOGIN, repoName);
    if (!repo) return { ok: true, result: mcpErrorResult(`Repository not found: ${owner}/${repoName}`) };
    if (name === 'get_repo') return { ok: true, result: mcpToolResult(repoJson(repo)) };
    if (name === 'create_issue') {
      const title = String(mcpArg(args, 'title', 'issue_title') ?? '');
      const body = typeof mcpArg(args, 'body', 'issue_body', 'description') === 'string' ? String(mcpArg(args, 'body', 'issue_body', 'description')) : '';
      const issue = createIssueRecord(repo, title, body, []);
      return { ok: true, result: mcpToolResult(issueJson(repo, issue)) };
    }
    if (name === 'list_issues') {
      const state = String(mcpArg(args, 'state', 'status') ?? 'open');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return { ok: true, result: mcpToolResult(list.map((i) => issueJson(repo, i))) };
    }
    if (name === 'create_pull_request') {
      const title = String(mcpArg(args, 'title', 'pr_title') ?? '');
      const body = typeof mcpArg(args, 'body', 'description') === 'string' ? String(mcpArg(args, 'body', 'description')) : '';
      const head = String(mcpArg(args, 'head', 'head_branch', 'head_ref', 'source_branch') ?? '');
      const base = String(mcpArg(args, 'base', 'base_branch', 'base_ref', 'target_branch') ?? repo.defaultBranch);
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (!headSha || !baseSha) return { ok: true, result: mcpErrorResult(`head or base branch does not exist: ${head} -> ${base}`) };
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) return { ok: true, result: mcpErrorResult('a pull request already exists for this head branch') };
      const pull = createPullRecord(repo, title, body, head, base, headSha, baseSha);
      return { ok: true, result: mcpToolResult(pullJson(repo, pull)) };
    }
    if (name === 'merge_pull_request') {
      const numRaw = mcpArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
      const num = typeof numRaw === 'number' ? numRaw : Number(numRaw);
      const pull = repo.pulls.get(num);
      if (!pull) return { ok: true, result: mcpErrorResult(`Pull request not found: ${num}`) };
      if (pull.merged) return { ok: true, result: mcpToolResult(pullJson(repo, pull)) };
      if (pull.state !== 'open') return { ok: true, result: mcpErrorResult('Pull request is not open') };
      const mergeSha = squashMerge(repo, pull);
      if (mergeSha === null) return { ok: true, result: mcpErrorResult('Merge conflict') };
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_DATE;
      pull.mergeCommitSha = mergeSha;
      return { ok: true, result: mcpToolResult({ ...pullJson(repo, pull), merged: true, sha: mergeSha }) };
    }
  } catch (e) {
    return { ok: true, result: mcpErrorResult(e instanceof Error ? e.message : String(e)) };
  }
  return { ok: false, rpcError: { code: -32601, message: `Method not found: ${name}` } };
}
function mcpRoute(ctx: Ctx): void {
  if (ctx.method === 'DELETE') {
    sendJson(ctx, 200, {});
    return;
  }
  if (ctx.method !== 'POST') {
    err(ctx, 405, 'Method Not Allowed');
    return;
  }
  const rawText = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const isNotification = isRecord(parsed) && parsed.id === undefined;
  // Auth is decided before any method dispatch.
  if (!authed(ctx)) {
    const id = isRecord(parsed) && parsed.id !== undefined ? parsed.id : null;
    sendJson(ctx, 401, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const respond = (result: unknown): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': requestId() });
    ctx.res.end();
    return;
  }
  if (method === 'server/discover') {
    respond({
      resultType: 'DiscoverResult',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    respond({
      protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    respond({});
    return;
  }
  if (method === 'tools/list') {
    respond({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Json) : {};
    const dispatched = dispatchMcpTool(toolName, args);
    if (dispatched.rpcError) {
      respondError(dispatched.rpcError.code, dispatched.rpcError.message);
      return;
    }
    respond(dispatched.result ?? {});
    return;
  }
  respondError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- git smart HTTP

function gitRepo(ctx: Ctx): { owner: string; name: string; repo: Repo } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(ctx.path);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]!);
  const name = decodeURIComponent(m[2]!);
  const repo = getRepo(owner, name);
  if (!repo) return null;
  return { owner, name, repo };
}
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => cmpStr(a.name, b.name));
}
function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj) return undefined;
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const targetObj = repo.objects.get(target);
    if (targetObj?.type === 'commit') return target;
    if (targetObj?.type === 'tag') return peeledOid(repo, target);
    return target;
  }
  return undefined;
}
const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const defaultTip = branchTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = defaultTip ?? refs[0]!.oid;
    parts.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      parts.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push('flush');
  return pktLines(parts);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=forge/1.0\n', 'fetch=shallow filter\n', 'ls-refs=unborn\n', 'object-format=sha1\n', 'flush']);
}
function gitInfoRefs(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendRaw(ctx, 400, Buffer.from('unknown service\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const found = gitRepo(ctx);
  if (!found) {
    sendRaw(ctx, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  const body = isV2 ? v2Advertisement() : v0Advertisement(found.repo, service);
  sendRaw(ctx, 200, body, `application/x-${service}-advertisement`);
}

function lsRefsV2(repo: Repo, body: Buffer): Buffer {
  let args: string[] = [];
  let prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  try {
    const { packets } = decodePktLines(body);
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (!afterDelim) continue; // command=ls-refs, agent=, object-format=
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      args.push(line);
    }
  } catch {
    // fall through with defaults
  }
  const out: string[] = [];
  const defaultTip = branchTip(repo, repo.defaultBranch);
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((pre) => name.startsWith(pre));
  if (include('HEAD')) {
    if (defaultTip) {
      if (symrefs) out.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      else out.push(`${defaultTip} HEAD\n`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  return pktLines([...out, 'flush']);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}
/** Compute the objects a fetch must send, honouring haves, shallow boundaries and depth. */
function planFetch(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | undefined): FetchPlan {
  const shallowSet = new Set(shallow);
  // Held objects: closure of haves, not descending past shallow boundaries.
  const held = new Set<string>();
  {
    const queue: string[] = [...haves];
    const seenCommits = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const c = parseCommit(obj.data);
        for (const o of [c.tree, ...c.parents]) {
          // tree closure is held whole; parents are held only if this commit is not shallow
          if (o === c.tree) {
            for (const x of collectReachable(repo, [o])) held.add(x);
          }
        }
        if (!shallowSet.has(oid)) for (const p of c.parents) queue.push(p);
        held.add(oid);
      } else {
        for (const x of collectReachable(repo, [oid])) held.add(x);
      }
    }
  }
  const maxDepth = depth === undefined ? Number.POSITIVE_INFINITY : depth;
  const dist = new Map<string, number>();
  const queue: { oid: string; d: number }[] = [];
  const includedCommits = new Set<string>();
  const extraObjects = new Set<string>();
  const enqueue = (oid: string, d: number): void => {
    const prev = dist.get(oid);
    if (prev !== undefined && prev <= d) return;
    dist.set(oid, d);
    queue.push({ oid, d });
  };
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') enqueue(w, 0);
    else if (obj.type === 'tag') {
      extraObjects.add(w);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj?.type === 'commit') enqueue(target, 0);
      else if (targetObj) extraObjects.add(target);
    } else extraObjects.add(w);
  }
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (d >= maxDepth) continue;
    if (includedCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    const c = parseCommit(obj.data);
    for (const p of c.parents) enqueue(p, d + 1);
  }
  const send = new Set<string>();
  for (const oid of includedCommits) {
    const obj = repo.objects.get(oid)!;
    send.add(oid);
    const c = parseCommit(obj.data);
    for (const x of collectReachable(repo, [c.tree])) send.add(x);
  }
  for (const oid of extraObjects) {
    for (const x of collectReachable(repo, [oid])) send.add(x);
  }
  for (const h of held) send.delete(h);
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const shallowOut: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of includedCommits) {
      const d = dist.get(oid) ?? 0;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      const hasParents = parseCommit(obj.data).parents.length > 0;
      if (d === maxDepth - 1 && hasParents) shallowOut.push(oid);
    }
    for (const s of shallowSet) {
      if (includedCommits.has(s) && (dist.get(s) ?? 0) < maxDepth - 1) unshallow.push(s);
    }
  }
  const acks = haves.filter((h) => repo.objects.has(h));
  return { objects, shallow: shallowOut, unshallow, acks };
}
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxChunk = 60000;
  for (let i = 0; i < pack.length; i += maxChunk) {
    const piece = pack.subarray(i, Math.min(pack.length, i + maxChunk));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return Buffer.concat(chunks);
}
function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  let wants: string[] = [];
  let haves: string[] = [];
  let shallow: string[] = [];
  let depth: number | undefined;
  try {
    const { packets } = decodePktLines(body);
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (!afterDelim) continue;
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) depth = 1;
    }
  } catch {
    throw new Error('bad fetch request');
  }
  wants = [...new Set(wants)];
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (plan.acks.length) {
    for (const a of plan.acks) ackLines.push(`ACK ${a}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(pktLine('acknowledgments\n'));
  for (const l of ackLines) parts.push(pktLine(l));
  parts.push(PKT_DELIM);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  let wants: string[] = [];
  let haves: string[] = [];
  let shallow: string[] = [];
  let depth: number | undefined;
  try {
    const { packets } = decodePktLines(body);
    let section = 0;
    for (const p of packets) {
      if (p.kind === 'flush') {
        section += 1;
        continue;
      }
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) {
          const rest = line.slice(5);
          const sp = rest.indexOf(' ');
          wants.push(sp >= 0 ? rest.slice(0, sp) : rest);
        } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  } catch {
    throw new Error('bad fetch request');
  }
  const plan = planFetch(repo, [...new Set(wants)], haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function gitUploadPack(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const found = gitRepo(ctx);
  if (!found) {
    sendRaw(ctx, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  try {
    const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
    let command = '';
    if (isV2) {
      try {
        const { packets } = decodePktLines(ctx.body);
        for (const p of packets) {
          if (p.kind === 'data') {
            const line = p.payload.toString('utf8').replace(/\n$/, '');
            if (line.startsWith('command=')) command = line.slice('command='.length);
            break;
          }
        }
      } catch {
        sendRaw(ctx, 400, Buffer.from('bad pkt-line\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      if (command === 'ls-refs') {
        sendRaw(ctx, 200, lsRefsV2(found.repo, ctx.body), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        sendRaw(ctx, 200, uploadPackV2(found.repo, ctx.body), 'application/x-git-upload-pack-result');
        return;
      }
      sendRaw(ctx, 400, Buffer.from('unknown command\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    sendRaw(ctx, 200, uploadPackV0(found.repo, ctx.body), 'application/x-git-upload-pack-result');
  } catch {
    sendRaw(ctx, 400, Buffer.from('bad request\n', 'utf8'), 'text/plain; charset=utf-8');
  }
}

function gitReceivePack(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const found = gitRepo(ctx);
  if (!found) {
    sendRaw(ctx, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const repo = found.repo;
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  let commands: Command[] = [];
  let packStart = 0;
  try {
    // Parse pkt-lines manually: the raw pack follows the flush packet, so a
    // whole-body decode would choke on the pack bytes.
    let offset = 0;
    let sawFlush = false;
    while (offset + 4 <= ctx.body.length) {
      const head = ctx.body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (head === '0001') {
        offset += 4;
        continue;
      }
      const len = Number.parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || offset + len > ctx.body.length) throw new Error('bad pkt-line length');
      const line = ctx.body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!.toLowerCase(), newOid: parts[1]!.toLowerCase(), ref: parts.slice(2).join(' ') });
      offset += len;
    }
    if (!sawFlush) throw new Error('no flush after commands');
    packStart = offset;
  } catch {
    sendRaw(ctx, 400, Buffer.from('bad pkt-line\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const packBytes = ctx.body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(Buffer.from(packBytes), (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack failed';
    }
  } else if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpacker error: empty pack';
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (!unpackOk) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        if (!current) {
          results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' });
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          results.push({ ref: c.ref, ok: false, reason: 'old oid mismatch' });
        } else {
          repo.refs.delete(c.ref);
          results.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(c.newOid)) {
        results.push({ ref: c.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (c.oldOid === ZERO_OID) {
        if (current) {
          results.push({ ref: c.ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(c.ref, c.newOid);
          results.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!current) {
        results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      if (c.oldOid !== current) {
        results.push({ ref: c.ref, ok: false, reason: 'old oid mismatch' });
        continue;
      }
      if (c.oldOid === c.newOid) {
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      // fast-forward check for branches
      if (c.ref.startsWith('refs/heads/')) {
        const newObj = repo.objects.get(c.newOid);
        const oldObj = repo.objects.get(c.oldOid);
        if (newObj?.type === 'commit' && oldObj?.type === 'commit' && !isAncestor(repo, c.oldOid, c.newOid)) {
          results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : `error ${unpackDetail}`}\n`];
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const inner = pktLines([...reportLines, 'flush']);
  const outer = Buffer.concat([sidebandPack(inner), PKT_FLUSH]);
  // sidebandPack wraps in band-1 pkt-lines; the report stream is band 1 data.
  sendRaw(ctx, 200, outer, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- dispatcher

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let body = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        body = Buffer.alloc(0);
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const ctx: Ctx = { req, res, url, path: url.pathname, method: req.method ?? 'GET', body, query: url.searchParams };
      try {
        if (ctx.method === 'GET' && ctx.path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (ctx.path === '/api/graphql' && ctx.method === 'POST') {
          graphqlRoute(ctx);
          return;
        }
        if (ctx.path === '/mcp') {
          mcpRoute(ctx);
          return;
        }
        if (ctx.path.startsWith('/api/v3')) {
          restRoute(ctx);
          return;
        }
        const gitMatch = /^\/[^/]+\/[^/]+\.git(\/.*)?$/.exec(ctx.path);
        if (gitMatch) {
          const suffix = gitMatch[1] ?? '';
          if (ctx.method === 'GET' && suffix.startsWith('/info/refs')) {
            gitInfoRefs(ctx);
            return;
          }
          if (ctx.method === 'POST' && suffix === '/git-upload-pack') {
            gitUploadPack(ctx);
            return;
          }
          if (ctx.method === 'POST' && suffix === '/git-receive-pack') {
            gitReceivePack(ctx);
            return;
          }
          if (ctx.method === 'GET' && suffix === '/HEAD') {
            sendRaw(ctx, 200, Buffer.from('ref: refs/heads/main\n', 'utf8'), 'text/plain; charset=utf-8');
            return;
          }
          sendRaw(ctx, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
          return;
        }
        err(ctx, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) {
          try {
            err(ctx, 500, e instanceof Error ? e.message : 'Internal Server Error');
          } catch {
            // response already gone
          }
        }
      }
    })();
  });
}
