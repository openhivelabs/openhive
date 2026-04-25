---
name: image-gen
description: Render PNG images from HTML. Two modes — `template` (pick a built-in preset + fill vars, ~hundreds of tokens) or `freeform` (provide full HTML, kB of tokens). Good for text-first graphics: YouTube thumbnails, report covers, stat cards. NOT a photo generator.
triggers:
  keywords: [image, picture, thumbnail, cover, png, banner, graphic, render]
  patterns: ['\.png\b']
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  required: [mode]
  properties:
    mode:
      type: string
      enum: [template, freeform]
      description: "`template` uses a built-in preset; `freeform` takes full HTML."
    template:
      type: string
      description: "template name (template mode only). See the catalog below."
    vars:
      type: object
      description: "template vars (template mode only). Keys match templates/<name>/template.yaml inputs."
    html:
      type: string
      description: "full HTML document (freeform mode only). Must self-size the body to width x height."
    width:
      type: integer
      description: "viewport width in px (freeform mode only). 100–4096."
    height:
      type: integer
      description: "viewport height in px (freeform mode only). 100–4096."
    filename:
      type: string
      description: "output filename (plain base name, no slashes). Default: image-gen-<timestamp>.png."
---

# image-gen skill

## Decision tree

```
What are you making?
│
├─ Fixed-layout graphic: YouTube thumbnail / cover / stat card
│   → template mode. Pick from the catalog and fill vars.
│
└─ No catalog layout fits (custom design needed)
    → freeform mode. Write HTML/CSS directly + set width/height.
      Read reference/freeform-guide.md first.
```

**Default to template mode.** Freeform uses 10x+ tokens; use it only when templates do not fit.

## Template catalog

| name | size | Purpose | Required vars |
| --- | --- | --- | --- |
| `yt-bold-text` | 1280×720 | Large title + subtitle, general YouTube thumbnail | `title` |
| `yt-split` | 1280×720 | Left text / right image slot | `title`, `image_path` |
| `yt-quote` | 1280×720 | Quote + author | `quote` |
| `cover-minimal` | 1600×900 | Report/presentation cover | `title` |
| `stat-card` | 1080×1080 | Big-number stat card | `value`, `label` |

For each template's full input schema, see `templates/<name>/template.yaml`.

## Input examples

### template mode
```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": { "title": "...", "subtitle": "...", "accent": "#ff4d4d" },
  "filename": "thumbnail.png"
}
```

### freeform mode
```json
{
  "mode": "freeform",
  "html": "<!doctype html><html>...",
  "width": 1280,
  "height": 720,
  "filename": "custom.png"
}
```

## Output envelope

Success:
```json
{"ok": true, "files": [{"name": "thumbnail.png", "path": "/abs/...", "mime": "image/png", "size": 73412}], "warnings": []}
```

Failure (`error_code` values):
- `validation` — vars do not match schema. `message` includes path + reason.
- `template_not_found` — template does not exist.
- `invalid_mode` — mode is not template/freeform.
- `size_out_of_range` — outside 100-4096.
- `output_sanity` — rendered PNG is too small (usually empty HTML).
- `invalid_filename` — filename contains `/` or `..`.

## Limits & caveats

- Pass local images to `image_path` etc. as `file:///abs/path` or http(s) URLs.
- If external font/image loading fails, screenshot current state after a 10s timeout — missing fonts may render as system defaults.
- First call auto-downloads the Chromium binary (~170MB, once). Later calls run immediately.
- This skill does not create photo-realistic images. Use another path for people/product photos.

## Python deps

`requirements.txt`: `jinja2`, `jsonschema`, `playwright`, `pyyaml`. Runtime needs a python3 that can import those packages (project venv or system Python).
