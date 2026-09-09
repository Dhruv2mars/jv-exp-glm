// Javelin domain model v2. See docs/javelin-model.md.
// These shapes are the contract between the VCS core, JRP, and every consumer.

import { type ObjectId } from "./index";

export type { ObjectId };

export type ObjectKind = "blob" | "tree" | "state" | "provenance" | "evidence" | "contribution";

export type FileMode = "file" | "exec" | "symlink";

export interface TreeEntry {
  name: string;
  mode: FileMode;
  kind: "blob" | "tree";
  id: ObjectId;
}

export interface Tree {
  kind: "tree";
  entries: TreeEntry[];
}

export interface Person {
  name: string;
  email: string;
  time: string;
}

/** Immutable snapshot of the whole file world. Never rewritten. */
export interface State {
  kind: "state";
  tree: ObjectId;
  parents: ObjectId[];
  author: Person;
  message: string;
}

export type AgentAdapter = "generic" | "codex" | "claude-code";

/** Append-only record explaining how states came to be. References states; never mutates them. */
export interface ProvenanceRecord {
  kind: "provenance";
  states: ObjectId[];
  agent: { name: string; adapter: AgentAdapter; session?: string };
  model?: string;
  prompt?: string;
  /** Id of the parent provenance record, for run chains. */
  parentRun?: string;
  startedAt: string;
  finishedAt?: string;
  exit?: "success" | "failure" | "cancelled";
  summary?: string;
}

/** Append-only verification artifact bound to the exact state, rules, and environment. */
export interface EvidenceRecord {
  kind: "evidence";
  state: ObjectId;
  /** Identifier (e.g. sha256 or policy name@revision) of the rules the evidence was produced under. */
  rules: string;
  environment?: string;
  checks: { check: string; status: "pass" | "fail"; detail?: string }[];
  at: string;
}

/** Immutable proposal to publish a layer head into World. */
export interface Contribution {
  kind: "contribution";
  layer: string;
  /** Layer head being proposed. */
  state: ObjectId;
  /** World state the layer forked from. */
  base: ObjectId;
  title: string;
  author: Person;
  createdAt: string;
}

export type ContributionStatus = "open" | "published" | "discarded";

export interface ContributionEvent {
  status: ContributionStatus;
  at: string;
  by?: string;
  note?: string;
  /** World state after publishing. */
  worldState?: ObjectId;
}

/** A mutable layer pointer. Stored in metadata, updated by CAS — never content-addressed. */
export interface LayerRef {
  name: string;
  base: ObjectId;
  head: ObjectId | null;
  updatedAt: string;
}

/** Read-only view of all mutable heads. */
export interface HeadsView {
  world: ObjectId | null;
  layers: LayerRef[];
}
