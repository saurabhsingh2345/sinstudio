import { useState } from "react";
import {
  ChevronLeft,
  ChevronDown,
  Undo2,
  Redo2,
  Sparkles,
  Layers,
  Moon,
  Sun,
  RectangleHorizontal,
  RectangleVertical,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import type { EditDoc } from "../../types";
import { ASPECT_CANVAS, aspectLabel, exactAspect, type AspectKey } from "./bridge";
import { applyCanvas } from "../../setCanvas";
import { toast } from "../../toast";
const ASPECTS: Record<AspectKey, { label: string; Icon: typeof Square }> = {
  "9:16": { label: "9:16 · Vertical", Icon: RectangleVertical },
  "4:5": { label: "4:5 · Portrait", Icon: RectangleVertical },
  "1:1": { label: "1:1 · Square", Icon: Square },
  "4:3": { label: "4:3 · Classic", Icon: RectangleHorizontal },
  "3:2": { label: "3:2 · Laptop", Icon: RectangleHorizontal },
  "16:10": { label: "16:10 · Widescreen", Icon: RectangleHorizontal },
  "16:9": { label: "16:9 · Landscape", Icon: RectangleHorizontal },
  "21:9": { label: "21:9 · Ultrawide", Icon: RectangleHorizontal },
};

export function IconBtn({ children, title, active, onClick }: { children: React.ReactNode; title?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground",
        active && "bg-panel-2 text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function TopBar({
  doc,
  aspect,
  theme,
  onToggleTheme,
  onHome,
  onExport,
  onRenders,
}: {
  doc: EditDoc;
  aspect: AspectKey;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onHome?: () => void;
  onExport: () => void;
  onRenders: () => void;
}) {
  const saving = useStudio((s) => s.saving);
  const dirty = useStudio((s) => s.dirty);
  const conflict = useStudio((s) => s.conflict);
  const resolveConflict = useStudio((s) => s.resolveConflict);
  const keepMine = useStudio((s) => s.keepMine);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const mutate = useStudio((s) => s.mutate);
  const A = ASPECTS[aspect];
  // The shape the canvas actually is, so the tick marks truth rather than nearest.
  const exact = exactAspect(doc.canvas);

  // Switching aspect reframes the content, it does not merely resize the frame.
  // Setting the canvas alone drops a 16:9 recording into a 1080x1920 letterbox
  // with two thirds of the picture missing, which is what this used to do.
  //
  // The pointer sidecars are fetched first because the reframe wants to
  // recompute each recording's camera for the new shape, and that needs the
  // track. A clip whose sidecar cannot be fetched is still filled to the frame —
  // a worse result rather than a wrong one.
  const setAspect = async (k: AspectKey) => {
    const { w, h } = ASPECT_CANVAS[k];
    const summary = await applyCanvas(doc, { width: w, height: h }, mutate);
    if (summary) toast.info(`${k} — ${summary}`);
  };

  /*
   * A canvas of any shape, typed.
   *
   * The eight named shapes cover the common cases but not "the size of the thing
   * I recorded", and for a picture that is already framed correctly no preset is
   * the right answer — which is what left people with black bars and only Fill
   * (a crop) to remove them. Crop & Fit's "Match canvas to this clip" is the
   * one-click version of this; these are the boxes for everything else.
   */
  const [customW, setCustomW] = useState(String(doc.canvas.width));
  const [customH, setCustomH] = useState(String(doc.canvas.height));
  const applyCustom = async () => {
    // Even, like every other dimension in the pipeline: 4:2:0 cannot store odd.
    const clampEven = (n: number) => {
      const v = Math.max(16, Math.min(3840, Math.trunc(n)));
      return v % 2 === 0 ? v : v - 1;
    };
    const w = clampEven(Number(customW));
    const h = clampEven(Number(customH));
    if (!(w >= 16) || !(h >= 16)) {
      toast.error("Give a width and height between 16 and 3840.");
      return;
    }
    const summary = await applyCanvas(doc, { width: w, height: h }, mutate);
    toast.success(`Canvas is now ${w}×${h}${summary ? ` — ${summary}` : ""}`);
  };

  const status = conflict ? "Conflict" : saving ? "Saving…" : dirty ? "Unsaved" : "Saved";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b hairline bg-panel/80 px-3 backdrop-blur">
      <button
        onClick={onHome}
        title="Back to projects"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-panel-2 hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand to-signal">
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="text-sm font-medium">{doc.name}</div>
        <div className="ml-1 flex items-center gap-1.5 rounded-full border hairline bg-panel-2 px-2 py-0.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              conflict ? "bg-red-500" : saving ? "bg-amber-400" : dirty ? "bg-muted-foreground" : "bg-signal"
            )}
          />
          {status} · v{doc.version}
        </div>
      </div>

      {conflict && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200">
          <span>Someone else saved this project. Your changes are not being saved.</span>
          <button
            onClick={keepMine}
            title="Save your version over theirs"
            className="rounded border border-red-400/50 px-1.5 py-0.5 font-medium hover:bg-red-500/20"
          >
            Keep mine
          </button>
          <button
            onClick={resolveConflict}
            title="Discard your unsaved changes and load their version"
            className="rounded border border-red-400/50 px-1.5 py-0.5 font-medium hover:bg-red-500/20"
          >
            Reload theirs
          </button>
        </div>
      )}

      <div className="mx-2 h-5 w-px bg-hairline" />

      <div className="flex items-center gap-1">
        <IconBtn title="Undo (⌘Z)" onClick={undo}><Undo2 className="h-4 w-4" /></IconBtn>
        <IconBtn title="Redo (⌘⇧Z)" onClick={redo}><Redo2 className="h-4 w-4" /></IconBtn>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 items-center gap-2 rounded-md border hairline bg-panel-2 px-2.5 text-sm hover:bg-panel-3">
              <A.Icon className="h-4 w-4 text-muted-foreground" />
              <span className="tabular">{aspectLabel(doc.canvas)}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="label-caps">Aspect ratio</DropdownMenuLabel>
            {(Object.keys(ASPECTS) as AspectKey[]).map((k) => {
              const Item = ASPECTS[k];
              const dims = ASPECT_CANVAS[k];
              return (
                <DropdownMenuItem key={k} onClick={() => void setAspect(k)} className="flex items-center gap-2">
                  <Item.Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{Item.label}</span>
                  <span className="tabular ml-auto text-[10px] text-muted-foreground">
                    {dims.w}×{dims.h}
                  </span>
                  {exact === k && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-brand" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuLabel className="label-caps pt-2">Custom size</DropdownMenuLabel>
            <div
              className="flex items-center gap-1.5 px-2 pb-2"
              // The menu closes on any click inside it by default, which would
              // shut it on the first keystroke.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <input
                value={customW}
                onChange={(e) => setCustomW(e.target.value)}
                inputMode="numeric"
                aria-label="Canvas width"
                className="tabular h-7 w-16 rounded-md border hairline bg-panel-2 px-1.5 text-center text-[11px]"
              />
              <span className="text-[11px] text-muted-foreground">×</span>
              <input
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
                inputMode="numeric"
                aria-label="Canvas height"
                className="tabular h-7 w-16 rounded-md border hairline bg-panel-2 px-1.5 text-center text-[11px]"
              />
              <Button size="sm" className="h-7 flex-1 text-[11px]" onClick={() => void applyCustom()}>
                Apply
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="tabular rounded-md border hairline bg-panel-2 px-2 py-1 text-[11px] text-muted-foreground">
          {doc.canvas.width}×{doc.canvas.height} · {doc.canvas.fps}fps
        </span>

        <IconBtn title={`Switch to ${theme === "light" ? "dark" : "light"} theme`} onClick={onToggleTheme}>
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </IconBtn>

        <Button variant="ghost" size="sm" className="h-8" onClick={onRenders}>
          <Layers className="mr-1.5 h-4 w-4" /> Renders
        </Button>
        <Button size="sm" className="h-8 bg-brand text-brand-foreground hover:bg-brand/90" onClick={onExport}>
          Export
        </Button>
      </div>
    </header>
  );
}
