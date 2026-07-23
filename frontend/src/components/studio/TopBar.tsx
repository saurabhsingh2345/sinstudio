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
import { ASPECT_CANVAS, type AspectKey } from "./bridge";
const ASPECTS = {
  "9:16": { label: "9:16 · Vertical", Icon: RectangleVertical },
  "1:1": { label: "1:1 · Square", Icon: Square },
  "16:9": { label: "16:9 · Landscape", Icon: RectangleHorizontal },
} as const;

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
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const mutate = useStudio((s) => s.mutate);
  const A = ASPECTS[aspect];

  const setAspect = (k: AspectKey) => {
    const { w, h } = ASPECT_CANVAS[k];
    mutate((d) => {
      d.canvas.width = w;
      d.canvas.height = h;
    });
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
            onClick={resolveConflict}
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
              <span className="tabular">{aspect}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="label-caps">Aspect ratio</DropdownMenuLabel>
            {(Object.keys(ASPECTS) as AspectKey[]).map((k) => {
              const Item = ASPECTS[k];
              return (
                <DropdownMenuItem key={k} onClick={() => setAspect(k)} className="flex items-center gap-2">
                  <Item.Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{Item.label}</span>
                  {aspect === k && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand" />}
                </DropdownMenuItem>
              );
            })}
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
