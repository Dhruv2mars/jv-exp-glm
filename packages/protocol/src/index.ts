// JRP: Javelin Repository Protocol shared types.
// These types are the contract between the CLI, javelind, SDK, and web app.

/** A sha256 hex object id. */
export type ObjectId = string & { readonly __objectId: unique symbol };

export function objectId(hex: string): ObjectId {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid object id: ${hex}`);
  return hex as ObjectId;
}

export function isObjectId(s: string): s is ObjectId {
  return /^[0-9a-f]{64}$/.test(s);
}

export type ObjectKind = "blob" | "tree" | "commit" | "tag" | "provenance" | "evidence";

export interface TreeEntry {
  name: string;
  kind: "blob" | "tree";
  id: ObjectId;
}

export interface Tree {
  kind: "tree";
  entries: TreeEntry[];
}

export interface Commit {
  kind: "commit";
  tree: ObjectId;
  parents: ObjectId[];
  author: { name: string; email: string; time: string };
  committer: { name: string; email: string; time: string };
  message: string;
  /** ObjectIds of provenance records describing how this commit was produced. */
  provenance?: ObjectId[];
}

export interface AnnotatedTag {
  kind: "tag";
  target: ObjectId;
  name: string;
  tagger: { name: string; email: string; time: string };
  message: string;
}

export interface ProvenanceRecord {
  kind: "provenance";
  agent: { name: string; adapter: "generic" | "codex" | "claude-code"; session?: string };
  model?: string;
  prompt?: string;
  parentRun?: string;
  startedAt: string;
  finishedAt?: string;
  exit?: "success" | "failure" | "cancelled";
  summary?: string;
}

export interface EvidenceRecord {
  kind: "evidence";
  run: string;
  check: string;
  status: "pass" | "fail";
  detail?: string;
  at: string;
}

export type JvlObject =
  | { kind: "blob" }
  | Tree
  | Commit
  | AnnotatedTag
  | ProvenanceRecord
  | EvidenceRecord;

/** Wire form: the object's fields plus its raw payload for blobs. */
export type SerializedObject =
  | { id: ObjectId; kind: "blob"; data: string }
  | { id: ObjectId; kind: "tree"; object: Tree }
  | { id: ObjectId; kind: "commit"; object: Commit }
  | { id: ObjectId; kind: "tag"; object: AnnotatedTag }
  | { id: ObjectId; kind: "provenance"; object: ProvenanceRecord }
  | { id: ObjectId; kind: "evidence"; object: EvidenceRecord };

export type RefName = string; // e.g. "refs/heads/main"

export interface RefUpdate {
  ref: RefName;
  /** Expected current value; null-headed hex means create. */
  expectedOld: ObjectId | null;
  new: ObjectId | null;
}

export interface RefUpdateResult {
  ref: RefName;
  ok: boolean;
  reason?: "cas-mismatch" | "non-fast-forward" | "policy-rejected" | "not-found";
  detail?: string;
}

// ---- Protocol envelopes ----

export type JrpErrorCode =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "policy_rejected"
  | "bad_request"
  | "internal";

export interface JrpError {
  error: { code: JrpErrorCode; message: string };
}

export interface RepoInfo {
  name: string;
  createdAt: string;
  defaultBranch: string;
  description?: string;
  policy?: { requireEvidence?: string[] } | null;
}

export interface CreateRepoRequest { name: string; defaultBranch?: string; description?: string }
export interface ListReposRequest { }
export interface ListReposResponse { repos: RepoInfo[] }

export interface ListRefsRequest { repo: string }
export interface ListRefsResponse { refs: Record<RefName, ObjectId> }

export interface FetchObjectsRequest { repo: string; want: ObjectId[] }
export interface FetchObjectsResponse { objects: SerializedObject[] }

export interface UploadObjectsRequest { repo: string; objects: SerializedObject[] }
export interface UploadObjectsResponse { accepted: ObjectId[]; rejected: { id: ObjectId; reason: string }[] }

export interface UpdateRefsRequest { repo: string; updates: RefUpdate[] }
export interface UpdateRefsResponse { results: RefUpdateResult[] }

export interface LogRequest { repo: string; start: RefName | ObjectId; limit?: number }
export interface LogResponse { commits: CommitSummary[] }

export interface CommitSummary {
  id: ObjectId;
  tree: ObjectId;
  parents: ObjectId[];
  author: { name: string; email: string; time: string };
  message: string;
  provenance?: ObjectId[];
}

export interface SearchRequest { repo: string; query: string; kind?: "code" | "history" | "provenance"; limit?: number }
export interface SearchHit {
  kind: "code" | "history" | "provenance";
  path?: string;
  commit?: ObjectId;
  provenance?: ObjectId;
  snippet?: string;
  score: number;
}
export interface SearchResponse { hits: SearchHit[] }

export interface BackupRequest { repo?: string }
export interface BackupResponse { archive: string; repos: string[]; at: string }

export const JRP_PROTOCOL_VERSION = 1;
