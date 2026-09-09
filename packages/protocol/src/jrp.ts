// JRP v2: the wire contract for the Javelin Repository Protocol.
// Normative spec: docs/jrp-spec.md. These types are a projection of that spec.
// Domain shapes come from ./model; this module owns framing, limits, and endpoints.

import type { ObjectId } from "./index";
import type {
  Contribution,
  ContributionStatus,
  EvidenceRecord,
  HeadsView,
  Person,
  ProvenanceRecord,
  State,
  Tree,
} from "./model";

// ---- Versioning ----

export const JRP_VERSION = 2;
export const JRP_VERSION_HEADER = "x-jrp-version";

// ---- Limits (see docs/jrp-spec.md "Limits") ----

/** Maximum size of any single JSON request body. */
export const MAX_BATCH_BYTES = 32 * 1024 * 1024;
/** Maximum decoded size of a blob carried inside a JSON batch. Larger blobs use the raw endpoints. */
export const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 1000;
export const RAW_CONTENT_TYPE = "application/octet-stream";

// ---- Errors ----

export type ErrorCode =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "version_not_supported"
  | "payload_too_large"
  | "bad_request"
  | "internal";

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    /** Present only on `version_not_supported`: the versions this server does support. */
    supported?: number[];
  };
}

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_not_supported: 409,
  payload_too_large: 413,
  internal: 500,
};

// ---- Pagination ----

/** Opaque, server-produced continuation token. Clients must not parse or construct one. */
export type Cursor = string & { readonly __cursor: unique symbol };

export function cursor(raw: string): Cursor {
  if (raw.length === 0) throw new Error("cursor must be a non-empty opaque string");
  return raw as Cursor;
}

// ---- Wire object encoding ----

/**
 * A content-addressed object on the wire. Blobs travel as base64 `data`;
 * structured kinds travel as canonical JSON in `object`.
 */
export type BlobWireObject = { id: ObjectId; kind: "blob"; data: string };

export type WireObject =
  | BlobWireObject
  | { id: ObjectId; kind: "tree"; object: Tree }
  | { id: ObjectId; kind: "state"; object: State }
  | { id: ObjectId; kind: "provenance"; object: ProvenanceRecord }
  | { id: ObjectId; kind: "evidence"; object: EvidenceRecord }
  | { id: ObjectId; kind: "contribution"; object: Contribution };

/** A blob exceeded a size limit. Servers map this to `payload_too_large`. */
export class LimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly actual: number,
    what: string,
  ) {
    super(`${what} is ${actual} bytes; limit is ${limit} bytes`);
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64DecodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Encode a blob as a wire object, rejecting anything over MAX_OBJECT_BYTES. */
export function encodeWireBlob(id: ObjectId, bytes: Uint8Array): BlobWireObject {
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new LimitExceededError(MAX_OBJECT_BYTES, bytes.byteLength, `blob ${id}`);
  }
  return { id, kind: "blob", data: encodeBase64(bytes) };
}

/** Decode a blob wire object back to raw bytes, re-checking the limit. */
export function decodeWireBlob(object: WireObject): Uint8Array {
  if (object.kind !== "blob") throw new Error(`object ${object.id} is not a blob`);
  const bytes = decodeBase64(object.data);
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new LimitExceededError(MAX_OBJECT_BYTES, bytes.byteLength, `blob ${object.id}`);
  }
  return bytes;
}

const textEncoder = new TextEncoder();

/** Reject a wire object whose blob payload exceeds MAX_OBJECT_BYTES. */
export function assertObjectWithinLimits(object: WireObject): void {
  if (object.kind === "blob") {
    const size = base64DecodedLength(object.data);
    if (size > MAX_OBJECT_BYTES) {
      throw new LimitExceededError(MAX_OBJECT_BYTES, size, `blob ${object.id}`);
    }
  }
}

/** Reject a batch whose serialized size exceeds MAX_BATCH_BYTES. */
export function assertBatchWithinLimits(objects: readonly WireObject[]): void {
  let total = 0;
  for (const object of objects) {
    assertObjectWithinLimits(object);
    total += textEncoder.encode(JSON.stringify(object)).length;
  }
  if (total > MAX_BATCH_BYTES) {
    throw new LimitExceededError(MAX_BATCH_BYTES, total, "batch");
  }
}

// ---- Repos ----

export interface Repo {
  name: string;
  description?: string;
  createdAt: string;
}

export interface CreateRepoBody {
  name: string;
  description?: string;
}

export interface CreateRepoResponse {
  repo: Repo;
}

export interface ListReposQuery {
  cursor?: Cursor;
}

export interface ListReposPage {
  repos: Repo[];
  nextCursor?: Cursor;
}

// ---- Heads and CAS ----

/** A mutable head pointer: the World head or a layer head. */
export type HeadKey = "world" | `layer/${string}`;

export interface HeadUpdate {
  key: HeadKey;
  /** Expected current value; null means the head must not exist. */
  expected: ObjectId | null;
  /** Value to install; null deletes the head. */
  next: ObjectId | null;
}

export type HeadUpdateResult =
  | { key: HeadKey; ok: true }
  | { key: HeadKey; ok: false; reason: "cas-mismatch" | "not-found" };

export interface HeadsUpdateRequest {
  updates: HeadUpdate[];
}

export interface HeadsUpdateResponse {
  results: HeadUpdateResult[];
}

/** GET heads returns the full read-only view of mutable pointers. */
export type HeadsResponse = HeadsView;

// ---- Object batches ----

