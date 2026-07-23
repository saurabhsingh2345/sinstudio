import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

// The inspector's shared controls. They live here rather than in StudioView so
// that panels split into their own files (ZoomPanSection, and whatever follows)
// can use them without importing StudioView back — a cycle that works until it
// doesn't, and then fails at module-evaluation time in a way that reads as
// nothing rendering at all.

export function Section({
  label,
  children,
  defaultOpen = true,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border hairline bg-panel-2/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-2.5 py-2">
        <span className="label-caps">{label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="space-y-2.5 px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function NumInput({
  value,
  onChange,
  step = 1,
  suffix,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const commit = () => {
    let v = parseFloat(t);
    if (isNaN(v)) v = value;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <div className="flex items-center rounded-md border hairline bg-panel-2 px-2">
      <input
        value={t}
        inputMode="decimal"
        step={step}
        onChange={(e) => setT(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="tabular h-7 w-full bg-transparent text-[12px] outline-none"
      />
      {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export function SliderRow({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</label>
      <Slider value={[value]} onValueChange={(x) => onChange(x[0]!)} min={min} max={max} step={step} className="flex-1" />
      <span className="w-9 text-right text-[11px] tabular text-muted-foreground">{fmt ? fmt(value) : Math.round(value)}</span>
    </div>
  );
}

export function ColorSwatch({ color, onChange }: { color: string; onChange?: (c: string) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border hairline bg-panel-2 px-2 py-1">
      <span className="relative h-4 w-4 overflow-hidden rounded border hairline" style={{ background: color }}>
        {onChange && (
          <input
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        )}
      </span>
      <span className="tabular text-[11px] uppercase text-muted-foreground">{color}</span>
    </label>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 rounded px-1 py-1", disabled && "cursor-default opacity-45")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-[11.5px] leading-tight">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
