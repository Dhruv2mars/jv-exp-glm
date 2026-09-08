import type {
  CommitSummary,
  CreateRepoRequest,
  FetchObjectsRequest,
  FetchObjectsResponse,
  ListReposResponse,
  ListRefsResponse,
  LogRequest,
  LogResponse,
  RepoInfo,
  SearchRequest,
  SearchResponse,
  SerializedObject,
  UpdateRefsRequest,
  UpdateRefsResponse,
  UploadObjectsRequest,
  UploadObjectsResponse,
  JrpErrorCode,
} from "@javelin/protocol";
import { JRP_PROTOCOL_VERSION } from "@javelin/protocol";

export * from "@javelin/protocol";

/** Error thrown for any non-2xx JRP response. */
export class JrpError extends Error {
  readonly code: JrpErrorCode;
  readonly status: number;

  constructor(code: JrpErrorCode, message: string, status: number) {
    super(message);
    this.name = "JrpError";
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JavelinClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: FetchLike;
}

type Body = Record<string, unknown>;

export class JavelinClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, token, fetch }: JavelinClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetch ?? globalThis.fetch;
  }

  async createRepo(req: CreateRepoRequest): Promise<RepoInfo> {
    return this.request("POST", "/jrp/v1/repos", req);
  }

  async listRepos(): Promise<ListReposResponse> {
    return this.request("GET", "/jrp/v1/repos");
  }

  async listRefs(repo: string): Promise<ListRefsResponse> {
    return this.request("GET", `/jrp/v1/repos/${enc(repo)}/refs`);
  }

  async fetchObjects(repo: string, want: FetchObjectsRequest["want"]): Promise<FetchObjectsResponse> {
    return this.request("POST", `/jrp/v1/repos/${enc(repo)}/objects/fetch`, { want });
  }

  async uploadObjects(repo: string, objects: SerializedObject[]): Promise<UploadObjectsResponse> {
    return this.request("POST", `/jrp/v1/repos/${enc(repo)}/objects/upload`, { objects });
  }

  async updateRefs(repo: string, updates: UpdateRefsRequest["updates"]): Promise<UpdateRefsResponse> {
    return this.request("POST", `/jrp/v1/repos/${enc(repo)}/refs/update`, { updates });
  }

  async log(repo: string, start: LogRequest["start"], limit?: number): Promise<LogResponse> {
    const body: Body = { start };
    if (limit !== undefined) body.limit = limit;
    return this.request("POST", `/jrp/v1/repos/${enc(repo)}/log`, body);
  }

  async search(
    repo: string,
    query: string,
    opts?: { kind?: SearchRequest["kind"]; limit?: number },
  ): Promise<SearchResponse> {
    const body: Body = { query };
    if (opts?.kind !== undefined) body.kind = opts.kind;
    if (opts?.limit !== undefined) body.limit = opts.limit;
    return this.request("POST", `/jrp/v1/repos/${enc(repo)}/search`, body);
  }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-jrp-version": String(JRP_PROTOCOL_VERSION),
    };
    if (this.token !== undefined) headers["authorization"] = `Bearer ${this.token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) throw await this.errorFrom(res);
    return (await res.json()) as T;
  }

  private async errorFrom(res: Response): Promise<JrpError> {
    let code: JrpErrorCode = "internal";
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: { code?: JrpErrorCode; message?: string } };
      if (parsed?.error?.code !== undefined) code = parsed.error.code;
      if (parsed?.error?.message !== undefined) message = parsed.error.message;
    } catch {
      // non-JSON body: fall back to the status line
    }
    return new JrpError(code, message, res.status);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
