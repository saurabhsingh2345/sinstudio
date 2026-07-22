// Reading and writing a generator's input document through the field schema its
// manifest publishes (GeneratorStatus.fields).
//
// The governing rule: a field schema is a *view* over the document, never a
// model of it. Every write targets one path and copies the rest of the document
// through untouched, so a property the generator has that Studio has never heard
// of survives being edited here. The previous approach — a hand-written
// TypeScript mirror of the plugin's model (funkycodeSchema.ts) — re-emitted only
// the fields it knew, which silently destroyed anything else on the first
// re-render. With dozens of plugins that failure mode is unmanageable, so the
// generic path is built to make it impossible rather than unlikely.

import type { FieldSpec } from "./types";

export type Doc = Record<string, unknown> | unknown[];

/** parseDoc reads a stored genInput, tolerating absent or malformed JSON. */
export function parseDoc(genInput: string | undefined, docRoot: string | undefined): Doc {
  const empty: Doc = docRoot === "array" ? [] : {};
  if (!genInput?.trim()) return empty;
  try {
    const v = JSON.parse(genInput);
    return v && typeof v === "object" ? (v as Doc) : empty;
  } catch {
    return empty;
  }
}

/** serializeDoc renders the document back to the string the CLI consumes. */
export function serializeDoc(doc: Doc): string {
  return JSON.stringify(doc, null, 2);
}

// A path is a dot chain that may contain one array hop marked with "[]",
// e.g. "fps", "scenes[]", "scenes[].code". Only one hop is supported: it covers
// every real generator shape so far, and deeper nesting is the signal that a
// generator wants a bundled editor rather than a generated form.
function splitPath(path: string): { head: string[]; tail: string[] | null } {
  const i = path.indexOf("[]");
  if (i === -1) return { head: path.split(".").filter(Boolean), tail: null };
  const head = path.slice(0, i).split(".").filter(Boolean);
  const tail = path
    .slice(i + 2)
    .split(".")
    .filter(Boolean);
  return { head, tail };
}

function readPath(obj: unknown, keys: string[]): unknown {
  let cur: any = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * writePath returns a copy of obj with keys set to value. Containers along the
 * path are cloned; every sibling key is carried over by reference, which is what
 * preserves properties the schema does not describe.
 */
function writePath(obj: unknown, keys: string[], value: unknown): any {
  if (!keys.length) return value;
  const [k, ...rest] = keys;
  const base: any = obj && typeof obj === "object" ? obj : {};
  if (Array.isArray(base)) {
    const idx = Number(k);
    const next = base.slice();
    next[idx] = writePath(base[idx], rest, value);
    return next;
  }
  return { ...base, [k]: writePath(base[k], rest, value) };
}

/**
 * Top-level accessors. A child field inside an array carries a path relative to
 * its item ("code"), not an absolute one, so resolving it needs the parent array
 * spec too — see getItemField/setItemField. Keeping the two cases as separate
 * functions rather than an optional index makes it impossible to silently read
 * the wrong path.
 */
export function getField(doc: Doc, spec: FieldSpec): unknown {
  const { head } = splitPath(spec.path);
  return readPath(doc, head);
}

export function setField(doc: Doc, spec: FieldSpec, value: unknown): Doc {
  const { head } = splitPath(spec.path);
  return writePath(doc, head, value);
}

/** getItemField reads a child field inside one element of an array field. */
export function getItemField(doc: Doc, arraySpec: FieldSpec, index: number, child: FieldSpec): unknown {
  const items = getItems(doc, arraySpec);
  return readPath(items[index], child.path.split(".").filter(Boolean));
}

/** setItemField writes a child field inside one element of an array field. */
export function setItemField(
  doc: Doc,
  arraySpec: FieldSpec,
  index: number,
  child: FieldSpec,
  value: unknown
): Doc {
  const { head } = splitPath(arraySpec.path);
  const items = getItems(doc, arraySpec);
  if (index < 0 || index >= items.length) return doc;
  const nextItem = writePath(items[index], child.path.split(".").filter(Boolean), value);
  const nextItems = items.slice();
  nextItems[index] = nextItem;
  return writePath(doc, head, nextItems);
}

/** getItems returns the array a "…[]" field addresses (empty when absent). */
export function getItems(doc: Doc, spec: FieldSpec): unknown[] {
  const { head } = splitPath(spec.path);
  const arr = readPath(doc, head);
  return Array.isArray(arr) ? arr : [];
}

function setItems(doc: Doc, spec: FieldSpec, items: unknown[]): Doc {
  const { head } = splitPath(spec.path);
  return writePath(doc, head, items);
}

/** newItem builds an array element seeded from the child fields' defaults. */
export function newItem(spec: FieldSpec): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const f of spec.fields ?? []) {
    if (f.default !== undefined) item[f.path] = f.default;
  }
  return item;
}

export function addItem(doc: Doc, spec: FieldSpec): Doc {
  return setItems(doc, spec, [...getItems(doc, spec), newItem(spec)]);
}

export function removeItem(doc: Doc, spec: FieldSpec, index: number): Doc {
  return setItems(
    doc,
    spec,
    getItems(doc, spec).filter((_, i) => i !== index)
  );
}

/** moveItem shifts an element by delta, clamped to the array bounds. */
export function moveItem(doc: Doc, spec: FieldSpec, index: number, delta: number): Doc {
  const items = getItems(doc, spec).slice();
  const to = index + delta;
  if (to < 0 || to >= items.length) return doc;
  const [it] = items.splice(index, 1);
  items.splice(to, 0, it);
  return setItems(doc, spec, items);
}

/** seedDoc fills in defaults for any described field the document lacks, so a
 *  brand-new generation starts from something renderable rather than blank. */
export function seedDoc(doc: Doc, fields: FieldSpec[]): Doc {
  let out = doc;
  for (const f of fields) {
    if (f.type === "array") {
      if (!getItems(out, f).length) out = addItem(out, f);
      continue;
    }
    if (getField(out, f) === undefined && f.default !== undefined) {
      out = setField(out, f, f.default);
    }
  }
  return out;
}
