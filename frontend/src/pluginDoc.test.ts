import { describe, expect, it } from "vitest";
import type { FieldSpec } from "./types";
import {
  addItem,
  getField,
  getItemField,
  getItems,
  moveItem,
  removeItem,
  seedDoc,
  setField,
  setItemField,
} from "./pluginDoc";

const SCENES: FieldSpec = {
  path: "scenes[]",
  label: "Scenes",
  type: "array",
  itemOf: "Scene",
  fields: [
    { path: "code", label: "Code", type: "text", default: "" },
    { path: "language", label: "Language", type: "enum", default: "python", options: ["python", "bash"] },
  ],
};
const FPS: FieldSpec = { path: "fps", label: "FPS", type: "number", default: 30 };

describe("plugin document editing", () => {
  it("reads and writes scalars by path", () => {
    let doc: Record<string, unknown> = { fps: 24 };
    expect(getField(doc, FPS)).toBe(24);
    doc = setField(doc, FPS, 60) as Record<string, unknown>;
    expect(doc.fps).toBe(60);
  });

  it("reads and writes fields inside array items", () => {
    let doc: Record<string, unknown> = { scenes: [{ code: "a" }, { code: "b" }] };
    const code = SCENES.fields![0];
    expect(getItemField(doc, SCENES, 1, code)).toBe("b");
    doc = setItemField(doc, SCENES, 1, code, "edited") as Record<string, unknown>;
    expect((doc.scenes as any[])[1].code).toBe("edited");
    expect((doc.scenes as any[])[0].code).toBe("a");
  });

  // The whole reason this layer exists. The previous hand-written mirror
  // re-emitted only the fields it knew, so a property the plugin gained was
  // silently destroyed the first time someone edited a clip.
  it("preserves properties the schema does not describe", () => {
    const doc: Record<string, unknown> = {
      fps: 24,
      futureTopLevelSetting: { deep: [1, 2, 3] },
      scenes: [{ code: "a", unknownSceneProp: "keep me", nested: { x: 1 } }],
    };
    let next = setField(doc, FPS, 60) as Record<string, unknown>;
    next = setItemField(next, SCENES, 0, SCENES.fields![0], "edited") as Record<string, unknown>;

    expect(next.futureTopLevelSetting).toEqual({ deep: [1, 2, 3] });
    const scene = (next.scenes as any[])[0];
    expect(scene.unknownSceneProp).toBe("keep me");
    expect(scene.nested).toEqual({ x: 1 });
    expect(scene.code).toBe("edited");
  });

  it("does not mutate the document in place", () => {
    const doc: Record<string, unknown> = { fps: 24, scenes: [{ code: "a" }] };
    const next = setField(doc, FPS, 60);
    expect(doc.fps).toBe(24);
    expect(next).not.toBe(doc);
  });

  it("adds, removes and reorders array items", () => {
    let doc: Record<string, unknown> = {};
    doc = addItem(doc, SCENES) as Record<string, unknown>;
    doc = addItem(doc, SCENES) as Record<string, unknown>;
    expect(getItems(doc, SCENES)).toHaveLength(2);
    // New items are seeded from the child defaults, not left blank.
    expect((doc.scenes as any[])[0].language).toBe("python");

    doc = setItemField(doc, SCENES, 1, SCENES.fields![0], "second") as Record<string, unknown>;
    doc = moveItem(doc, SCENES, 1, -1) as Record<string, unknown>;
    expect((doc.scenes as any[])[0].code).toBe("second");

    doc = removeItem(doc, SCENES, 0) as Record<string, unknown>;
    expect(getItems(doc, SCENES)).toHaveLength(1);
  });

  it("clamps reordering at the array bounds", () => {
    let doc: Record<string, unknown> = { scenes: [{ code: "a" }, { code: "b" }] };
    doc = moveItem(doc, SCENES, 0, -1) as Record<string, unknown>;
    expect((doc.scenes as any[])[0].code).toBe("a");
    doc = moveItem(doc, SCENES, 1, 1) as Record<string, unknown>;
    expect((doc.scenes as any[])[1].code).toBe("b");
  });

  it("seeds a new document so a fresh generation is renderable", () => {
    const doc = seedDoc({}, [FPS, SCENES]) as Record<string, unknown>;
    expect(doc.fps).toBe(30);
    expect(getItems(doc, SCENES)).toHaveLength(1);
  });

  it("leaves an existing document alone when seeding", () => {
    const doc = seedDoc({ fps: 12, scenes: [{ code: "x" }] }, [FPS, SCENES]) as Record<string, unknown>;
    expect(doc.fps).toBe(12);
    expect(getItems(doc, SCENES)).toHaveLength(1);
  });
});
