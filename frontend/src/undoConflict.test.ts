import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake server holding one project behind an optimistic-concurrency revision,
// exactly like store.SaveProject: a save whose base revision has moved on is
// rejected, and the editor is told someone else got there first.
const server: { revision: number; doc: any } = { revision: 1, doc: null };

vi.mock("./api", () => {
  class ConflictError extends Error {
    current: any;
    constructor(current: any) {
      super("conflict");
      this.name = "ConflictError";
      this.current = current;
    }
  }
  return {
    ConflictError,
    api: {
      saveProject: async (doc: any) => {
        if (doc.version !== server.revision) {
          // What the server really answers a 409 with: its own stored document,
          // not an echo of what the client just tried to write.
          throw new ConflictError({ ...structuredClone(server.doc), version: server.revision });
        }
        server.revision += 1;
        server.doc = { ...structuredClone(doc), version: server.revision };
        return { ok: true, version: server.revision };
      },
    },
  };
});

import { useStudio } from "./state";

function docWith(names: string[]) {
  return {
    id: "proj_test",
    name: "Test",
    version: 1,
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [{ id: "t_video", kind: "video", name: "Video 1", clips: names.map(clip) }],
    assets: [],
    markers: [],
  } as any;
}

function clip(id: string, i = 0): any {
  return {
    id,
    assetId: "asset_1",
    start: i * 10,
    in: 0,
    out: 10,
    srcIn: 0,
    srcOut: 10,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
  };
}

// Simulate a genuine second writer getting there first.
function otherWriterSaved() {
  server.revision = 7;
  server.doc = { ...docWith(["clip_a", "clip_theirs"]), version: 7 };
}

beforeEach(() => {
  server.revision = 1;
  server.doc = { ...docWith(["clip_a"]), version: 1 };
  useStudio.setState({
    doc: docWith(["clip_a"]),
    past: [],
    future: [],
    conflict: null,
    dirty: false,
    saving: false,
    selClip: null,
    selClips: [],
    selCue: null,
  });
});

const clipIds = () => (useStudio.getState().doc!.tracks[0].clips || []).map((c) => c.id);

describe("undo across a save boundary", () => {
  it("does not report a phantom conflict", async () => {
    const s = () => useStudio.getState();

    // Edit, then let the autosave land: the server revision moves to 2 and the
    // live doc adopts it, while the history snapshot still holds revision 1.
    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();
    expect(s().doc!.version).toBe(2);
    expect(s().past).toHaveLength(1);
    expect(s().past[0].version).toBe(1);

    // The undo that used to blow up: it restores a snapshot stamped revision 1
    // and autosaves it against a server already on revision 2.
    s().undo();
    expect(clipIds()).toEqual(["clip_a"]);
    await s().save();

    expect(s().conflict).toBeNull();
    expect(clipIds()).toEqual(["clip_a"]);
  });

  it("keeps saving after the undo, so later work is not stranded", async () => {
    const s = () => useStudio.getState();

    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();
    s().undo();
    await s().save();

    // Work done after an undo must still reach the server. Once a conflict is
    // latched, save() returns early forever and everything after it is lost on
    // the next reload — which is how the undo bug destroyed real edits.
    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_c", 2)));
    const before = server.revision;
    await s().save();

    expect(s().conflict).toBeNull();
    expect(server.revision).toBe(before + 1);
    expect(s().dirty).toBe(false);
  });

  it("still reports a real conflict when another writer actually saved", async () => {
    const s = () => useStudio.getState();

    // Someone else saves the project behind the editor's back.
    otherWriterSaved();
    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();

    expect(s().conflict).not.toBeNull();
    expect(s().conflict!.current.version).toBe(7);
    // The local doc is untouched, so nothing is lost before the user chooses.
    expect(clipIds()).toEqual(["clip_a", "clip_b"]);
  });

  it("keepMine rescues local work instead of discarding it", async () => {
    const s = () => useStudio.getState();

    otherWriterSaved();
    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();
    expect(s().conflict).not.toBeNull();

    // The exit that keeps the work: rebase onto their revision and save over it.
    s().keepMine();
    expect(s().conflict).toBeNull();
    expect(s().doc!.version).toBe(7);
    await s().save();

    expect(s().conflict).toBeNull();
    expect(clipIds()).toEqual(["clip_a", "clip_b"]);
    expect(server.revision).toBe(8);
    expect(s().dirty).toBe(false);
  });

  it("resolveConflict still offers the discard-and-reload path", async () => {
    const s = () => useStudio.getState();

    otherWriterSaved();
    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();
    s().resolveConflict();

    // Their document, and the local clip_b deliberately gone.
    expect(s().conflict).toBeNull();
    expect(clipIds()).toEqual(["clip_a", "clip_theirs"]);
    expect(s().dirty).toBe(false);
  });

  it("redo also saves against the current revision", async () => {
    const s = () => useStudio.getState();

    s().mutate((d) => d.tracks[0].clips!.push(clip("clip_b", 1)));
    await s().save();
    s().undo();
    await s().save();
    s().redo();
    expect(clipIds()).toEqual(["clip_a", "clip_b"]);
    await s().save();

    expect(s().conflict).toBeNull();
  });
});