export interface BatchFetchRequest {
  ids: ObjectId[];
}

export interface BatchFetchResponse {
  objects: WireObject[];
  /** Ids from the request that the server does not store. */
  missing: ObjectId[];
}

export interface BatchUploadRequest {
  objects: WireObject[];
}

export interface BatchUploadResponse {
  accepted: ObjectId[];
  rejected: { id: ObjectId; reason: string }[];
}

// ---- Raw blob transfer ----
// PUT routes.raw sets Content-Type: application/octet-stream and Content-Length,
// and streams the body; GET streams the response. Blobs larger than
// MAX_OBJECT_BYTES MUST use these endpoints. GET returns 404 when absent.

// ---- State log ----

export interface StatesLogRequest {
  start: ObjectId;
  cursor?: Cursor;
  limit?: number;
}

export interface StateLogEntry {
  id: ObjectId;
  parents: ObjectId[];
  message: string;
  author: Person;
}

export interface StatesLogResponse {
  entries: StateLogEntry[];
  nextCursor?: Cursor;
}

// ---- Provenance ----

export interface ProvenancePutRequest {
  record: ProvenanceRecord;
}

export interface ProvenancePutResponse {
  id: ObjectId;
}

export interface ProvenanceQueryRequest {
  states?: ObjectId[];
  agent?: string;
  cursor?: Cursor;
}

export interface ProvenanceQueryResponse {
  records: ProvenanceRecord[];
  nextCursor?: Cursor;
}

// ---- Evidence ----

export interface EvidencePutRequest {
  record: EvidenceRecord;
}

export interface EvidencePutResponse {
  id: ObjectId;
}

export interface EvidenceQueryRequest {
  state: ObjectId;
  rules?: string;
}

export interface EvidenceQueryResponse {
  records: EvidenceRecord[];
}

// ---- Contributions ----

export interface ContributionPutRequest {
  contribution: Contribution;
}

export interface ContributionPutResponse {
  id: ObjectId;
}

export interface ContributionWithStatus extends Contribution {
  id: ObjectId;
  status: ContributionStatus;
}

export interface ContributionListRequest {
  status?: ContributionStatus;
  cursor?: Cursor;
}

export interface ContributionListResponse {
  contributions: ContributionWithStatus[];
  nextCursor?: Cursor;
}

export const CONTRIBUTION_TRANSITIONS: Readonly<Record<ContributionStatus, readonly ContributionStatus[]>> = {
  open: ["published", "discarded"],
  published: [],
  discarded: [],
};

export function isLegalContributionTransition(from: ContributionStatus, to: ContributionStatus): boolean {
  return CONTRIBUTION_TRANSITIONS[from].includes(to);
}

export interface ContributionStatusUpdateRequest {
  expected: ContributionStatus;
  next: ContributionStatusUpdate;
}

/** A closing decision. `worldState` exists only on `published` (see docs/jrp-spec.md 7.10). */
export type ContributionStatusUpdate =
  | { status: "published"; worldState: ObjectId; note?: string }
  | { status: "discarded"; note?: string };

export type ContributionStatusUpdateResult =
  | { id: ObjectId; ok: true; status: ContributionStatus }
  | { id: ObjectId; ok: false; reason: "cas-mismatch" | "illegal-transition" | "not-found" };

// ---- Search ----

export type SearchKind = "code" | "history" | "provenance";

export type SearchResult =
  | { kind: "code"; blob: ObjectId; path: string; snippet: string; score: number }
  | { kind: "history"; state: ObjectId; snippet: string; score: number }
  | { kind: "provenance"; record: ObjectId; snippet: string; score: number };

export interface RepoSearchRequest {
  query: string;
  kind: SearchKind;
  cursor?: Cursor;
  limit?: number;
}

export interface RepoSearchResponse {
  hits: SearchResult[];
  nextCursor?: Cursor;
}

// ---- Health ----

export interface HealthzResponse {
  ok: boolean;
}

export interface ReadyzResponse {
  ok: boolean;
  checks: Record<string, boolean>;
}

// ---- Routes ----

export const routes = {
  repos: "/jrp/v2/repos",
  heads: (repo: string) => `/jrp/v2/repos/${repo}/heads`,
  headsUpdate: (repo: string) => `/jrp/v2/repos/${repo}/heads/update`,
  objectsBatchFetch: (repo: string) => `/jrp/v2/repos/${repo}/objects/batch-fetch`,
  objectsBatchUpload: (repo: string) => `/jrp/v2/repos/${repo}/objects/batch-upload`,
  raw: (repo: string, objectId: string) => `/jrp/v2/repos/${repo}/raw/${objectId}`,
  statesLog: (repo: string) => `/jrp/v2/repos/${repo}/states/log`,
  provenance: (repo: string) => `/jrp/v2/repos/${repo}/provenance`,
  provenanceQuery: (repo: string) => `/jrp/v2/repos/${repo}/provenance/query`,
  evidence: (repo: string) => `/jrp/v2/repos/${repo}/evidence`,
  evidenceQuery: (repo: string) => `/jrp/v2/repos/${repo}/evidence/query`,
  contributions: (repo: string) => `/jrp/v2/repos/${repo}/contributions`,
  contributionStatus: (repo: string, id: string) => `/jrp/v2/repos/${repo}/contributions/${id}/status`,
  search: (repo: string) => `/jrp/v2/repos/${repo}/search`,
  healthz: "/jrp/v2/healthz",
  readyz: "/jrp/v2/readyz",
} as const;
