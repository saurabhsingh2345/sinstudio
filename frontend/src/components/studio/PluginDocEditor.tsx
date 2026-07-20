// PluginDocEditor renders a generator's input document from the field schema in
// its manifest — one component for every plugin, present and future.
//
// A generator that publishes `fields` gets this editor with no Studio code; one
// that doesn't falls back to editing the raw document, so a new plugin is always
// usable on the day it is added rather than blocked on UI work. This is the
// mechanism that keeps the plugin count from turning into a UI backlog.

import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import type { FieldSpec } from "../../types";
import {
  addItem,
  getField,
  getItemField,
  getItems,
  moveItem,
  removeItem,
  setField,
  setItemField,
  type Doc,
} from "../../pluginDoc";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/utils";

const inputCls =
  "w-full rounded-md border hairline bg-panel-2 px-2 py-1 text-[11px] outline-none focus:border-brand";

function Labelled({ spec, children }: { spec: FieldSpec; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{spec.label}</span>
      {children}
      {spec.hint && <span className="block text-[10px] text-muted-foreground">{spec.hint}</span>}
    </label>
  );
}

/** ScalarField renders one non-array field, reading and writing through the schema. */
function ScalarField({
  spec,
  doc,
  item,
  onChange,
}: {
  spec: FieldSpec;
  doc: Doc;
  // Set when this field lives inside an array element: its path is then relative
  // to that element rather than to the document root.
  item?: { arraySpec: FieldSpec; index: number };
  onChange: (next: Doc) => void;
}) {
  const value = item ? getItemField(doc, item.arraySpec, item.index, spec) : getField(doc, spec);
  const set = (v: unknown) =>
    onChange(item ? setItemField(doc, item.arraySpec, item.index, spec, v) : setField(doc, spec, v));

  switch (spec.type) {
    case "bool":
      return (
        <label className="flex items-center gap-2 text-[11px]">
          <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
          <span>{spec.label}</span>
        </label>
      );
    case "enum":
      return (
        <Labelled spec={spec}>
          <select className={inputCls} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
            {(spec.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Labelled>
      );
    case "number":
      return (
        <Labelled spec={spec}>
          <input
            className={inputCls}
            type="number"
            value={value === undefined || value === null ? "" : String(value)}
            // Keep the field empty rather than coercing to 0 while it is being
            // cleared, otherwise the cursor fights the user mid-edit.
            onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Labelled>
      );
    case "text":
      return (
        <Labelled spec={spec}>
          <Textarea
            className={cn("h-24 resize-y text-[11px]", spec.mono && "font-mono")}
            value={String(value ?? "")}
            onChange={(e) => set(e.target.value)}
          />
        </Labelled>
      );
    default:
      return (
        <Labelled spec={spec}>
          <input className={inputCls} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
        </Labelled>
      );
  }
}

/** ArrayField renders a repeatable group (e.g. FunkyCode scenes). */
function ArrayField({
  spec,
  doc,
  onChange,
}: {
  spec: FieldSpec;
  doc: Doc;
  onChange: (next: Doc) => void;
}) {
  const items = getItems(doc, spec);
  const noun = spec.itemOf ?? "Item";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{spec.label}</span>
        <button
          onClick={() => onChange(addItem(doc, spec))}
          className="flex items-center gap-1 rounded border hairline px-1.5 py-0.5 text-[10px] hover:bg-panel-2"
        >
          <Plus className="h-3 w-3" /> Add {noun.toLowerCase()}
        </button>
      </div>

      {items.map((_, i) => (
        <div key={i} className="space-y-2 rounded-md border hairline bg-panel/50 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground">
              {noun} {i + 1}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                title="Move up"
                disabled={i === 0}
                onClick={() => onChange(moveItem(doc, spec, i, -1))}
                className="rounded p-0.5 text-muted-foreground hover:bg-panel-2 disabled:opacity-30"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                title="Move down"
                disabled={i === items.length - 1}
                onClick={() => onChange(moveItem(doc, spec, i, 1))}
                className="rounded p-0.5 text-muted-foreground hover:bg-panel-2 disabled:opacity-30"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                title={`Remove ${noun.toLowerCase()}`}
                onClick={() => onChange(removeItem(doc, spec, i))}
                className="rounded p-0.5 text-muted-foreground hover:bg-panel-2 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
          {(spec.fields ?? []).map((f) => (
            <ScalarField
              key={f.path}
              spec={f}
              doc={doc}
              item={{ arraySpec: spec, index: i }}
              onChange={onChange}
            />
          ))}
        </div>
      ))}

      {!items.length && (
        <p className="text-[11px] text-muted-foreground">
          No {noun.toLowerCase()}s yet — add one to get started.
        </p>
      )}
    </div>
  );
}

export function PluginDocEditor({
  fields,
  doc,
  onChange,
}: {
  fields: FieldSpec[];
  doc: Doc;
  onChange: (next: Doc) => void;
}) {
  return (
    <div className="space-y-3">
      {fields.map((f) =>
        f.type === "array" ? (
          <ArrayField key={f.path} spec={f} doc={doc} onChange={onChange} />
        ) : (
          <ScalarField key={f.path} spec={f} doc={doc} onChange={onChange} />
        )
      )}
    </div>
  );
}
