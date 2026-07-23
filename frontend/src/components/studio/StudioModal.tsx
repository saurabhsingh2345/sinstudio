import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function StudioModal({
  title,
  children,
  footer,
  headerActions,
  onClose,
  width = "max-w-md",
  className,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  width?: string;
  className?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={cn(
          "flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border hairline bg-panel shadow-2xl",
          width,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-modal-title"
      >
        <header className="flex shrink-0 items-center gap-2 border-b hairline px-4 py-3">
          <h2 id="studio-modal-title" className="text-sm font-semibold tracking-tight">
            {title}
          </h2>
          <div className="flex-1" />
          {headerActions}
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? <footer className="shrink-0 border-t hairline px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ModalField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function ModalProgress({ label, progress }: { label: string; progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="space-y-1.5 rounded-lg bg-panel-2 p-3">
      <div className="flex justify-between text-[12px]">
        {label ? <span className="text-muted-foreground">{label}</span> : <span />}
        <span className="tabular-nums text-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-3">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}
