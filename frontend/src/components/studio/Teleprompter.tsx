import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ToggleRow } from "./inspector-bits";

const STORAGE_KEY = "studio-teleprompter-script";

export function Teleprompter({
  active,
  elapsed,
}: {
  active: boolean;
  elapsed: number;
}) {
  const [open, setOpen] = useState(false);
  const [script, setScript] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [autoScroll, setAutoScroll] = useState(true);
  const [speed, setSpeed] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, script);
  }, [script]);

  useEffect(() => {
    if (!active || !autoScroll || !open || !scrollRef.current) return;
    const el = scrollRef.current;
    const pxPerSec = 28 * speed;
    el.scrollTop = elapsed * pxPerSec;
  }, [active, elapsed, autoScroll, open, speed]);

  if (!open) {
    return (
      <button
        type="button"
        className="w-full rounded-md border hairline bg-panel-2/60 px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-panel-3 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        + Teleprompter script
      </button>
    );
  }

  return (
    <div className="rounded-lg border hairline bg-panel-2/60 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">Teleprompter</span>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="Paste your script here…"
        className="mb-2 h-20 w-full resize-y rounded border hairline bg-panel px-2 py-1.5 text-[11px] leading-relaxed outline-none focus:border-brand/50"
      />
      <div
        ref={scrollRef}
        className={cn(
          "scrollbar-thin max-h-32 overflow-y-auto rounded border hairline bg-black/40 px-3 py-4 text-center text-[15px] font-medium leading-relaxed text-white",
          !script.trim() && "text-white/40",
        )}
      >
        {script.trim() || "Your script appears here while recording"}
      </div>
      <div className="mt-2 space-y-1">
        <ToggleRow label="Auto-scroll" hint="Follows the recording clock." checked={autoScroll} onChange={setAutoScroll} />
        <label className="flex items-center justify-between text-[10px] text-muted-foreground">
          Scroll speed
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(+e.target.value)}
            className="ml-2 w-24 accent-[var(--brand)]"
          />
        </label>
      </div>
    </div>
  );
}
