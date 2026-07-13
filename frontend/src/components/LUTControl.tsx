import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";

// LUTControl manages a clip's color LUT: pick from the project's uploaded .cube
// files, upload a new one, or clear it. The grade is applied by the renderer, so
// the true result shows via "Render frame" / export (the canvas preview can't
// apply a 3D LUT).
export function LUTControl({
  projId,
  value,
  onChange,
}: {
  projId: string;
  value?: string;
  onChange: (name: string) => void;
}) {
  const [luts, setLuts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    api
      .listLUTs(projId)
      .then((d) => setLuts(d.luts))
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, [projId]);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const { name } = await api.uploadLUT(projId, f);
      await refresh();
      onChange(name); // apply the freshly uploaded LUT
    } catch (e) {
      toast.error("LUT upload failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="kf-head">
        Color LUT
        <div className="spacer" />
        <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "uploading…" : "upload .cube"}
        </button>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">None</option>
            {luts.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="small" style={{ marginTop: 2 }}>
        Grade is applied on export — use “Render frame” to preview it exactly.
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".cube"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
