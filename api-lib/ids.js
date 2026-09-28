import { ObjectId } from 'mongodb';

// Group ids travel through the client as plain strings but are stored as
// ObjectId (and historically as strings too). These two helpers let a single
// query match either form, and turn an arbitrary id into something safe to hand
// to the driver without throwing on a malformed value.

export function safeObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return String(id);
  }
}

// Every id form a stored reference could use, for `$in` filters.
export function idForms(id) {
  const out = [];
  const s = String(id ?? '');
  if (s) out.push(s);
  const oi = safeObjectId(s);
  if (oi instanceof ObjectId && !out.some((x) => x instanceof ObjectId && x.toHexString() === oi.toHexString())) {
    out.push(oi);
  }
  return out;
}

// Same, flattened over many ids.
//
// Duplicates are compared by *kind*, not by printed value: a stored ObjectId and
// the same id as a string are two different query terms, and Mongo only matches
// an ObjectId `_id` against an ObjectId. Comparing them as text silently threw
// the ObjectId away, so every filter built here could only ever find documents
// whose `_id` was a string — which is none of the groups, battles, friendships or
// invitations, because those are all inserted without an `_id` and come back from
// Mongo as ObjectIds.
const idKey = (value) => (value instanceof ObjectId ? `oid:${value.toHexString()}` : `str:${String(value)}`);

export function idIn(ids) {
  const out = [];
  for (const id of ids) {
    for (const form of idForms(id)) {
      if (!out.some((x) => idKey(x) === idKey(form))) out.push(form);
    }
  }
  return out;
}

// `{ _id: <id in any stored form> }`
export function idFilter(id) {
  return { _id: { $in: idIn([id]) } };
}
