import {
  ERROR_HTTP_STATUS,
  JRP_VERSION,
  JRP_VERSION_HEADER,
  MAX_BATCH_BYTES,
  RAW_CONTENT_TYPE,
  assertBatchWithinLimits,
  cursor,
  LimitExceededError,
  routes,
  type BatchFetchResponse,
  type BatchUploadResponse,
  type ContributionListRequest,
  type ContributionListResponse,
  type ContributionPutResponse,
  type ContributionStatusUpdateRequest,
  type ContributionStatusUpdateResult,
  type CreateRepoBody,
  type CreateRepoResponse,
  type Cursor,
  type ErrorCode,
  type ErrorEnvelope,
  type HeadsUpdateResponse,
  type EvidencePutResponse,
  type EvidenceQueryRequest,
  type EvidenceQueryResponse,
  type HeadUpdate,
  type HeadUpdateResult,
  type HeadsResponse,
  type HealthzResponse,
  type ListReposPage,
  type ObjectId,
  type ProvenancePutResponse,
  type ProvenanceQueryRequest,
  type ProvenanceQueryResponse,
  type ReadyzResponse,
  type Repo,
  type RepoSearchRequest,
  type RepoSearchResponse,
  type StatesLogRequest,
  type StatesLogResponse,
  type WireObject,
} from "@javelin/protocol";

export * from "@javelin/protocol";

// packages/protocol does not re-export ./model yet, so derive the domain shapes
// the SDK's public API names from the authoritative WireObject union.
export type HeadsView = HeadsResponse;
export type Contribution = Extract<WireObject, { kind: "contribution" }>["object"];
export type ProvenanceRecord = Extract<WireObject, { kind: "provenance" }>["object"];
export type EvidenceRecord = Extract<WireObject, { kind: "evidence" }>["object"];

/** Error thrown when the server responds with a JRP error envelope. */
export class JrpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Set only on `version_not_supported`: the major versions the server supports. */
  readonly supported?: number[];

  constructor(code: ErrorCode, message: string, status: number, supported?: number[]) {
    super(message);
    this.name = "JrpError";
    this.code = code;
    this.status = status;
    this.supported = supported;
  }
}

/** Error thrown when a response does not have the JRP envelope shape at all. */
export class JrpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JrpProtocolError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JavelinClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: FetchLike;
}

const textEncoder = new TextEncoder();

function enc(s: string): string {
  return encodeURIComponent(s);
}

function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, value);
  }
  const s = qs.toString();
  return s === "" ? "" : `?${s}`;
}

/** Brand a server-produced cursor so it can only flow back into cursor parameters. */
function brandPage<T extends { nextCursor?: Cursor }>(res: T): T {
  const next = res.nextCursor;
  if (next === undefined) return res;
  return { ...res, nextCursor: cursor(next) };
}

