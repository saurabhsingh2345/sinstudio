import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Circle } from "lucide-react";
import type { CursorHealth } from "../../cursor";
import type { RecordOptions } from "../../recorder";
import { isFloatingControlsSupported } from "../../recorderWindow";
import { cn } from "@/lib/utils";

type Status = "ok" | "warn" | "off";

interface ReadinessItem {
  label: string;
  detail: string;
  status: Status;
}

function isChrome(): boolean {
  return /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
}

export function buildRecordingReadiness(
  opts: RecordOptions,
  cursord: CursorHealth | null,
  wantRegion: boolean,
  regionOK: boolean,
  trackCursor: boolean,
): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  items.push({
    label: "Screen capture",
    detail: "Browser can record your display",
    status: "ok",
  });

  if (opts.screen && wantRegion) {
    items.push({
      label: "Region crop",
      detail: regionOK ? "Chrome/Edge — crop before encode" : "Needs Chrome or Edge",
      status: regionOK ? "ok" : "warn",
    });
  }

  if (opts.systemAudio && opts.screen) {
    const chrome = isChrome();
    items.push({
      label: "System audio",
      detail: chrome ? "Chrome — share a tab or window" : "Chrome only; share tab/window when prompted",
      status: chrome ? "ok" : "warn",
    });
  }

  if (opts.screen && trackCursor) {
    if (cursord?.supported) {
      items.push({
        label: "Cursor helper",
        detail: cursord.clicks
          ? "cursord running — auto-zoom & click rings ready"
          : "cursord running — motion only (no click detection on this OS)",
        status: "ok",
      });
      items.push({
        label: "Whole-screen share",
        detail: "Pick your full display (not a window) so pointer maps correctly",
        status: "warn",
      });
    } else {
      items.push({
        label: "Cursor helper",
        detail: "Run tools/cursord for auto-zoom and cursor effects",
        status: "warn",
      });
    }
  }

  if (isFloatingControlsSupported()) {
    items.push({
      label: "Floating controls",
      detail: "Pause/Stop stay visible over your recording",
      status: "ok",
    });
  } else {
    items.push({
      label: "Floating controls",
      detail: "Chrome/Edge only — use the Stop button here otherwise",
      status: "warn",
    });
  }

  if (opts.mic && !opts.camera && !opts.screen) {
    items.push({
      label: "No video source",
      detail: "Enable screen or camera to record video",
      status: "warn",
    });
  }

  return items;
}

const iconFor: Record<Status, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertCircle,
  off: Circle,
};

const toneFor: Record<Status, string> = {
  ok: "text-signal",
  warn: "text-amber-400",
  off: "text-muted-foreground/50",
};

export function RecordingReadiness({
  opts,
  cursord,
  wantRegion,
  regionOK,
  trackCursor,
}: {
  opts: RecordOptions;
  cursord: CursorHealth | null;
  wantRegion: boolean;
  regionOK: boolean;
  trackCursor: boolean;
}) {
  const items = useMemo(
    () => buildRecordingReadiness(opts, cursord, wantRegion, regionOK, trackCursor),
    [opts, cursord, wantRegion, regionOK, trackCursor],
  );

  const ready = items.every((i) => i.status === "ok");
  const warnings = items.filter((i) => i.status === "warn").length;

  return (
    <div className="rounded-lg border hairline bg-panel-2/80 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Readiness</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium",
            ready ? "bg-signal-soft text-signal" : "bg-amber-500/15 text-amber-400",
          )}
        >
          {ready ? "Ready" : warnings === 1 ? "1 note" : `${warnings} notes`}
        </span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => {
          const Icon = iconFor[item.status];
          return (
            <li key={item.label} className="flex gap-2 text-[11px] leading-snug">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", toneFor[item.status])} />
              <span>
                <span className="font-medium text-foreground">{item.label}</span>
                <span className="text-muted-foreground"> — {item.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
