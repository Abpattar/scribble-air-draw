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
export function idIn(ids) {
  const out = [];
  for (const id of ids) {
    for (const form of idForms(id)) {
      if (!out.some((x) => (x instanceof ObjectId ? x.toHexString() : String(x)) === (form instanceof ObjectId ? form.toHexString() : String(form)))) {
        out.push(form);
      }
    }
  }
  return out;
}

// `{ _id: <id in any stored form> }`
export function idFilter(id) {
  return { _id: { $in: idIn([id]) } };
}
