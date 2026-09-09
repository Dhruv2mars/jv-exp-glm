/**
 * Line-level three-way merge. base/ours/theirs are line arrays (split on "\n").
 * Returns the merged lines, or null when the same region changed on both sides.
 * Each side is diffed against base into hunks; hunks that touch disjoint base
 * lines merge, hunks that overlap (or both insert at one point) conflict.
 */
interface Hunk {
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

function edits(base: string[], side: string[], matches: number[]): Hunk[] {
  const hunks: Hunk[] = [];
  let b = 0;
  let s = 0;
  while (b < base.length) {
    if (matches[b] === s) {
      b++;
      s++;
      continue;
    }
    const baseStart = b;
    const sideStart = s;
    while (b < base.length && matches[b] !== s) {
      if (matches[b] === -1) b++;
      else if (matches[b]! > s) s = matches[b]!;
      else break;
    }
    hunks.push({ baseStart, baseEnd: b, sideStart, sideEnd: s });
  }
  if (s < side.length) hunks.push({ baseStart: base.length, baseEnd: base.length, sideStart: s, sideEnd: side.length });
  return hunks;
}

function hunksOverlap(a: Hunk, b: Hunk): boolean {
  if (a.baseStart < a.baseEnd && b.baseStart < b.baseEnd) {
    return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
  }
  const point = a.baseStart === a.baseEnd ? a.baseStart : b.baseStart;
  const other = a.baseStart === a.baseEnd ? b : a;
  return point >= other.baseStart && point <= other.baseEnd;
}

function pushRange(out: string[], lines: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) out.push(lines[i]!);
}

export function diff3(base: string[], ours: string[], theirs: string[]): { lines: string[] | null } {
  const oursHunks = edits(base, ours, lcsMatches(base, ours));
  const theirsHunks = edits(base, theirs, lcsMatches(base, theirs));
  const out: string[] = [];
  let b = 0;
  let io = 0;
  let it = 0;
  while (io < oursHunks.length || it < theirsHunks.length) {
    const takeOurs =
      it >= theirsHunks.length || (io < oursHunks.length && oursHunks[io]!.baseStart <= theirsHunks[it]!.baseStart);
    const hunk = takeOurs ? oursHunks[io]! : theirsHunks[it]!;
    if (hunk.baseStart < b) return { lines: null };
    if (hunk.baseStart > b) {
      pushRange(out, base, b, hunk.baseStart);
      b = hunk.baseStart;
    }
    const other = takeOurs ? theirsHunks[it] : oursHunks[io];
    if (other && hunksOverlap(hunk, other)) {
      const oursChunk = ours.slice(hunk.sideStart, hunk.sideEnd);
      const theirsChunk = theirs.slice(other.sideStart, other.sideEnd);
      if (!linesEqual(oursChunk, theirsChunk)) return { lines: null };
      pushRange(out, ours, hunk.sideStart, hunk.sideEnd);
      b = Math.max(hunk.baseEnd, other.baseEnd);
      io++;
      it++;
      continue;
    }
    pushRange(out, takeOurs ? ours : theirs, hunk.sideStart, hunk.sideEnd);
    b = hunk.baseEnd;
    if (takeOurs) io++;
    else it++;
  }
  pushRange(out, base, b, base.length);
  return { lines: out };
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function joinLines(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, idx) => line === b[idx]);
}

/** matches[i] = index in b matched to a[i] via LCS, or -1. */
function lcsMatches(a: string[], b: string[]): number[] {
  const matches = new Array<number>(a.length).fill(-1);
  let lo = 0;
  let hiA = a.length;
  let hiB = b.length;
  while (lo < hiA && lo < hiB && a[lo] === b[lo]) {
    matches[lo] = lo;
    lo++;
  }
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
    matches[hiA] = hiB;
  }
  const n = hiA - lo;
  const m = hiB - lo;
  if (n === 0 || m === 0) return matches;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let row = n - 1; row >= 0; row--) {
    for (let col = m - 1; col >= 0; col--) {
      const diagonal = dp[(row + 1) * width + col + 1]!;
      const down = dp[(row + 1) * width + col]!;
      const right = dp[row * width + col + 1]!;
      dp[row * width + col] =
        a[lo + row] === b[lo + col] ? diagonal + 1 : Math.max(down, right);
    }
  }
  let row = 0;
  let col = 0;
  while (row < n && col < m) {
    if (a[lo + row] === b[lo + col]) {
      matches[lo + row] = lo + col;
      row++;
      col++;
    } else if (dp[(row + 1) * width + col]! >= dp[row * width + col + 1]!) {
      row++;
    } else {
      col++;
    }
  }
  return matches;
}
