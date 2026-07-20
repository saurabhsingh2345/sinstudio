# Plugins

Studio scans this directory at startup, and again whenever you press **Reload** in
the Plugins panel. Adding a generator is a folder — no rebuild, no restart.

```
plugins/
  <id>/
    plugin.json
```

A plugin whose `id` matches a built-in (`funkycode`, `hyperframes`, `kokorovoice`,
`newaniadv`) replaces it, so a compiled-in manifest can be corrected without a
release. Delete the folder and the built-in comes back.

A manifest that fails to load never stops the server: it is skipped, logged, and
shown in the Plugins panel with the reason. A plugin nobody can see is worse than
a visible error.

## Manifest

```jsonc
{
  "id": "slideshow",                 // defaults to the directory name
  "name": "Slideshow",
  "description": "Shown on the plugin card.",

  "cwd": "../slideshow",             // relative to the studio root; absolute is rejected
  "command": ["node", "render.js", "{input}", "{output}"],
  "probeBinary": "render.js",        // optional: file that must exist for the plugin to be "available"
  "buildHint": "Run `npm install` in ../slideshow.",

  "inputExt": ".json",               // the input document is written to a temp file with this extension
  "inputMode": "file",               // or "dir": writes <tmpdir>/index.html and passes the directory
  "outputExt": "mp4",

  "params": [                        // CLI flags, rendered as controls
    { "flag": "--fps", "label": "FPS", "type": "string", "default": "30" }
  ],

  "fields": [ /* see below */ ]
}
```

`{input}` and `{output}` are substituted into `command`. `{output}` is required.

## Fields — the editable input document

`fields` describes the *input document* (what `{input}` points at), and Studio
generates an editor from it — used both when creating a clip and when re-editing
one from the timeline. Publish fields and your plugin gets a real editor with no
Studio code.

```jsonc
"fields": [
  { "path": "title", "label": "Title", "type": "string", "default": "" },
  {
    "path": "slides[]", "label": "Slides", "type": "array", "itemOf": "Slide",
    "fields": [
      { "path": "text",    "label": "Text",    "type": "text", "default": "" },
      { "path": "seconds", "label": "Seconds", "type": "number", "default": 3 }
    ]
  }
]
```

Types: `string`, `text` (multi-line; add `"mono": true` for code), `number`,
`bool`, `enum` (needs `options`), `array` (needs `fields`). `hint` adds help text.

Paths are dot chains with at most one `[]` array hop. **Inside an array, child
paths are relative to the item** (`"text"`, not `"slides[].text"`).

### Fields are a view, not a schema

The editor reads and writes **only** the paths you list and copies everything else
through untouched. So describing part of your document is fine and expected: a
property Studio doesn't know about survives being edited, and you can add fields
to the manifest later without migrating anything.

Omit `fields` entirely and the document is edited raw — say which format with
`"rawKind": "json" | "text" | "html"`. That is the right answer when the input
isn't data (HyperFrames takes HTML) or is just a string (Kokoro takes a script).
