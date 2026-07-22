-- Studio project storage.
--
-- The split between these two tables is the concurrency boundary, and it is the
-- point of the design: the editor owns the timeline, background jobs own the
-- asset library. Because they are separate rows, a finishing export can never
-- clobber an in-flight timeline edit (or vice versa) the way a whole-document
-- read-modify-write did.
--
-- Applied idempotently on startup. There is no migration framework yet; when the
-- first backwards-incompatible change lands, introduce one rather than editing
-- this file in place.

CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT        NOT NULL,
    -- Optimistic-concurrency token. Incremented only by a timeline save, so
    -- asset writes never invalidate an editor's in-flight edit.
    revision   BIGINT      NOT NULL DEFAULT 1,
    -- Canvas, tracks and markers: the part of the edit document the editor owns.
    -- Assets deliberately live in their own table, not in here.
    doc        JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_updated_at ON projects (updated_at DESC);

CREATE TABLE IF NOT EXISTS assets (
    id         TEXT PRIMARY KEY,
    project_id TEXT        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- The schema.Asset value. Kept whole rather than normalized: it is written
    -- and read as a unit, and its shape still moves with the generators.
    data       JSONB       NOT NULL,
    -- Soft delete. The media file is deliberately left on disk; reclaiming it is
    -- a separate, deliberate step.
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_project_live
    ON assets (project_id, created_at)
    WHERE deleted_at IS NULL;
