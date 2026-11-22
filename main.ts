// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: command line, output and exit codes, safe paths,
// format detection, unified diffs (6), SEARCH/REPLACE (7), V4A (8), JSON edits (9),
// line matching at three tiers (5), and the all-or-nothing write (10).
//
// main.ts hands a trial over to runner.ts when MAKEFUN_ENV_URL is set: keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5)                   */
/* ------------------------------------------------------------------ */

function trimEnd(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  return trimBoth(a) === trimBoth(b);
}

/** All 0-based positions where O occurs in fileLines at the given tier. */
function occurrences(fileLines: string[], O: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** First tier (0..2, or only 0 when strict) at which O occurs, with its positions. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(fileLines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * First occurrence of O at or after `from`, at the first tier with one.
 * When eofOnly, only occurrences ending at the file's last line count.
 */
function findTierFrom(
  fileLines: string[],
  O: string[],
  strict: boolean,
  from: number,
  eofOnly = false,
): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(fileLines, O, t).filter(
      (p) => p >= from && (!eofOnly || p + O.length === fileLines.length),
    );
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** a `\` line follows this body line */
  noNL: boolean;
}

/**
 * Replace O (the ctx+old items) at position `at` with N, honouring section 5:
 * context lines are written as the file's own matched lines; at tier 2 the other
 * lines of N are re-indented from P (O's first line) to F (the file's first line).
 */
function applyItems(fileLines: string[], at: number, items: BodyItem[], tier: number): string[] {
  const O = items.filter((it) => it.kind !== 'new').map((it) => it.text);
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  const F = at < fileLines.length ? leadingWS(fileLines[at]!) : '';
  const repl: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      repl.push(fileLines[at + oi]!);
      oi++;
    } else if (it.kind === 'old') {
      oi++;
    } else {
      repl.push(tier === 2 ? reindent(it.text, P, F) : it.text);
    }
  }
  return [...fileLines.slice(0, at), ...repl, ...fileLines.slice(at + O.length)];
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
  /** a `\` line follows the hunk's last context or `+` line */
  lastNoNL: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  oldIsDevNull: boolean;
  newIsDevNull: boolean;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function uniPath(raw: string): string | null {
  // text after the four characters, up to the first tab, surrounding spaces removed
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function uniPathIsDevNull(raw: string): boolean {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim() === '/dev/null';
}

function parseDiffGit(line: string, idx: number): { old: string; new: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { old: m[1]!, new: m[2]! };
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** Parse one hunk body starting after its header at `start`; returns the hunk and the next index. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const items: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', noNL: false });
      i++;
    } else if (l.startsWith(' ')) {
      items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      i++;
    } else if (l.startsWith('-')) {
      items.push({ kind: 'old', text: l.slice(1), noNL: false });
      i++;
    } else if (l.startsWith('+')) {
      items.push({ kind: 'new', text: l.slice(1), noNL: false });
      i++;
    } else if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noNL = true;
      i++;
    } else {
      break;
    }
  }
  // empty lines at the end of a body are not part of it
  while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') {
    items.pop();
  }
  let lastNoNL = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      lastNoNL = it.noNL;
      break;
    }
  }
  return { hunk: { a: 0, items, lastNoNL }, next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hdrOld: string | null = null;
  let hdrNew: string | null = null;
  let hdrOldDevNull = false;
  let hdrNewDevNull = false;
  let hasPair = false;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let dgOld: string | null = null;
  let dgNew: string | null = null;
  let state: 'OUT' | 'HEADER' | 'HUNKS' = 'OUT';

  const finishSection = (): void => {
    if (cur === null) return;
    let oldPath: string | null;
    let newPath: string | null;
    if (hasPair) {
      oldPath = hdrOldDevNull ? null : hdrOld;
      newPath = hdrNewDevNull ? null : hdrNew;
    } else {
      oldPath = renOld ?? dgOld;
      newPath = renNew ?? dgNew;
    }
    cur.oldPath = oldPath;
    cur.newPath = newPath;
    cur.oldIsDevNull = hdrOldDevNull;
    cur.newIsDevNull = hdrNewDevNull;
    sections.push(cur);
    cur = null;
  };
  const startSection = (dg: { old: string; new: string } | null): void => {
    finishSection();
    cur = { oldPath: null, newPath: null, oldIsDevNull: false, newIsDevNull: false, newFileMode: false, deletedFileMode: false, hunks: [] };
    hdrOld = null;
    hdrNew = null;
    hdrOldDevNull = false;
    hdrNewDevNull = false;
    hasPair = false;
    renOld = null;
    renNew = null;
    dgOld = dg?.old ?? null;
    dgNew = dg?.new ?? null;
    state = 'HEADER';
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (state === 'OUT') {
      if (line.startsWith('diff --git ')) {
        const dg = parseDiffGit(line, i);
        startSection(dg);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null);
        // fall through: HEADER state handles the ---/+++ pair
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    } else if (state === 'HEADER') {
      if (line.startsWith('diff --git ')) {
        const dg = parseDiffGit(line, i);
        startSection(dg);
        i++;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (hasPair) {
            startSection(null);
          } else {
            hdrOldDevNull = uniPathIsDevNull(line);
            hdrNewDevNull = uniPathIsDevNull(lines[i + 1]!);
            hdrOld = uniPath(line);
            hdrNew = uniPath(lines[i + 1]!);
            hasPair = true;
            i += 2;
          }
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        if (!hasPair) {
          hdrNewDevNull = uniPathIsDevNull(line);
          hdrNew = uniPath(line);
          hasPair = true;
        }
        i++;
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { hunk, next } = parseHunkBody(lines, i + 1);
        hunk.a = a;
        cur!.hunks.push(hunk);
        state = 'HUNKS';
        i = next;
      } else if (line.startsWith('rename from ')) {
        renOld = line.slice('rename from '.length).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        renNew = line.slice('rename to '.length).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        cur!.newFileMode = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur!.deletedFileMode = true;
        i++;
      } else {
        // index, old mode, new mode, similarity/dissimilarity, Index:, any other line: ignored
        i++;
      }
    } else {
      // HUNKS
      if (line.startsWith('diff --git ')) {
        const dg = parseDiffGit(line, i);
        startSection(dg);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null);
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { hunk, next } = parseHunkBody(lines, i + 1);
        hunk.a = a;
        cur!.hunks.push(hunk);
        i = next;
      } else {
        i++;
      }
    }
  }
  finishSection();

  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = [...st.lines];
  let final = st.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    const nLen = h.items.filter((it) => it.kind !== 'old').length;
    if (O.length === 0) {
      const newLines = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      const oldLen = lines.length;
      let at = h.a + d;
      if (at > oldLen) at = oldLen;
      if (at < 0) at = 0;
      lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
      if (at === oldLen) final = !h.lastNoNL;
      d += newLines.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const at = best;
      const runsToEnd = at + O.length === lines.length;
      lines = applyItems(lines, at, h.items, found.tier);
      if (runsToEnd) final = !h.lastNoNL;
      d += nLen - O.length;
    }
  }
  return { lines, br: st.br, final };
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const isCreate = sec.oldIsDevNull || sec.newFileMode;
  const isDelete = sec.newIsDevNull || sec.deletedFileMode;
  return (tree) => {
    if (isCreate && sec.newPath !== null) {
      const np = sec.newPath;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNew: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            lastNew = it;
          }
        }
      }
      if (lastNew === null) {
        tree.now.set(np, '');
      } else {
        const final = !lastNew.noNL;
        tree.now.set(np, plus.join('\n') + (final ? '\n' : ''));
      }
      return;
    }
    if (isDelete && sec.oldPath !== null) {
      const op = sec.oldPath;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && newP !== null && oldP !== newP) {
      // move
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = applyHunks(parseFile(before), sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeFile(st));
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const p = oldP ?? newP;
    if (p === null) throw new Fail('missing', oldP ?? '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const st = applyHunks(parseFile(before), sec.hunks, strict, p);
    tree.now.set(p, writeFile(st));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1; // index of previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    // path: nearest line before SEARCH, after prevReplace, not blank, not starting with ```
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    // find ======= then >>>>>>> REPLACE
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = parseFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const P = leadingWS(oldLines[0]!);
    const F = leadingWS(st.lines[at]!);
    const repl = newLines.map((l) => (found.tier === 2 ? reindent(l, P, F) : l));
    const out = [...st.lines.slice(0, at), ...repl, ...st.lines.slice(at + oldLines.length)];
    tree.now.set(path, writeFile({ lines: out, br: st.br, final: st.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4Chunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4Section {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4Chunk[];
  lineNo: number; // 1-based line of the section's header
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    // collect this section's lines until the next section start or *** End Patch
    const raw: Array<{ text: string; idx: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, idx: i });
      i++;
    }
    // blank lines at the end of a section are not part of it
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], lineNo: headerLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], lineNo: headerLine });
    } else {
      // update
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: V4Chunk[] = [];
      let cur: V4Chunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim(), items: [], eof: false };
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          endChunk();
        } else if (l.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
            cur = { anchor: null, items: [], eof: false };
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '', noNL: false });
          else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
          else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1), noNL: false });
          else cur.items.push({ kind: 'new', text: l.slice(1), noNL: false });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      endChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, lineNo: headerLine });
    }
  }

  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

function v4aSectionEdit(sec: V4Section, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const ls = sec.addLines;
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = parseFile(before);
    let lines = [...st.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTierFrom(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos + 1;
      }
      const O = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      if (O.length === 0) {
        const newLines = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
        cursor = at + newLines.length;
      } else {
        const found = findTierFrom(lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const at = found.pos;
        lines = applyItems(lines, at, ch.items, found.tier);
        cursor = at + ch.items.filter((it) => it.kind !== 'old').length;
      }
    }
    const out = writeFile({ lines, br: st.br, final: st.final });
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2, 10)                                  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // output rows, with R lines for moves (sorted by <new>), the rest by path
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    const oldOrig = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newOrig = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldOrig !== null && oldNow === null && newOrig === null && newNow !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