export class JavelinClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, token, fetch }: JavelinClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetch ?? globalThis.fetch;
  }

  async createRepo(req: CreateRepoBody): Promise<Repo> {
    const res = await this.request<CreateRepoResponse>("POST", routes.repos, ["repo"], req);
    return res.repo;
  }

  async listRepos(cursor?: Cursor): Promise<ListReposPage> {
    return brandPage(await this.request<ListReposPage>("GET", `${routes.repos}${query({ cursor })}`, ["repos"]));
  }

  async getHeads(repo: string): Promise<HeadsView> {
    return this.request<HeadsView>("GET", routes.heads(enc(repo)), ["world", "layers"]);
  }

  async updateHeads(repo: string, updates: HeadUpdate[]): Promise<HeadUpdateResult[]> {
    const res = await this.request<HeadsUpdateResponse>("POST", routes.headsUpdate(enc(repo)), ["results"], { updates });
    return res.results;
  }

  async batchFetch(repo: string, ids: ObjectId[]): Promise<BatchFetchResponse> {
    return this.request("POST", routes.objectsBatchFetch(enc(repo)), ["objects", "missing"], { ids });
  }

  async batchUpload(repo: string, objects: WireObject[]): Promise<BatchUploadResponse> {
    assertBatchWithinLimits(objects);
    return this.request("POST", routes.objectsBatchUpload(enc(repo)), ["accepted", "rejected"], { objects });
  }

  async putRawBlob(repo: string, id: ObjectId, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.send("PUT", routes.raw(enc(repo), enc(id)), bytes, { "content-type": RAW_CONTENT_TYPE });
  }

  async getRawBlob(repo: string, id: ObjectId): Promise<Uint8Array<ArrayBuffer>> {
    const res = await this.send("GET", routes.raw(enc(repo), enc(id)));
    return new Uint8Array(await res.arrayBuffer());
  }

  async statesLog(repo: string, req: StatesLogRequest): Promise<StatesLogResponse> {
    return brandPage(await this.request("POST", routes.statesLog(enc(repo)), ["entries"], req));
  }

  async ingestProvenance(repo: string, record: ProvenanceRecord): Promise<ObjectId> {
    const res = await this.request<ProvenancePutResponse>("POST", routes.provenance(enc(repo)), ["id"], { record });
    return res.id;
  }

  async queryProvenance(repo: string, req: ProvenanceQueryRequest = {}): Promise<ProvenanceQueryResponse> {
    return brandPage(await this.request("POST", routes.provenanceQuery(enc(repo)), ["records"], req));
  }

  async ingestEvidence(repo: string, record: EvidenceRecord): Promise<ObjectId> {
    const res = await this.request<EvidencePutResponse>("POST", routes.evidence(enc(repo)), ["id"], { record });
    return res.id;
  }

  async queryEvidence(repo: string, req: EvidenceQueryRequest): Promise<EvidenceQueryResponse> {
    return this.request("POST", routes.evidenceQuery(enc(repo)), ["records"], req);
  }

  async createContribution(repo: string, contribution: Contribution): Promise<ObjectId> {
    const res = await this.request<ContributionPutResponse>("POST", routes.contributions(enc(repo)), ["id"], { contribution });
    return res.id;
  }

  async listContributions(repo: string, req: ContributionListRequest = {}): Promise<ContributionListResponse> {
    return brandPage(
      await this.request<ContributionListResponse>(
        "GET",
        `${routes.contributions(enc(repo))}${query({ status: req.status, cursor: req.cursor })}`,
        ["contributions"],
      ),
    );
  }

  async updateContributionStatus(
    repo: string,
    id: ObjectId,
    req: ContributionStatusUpdateRequest,
  ): Promise<ContributionStatusUpdateResult> {
    return this.request("POST", routes.contributionStatus(enc(repo), enc(id)), ["id", "ok"], req);
  }

  async search(repo: string, req: RepoSearchRequest): Promise<RepoSearchResponse> {
    return brandPage(await this.request("POST", routes.search(enc(repo)), ["hits"], req));
  }

  async health(): Promise<boolean> {
    const res = await this.request<HealthzResponse>("GET", routes.healthz, ["ok"]);
    return res.ok;
  }

  async ready(): Promise<ReadyzResponse> {
    return this.request("GET", routes.readyz, ["ok", "checks"]);
  }

  /** Send a request and return the raw response, mapping error envelopes to JrpError. */
  private async send(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    headers[JRP_VERSION_HEADER] = String(JRP_VERSION);
    if (this.token !== undefined) headers["authorization"] = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
    if (!res.ok) throw await this.errorFrom(res);
    return res;
  }

  /**
   * Send a JSON request and parse the success envelope.
   *
   * Envelope validation is deliberately shallow: the expected top-level fields must
   * be present, everything below them is trusted (see docs/jrp-spec.md section 4).
   * Replace with schema validation when the protocol grows a schema library.
   */
  private async request<T extends object>(
    method: string,
    path: string,
    expectedFields: readonly string[],
    body?: object,
  ): Promise<T> {
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      const size = textEncoder.encode(payload).length;
      if (size > MAX_BATCH_BYTES) {
        throw new LimitExceededError(MAX_BATCH_BYTES, size, "request body");
      }
    }
    const res = await this.send(method, path, payload, { "content-type": "application/json" });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new JrpProtocolError(`${res.status} response is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || expectedFields.some((field) => !(field in parsed))) {
      throw new JrpProtocolError(
        `expected ${res.status} body with fields [${expectedFields.join(", ")}], got ${JSON.stringify(parsed)}`,
      );
    }
    return parsed as T;
  }

  private async errorFrom(res: Response): Promise<JrpError | JrpProtocolError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return new JrpError("internal", `${res.status} ${res.statusText}`, res.status);
    }
    const error = (body as Partial<ErrorEnvelope> | null)?.error;
    if (typeof error !== "object" || error === null || typeof error.code !== "string" || !(error.code in ERROR_HTTP_STATUS)) {
      return new JrpProtocolError(`${res.status} response is not a JRP error envelope: ${JSON.stringify(body)}`);
    }
    const supported = Array.isArray(error.supported) ? error.supported : undefined;
    return new JrpError(error.code, error.message ?? `${res.status} ${res.statusText}`, res.status, supported);
  }
}
