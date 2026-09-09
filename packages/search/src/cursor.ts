// Keyset pagination over ranked hits. Underlying objects are immutable, so a
// (score, id) key totally orders a result set and pages stay stable.

/** A cursor that points just past `s`/`k` in (score desc, id asc) order. */
export interface RankKey {
  s: number;
  k: string;
}

export interface Page<T> {
  hits: T[];
  nextCursor?: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
  }
}

export function encodeCursor(key: RankKey): string {
  return btoa(JSON.stringify(key));
}

export function decodeCursor(raw: string | undefined): RankKey | null {
  if (raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidCursorError();
  const { s, k } = parsed as { s: unknown; k: unknown };
  if (typeof s !== "number" || typeof k !== "string") throw new InvalidCursorError();
  return { s, k };
}

/**
 * Page a list sorted by (score desc, id asc) starting strictly after the
 * cursor. `nextCursor` is absent on the last page.
 */
export function keysetPage<T>(
  ranked: T[],
  rank: (item: T) => RankKey,
  rawCursor: string | undefined,
  limit: number,
): Page<T> {
  const cur = decodeCursor(rawCursor);
  let start = 0;
  if (cur) {
    start = ranked.findIndex((item) => {
      const key = rank(item);
      return key.s < cur.s || (key.s === cur.s && key.k > cur.k);
    });
    if (start < 0) return { hits: [] };
  }
  const hits = ranked.slice(start, start + limit);
  const last = hits[hits.length - 1];
  if (last === undefined || start + limit >= ranked.length) return { hits };
  return { hits, nextCursor: encodeCursor(rank(last)) };
}
