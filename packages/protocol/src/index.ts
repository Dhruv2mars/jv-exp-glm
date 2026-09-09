// JRP v2: shared object-id primitives and re-exports.
// The normative domain model lives in ./model; the wire contract in ./jrp (docs/jrp-spec.md).

/** A sha256 hex object id. */
export type ObjectId = string & { readonly __objectId: unique symbol };

export function objectId(hex: string): ObjectId {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid object id: ${hex}`);
  return hex as ObjectId;
}

export function isObjectId(s: string): s is ObjectId {
  return /^[0-9a-f]{64}$/.test(s);
}

export * from "./model";
export * from "./jrp";
