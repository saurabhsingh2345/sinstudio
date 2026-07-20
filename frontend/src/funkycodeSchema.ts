// FunkyCode plugin schema — the editable shape of a FunkyCode generation, used
// by the "live plugin" editor in the clip inspector to re-render a clip.
//
// This mirrors the sibling project ../funkycode (lib/templates.ts, the scene
// fields read by scripts/render-funky.mts). Keep in sync if FunkyCode's schema
// changes. FunkyCode's input is tight and fully enumerable:
//   - top level: { scenes: [...] }  (--fps / --shorts are CLI flags, not JSON)
//   - per scene: code (required), language, template, output, throwCount
// There is no separate "theme" — the template IS the theme.

export const FUNKY_TEMPLATES = [
  { id: "panel", name: "Editor Window" },
  { id: "spotlight", name: "Spotlight" },
  { id: "paper", name: "Paper" },
  { id: "liverun", name: "Live Run" },
  { id: "liverundark", name: "Live Run Dark" },
] as const;

export type FunkyTemplateId = (typeof FUNKY_TEMPLATES)[number]["id"];

// Languages the FunkyCode tokenizer preloads (shiki). The UI only "blesses"
// python/js/ts, but any preloaded language highlights; unknown ones fall back to
// plain text. Ordered with the blessed three first.
export const FUNKY_LANGS = [
  "python",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "bash",
  "json",
  "html",
  "css",
] as const;

// throwCount only matters for the click-to-run templates.
export const THROW_TEMPLATES: FunkyTemplateId[] = ["liverun", "liverundark"];

export interface FunkyScene {
  code: string;
  language: string;
  template: FunkyTemplateId;
  output: string;
  throwCount: number;
}

export interface FunkyModel {
  fps: number;
  shorts: boolean;
  scenes: FunkyScene[];
}

export const DEFAULT_FUNKY_SCENE = (): FunkyScene => ({
  code: "",
  language: "python",
  template: "panel",
  output: "",
  throwCount: 3,
});

function coerceTemplate(v: unknown): FunkyTemplateId {
  return FUNKY_TEMPLATES.some((t) => t.id === v) ? (v as FunkyTemplateId) : "panel";
}

// parseFunky builds an editable model from a stored genInput (scenes JSON) plus
// the genParams flag map. Tolerant of a bare scenes array or missing fields.
export function parseFunky(genInput?: string, genParams?: Record<string, string>): FunkyModel {
  let raw: any = {};
  try {
    raw = genInput ? JSON.parse(genInput) : {};
  } catch {
    raw = {};
  }
  const rawScenes: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.scenes) ? raw.scenes : [];
  const scenes: FunkyScene[] = rawScenes.map((s) => ({
    code: typeof s?.code === "string" ? s.code : "",
    language: typeof s?.language === "string" ? s.language : "python",
    template: coerceTemplate(s?.template),
    output: typeof s?.output === "string" ? s.output : "",
    throwCount: Number.isFinite(s?.throwCount) ? Number(s.throwCount) : 3,
  }));
  if (!scenes.length) scenes.push(DEFAULT_FUNKY_SCENE());
  const fpsRaw = genParams?.["--fps"];
  const fps = fpsRaw && Number(fpsRaw) > 0 ? Number(fpsRaw) : 30;
  const shorts = !!genParams?.["--shorts"];
  return { fps, shorts, scenes };
}

// serializeFunky turns the edited model back into the { input, params } pair the
// re-render endpoint expects. fps/shorts are CLI flags (--shorts is a bool flag:
// a truthy value string enables it, empty disables per the generator's argv rule).
export function serializeFunky(m: FunkyModel): { input: string; params: Record<string, string> } {
  const scenes = m.scenes
    .filter((s) => s.code.trim().length > 0)
    .map((s) => {
      const scene: Record<string, unknown> = {
        code: s.code,
        language: s.language,
        template: s.template,
      };
      if (s.output.trim()) scene.output = s.output;
      if (THROW_TEMPLATES.includes(s.template)) scene.throwCount = s.throwCount;
      return scene;
    });
  const params: Record<string, string> = { "--fps": String(m.fps > 0 ? m.fps : 30) };
  if (m.shorts) params["--shorts"] = "1";
  return { input: JSON.stringify({ scenes }), params };
}
