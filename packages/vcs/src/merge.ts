/**
 * Line-level three-way merge. base/ours/theirs are line arrays (split on "\n").
 * Returns the merged lines, or null when the same region changed on both sides.
 */
export function diff3(base: string[], ours: string[], theirs: string[]): { lines: string[] | null } {
  const mo = lcsMatches(base, ours);
  const mt = lcsMatches(base, theirs);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < base.length) {
    if (mo[i] === j && mt[i] === k) {
      out.push(base[i]!);
      i++;
      j++;
      k++;
      continue;
    }
    let i2 = i;
    while (i2 < base.length && (mo[i2] === -1 || mt[i2] === -1)) i2++;
    const oEnd = i2 < base.length ? mo[i2]! : ours.length;
    const tEnd = i2 < base.length ? mt[i2]! : theirs.length;
    const bChunk = base.slice(i, i2);
    const oChunk = ours.slice(j, oEnd);
    const tChunk = theirs.slice(k, tEnd);
    if (linesEqual(oChunk, tChunk)) out.push(...oChunk);
    else if (linesEqual(bChunk, oChunk)) out.push(...tChunk);
    else if (linesEqual(bChunk, tChunk)) out.push(...oChunk);
    else return { lines: null };
    i = i2;
    j = oEnd;
    k = tEnd;
  }
  if (j < ours.length || k < theirs.length) {
    const oChunk = ours.slice(j);
    const tChunk = theirs.slice(k);
    if (linesEqual(oChunk, tChunk) || tChunk.length === 0) out.push(...oChunk);
    else if (oChunk.length === 0) out.push(...tChunk);
    else return { lines: null };
  }
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
