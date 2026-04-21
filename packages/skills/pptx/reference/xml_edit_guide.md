# Raw XML edit guide

Most edits can be done via `edit_deck.py` (patch DSL). This file is for the
**fallback path**: when you need to touch raw OOXML because no existing op
covers the case.

When to reach for this:
- Custom animations / transitions not covered by the patch DSL
- Non-standard shape fills (gradients, pattern fills on arbitrary shapes)
- SmartArt adjustments (rare, risky)
- Embedded media objects (audio/video)
- Slide masters / layouts edits

If the case is routine (text, bullets, charts, images, slides), **use the
patch DSL instead** — it's tested and atomic.

## Approach

1. **Load the package** via `helpers.opc.Package`:
   ```python
   from helpers.opc import Package
   pkg = Package.open("deck.pptx")
   ```

2. **Find the target part.** Slides are addressed by index via `list_slide_parts`:
   ```python
   from helpers.patch import list_slide_parts
   slide = list_slide_parts(pkg)[2]
   root = slide.xml()  # lxml element
   ```
   For charts/notes/masters, follow relationships:
   ```python
   charts = pkg.related(slide, RT_CHART)
   ```

3. **Consult `reference/schemas/`** for the XSD of the target XML. Common entry points:
   - `pml.xsd` — slide, notes, presentation, slideMaster
   - `dml-main.xsd` — shapes, text bodies, runs, colours, fonts
   - `dml-chart.xsd` — everything chart-related

4. **Edit via `lxml`.** Namespace prefixes are defined in `helpers/patch.py`:
   ```python
   from helpers.patch import A, P, R, C, NSMAP
   # A = drawingml main
   # P = presentationml
   # R = relationships (xmlns:r)
   # C = chart
   ```

5. **Write the result back.** `Part.set_xml(root)` serialises + caches:
   ```python
   slide.set_xml(root)
   pkg.save("out.pptx")
   ```

6. **Validate.** If you're unsure, run `scripts/validate_deck.py` against
   the XSDs bundled in `reference/schemas/` before saving over the user's
   input file.

## Useful snippets

See `reference/snippets/` for pre-validated XML fragments:

- `sp_textbox.xml` — a minimal text-bearing shape
- `sp_picture.xml` — a picture shape with `<a:blip r:embed="…">`
- `chart_column_skeleton.xml` — a column chart (2 series, 4 categories)
- `chart_pie_skeleton.xml` — a pie chart
- `table_skeleton.xml` — a 3×3 table
- `placeholder_map.xml` — the common ph types and their idx conventions

Copy, adapt the namespace prefixes, insert into the target slide.

## Things to know about OPC

- **Every part has a partname** (e.g. `/ppt/slides/slide3.xml`). Partnames
  are file paths inside the zip.
- **Relationships** live in `_rels/*.rels` files and use relative paths
  (`../charts/chart1.xml`). The `Relationship.target_partname(source)`
  helper resolves them to absolute partnames.
- **Content types** must be declared in `[Content_Types].xml` either by
  extension default or per-partname override. `Package.add_part()`
  handles this automatically when you add a new part.
- **Dropping a part must cascade** — drop the rels pointing to it, drop
  the content-type override, and optionally drop parts that become
  unreferenced. Use `Package.drop_part(partname, cascade_rels=True)` —
  don't just delete the dict entry.
- **Partname allocation**: use `Package.next_partname("/ppt/charts/chart%d.xml")`
  so you never collide with an existing part.

## Gotchas

- After editing an lxml tree, call `Part.set_xml(root)` — otherwise the
  in-memory XML won't be serialised on save.
- **Namespace declarations** live on the root element. When you build a
  sub-element with `etree.SubElement(parent, f"{{{A}}}tag")`, lxml inherits
  the namespace prefix from the root's nsmap. If you build an element from
  scratch, pass `nsmap=NSMAP`.
- **r:id vs rId**: the attribute is `{http://…/relationships}id`; the value
  is a string like `"rId1"`. Use `helpers/patch.py`'s `R` constant:
  ```python
  elem.get(f"{{{R}}}id")
  ```
- **Chart rId resolution**: the `<c:chart r:id="rId3"/>` inside a
  `<p:graphicFrame>` refers to a relationship **on the slide part**, not
  on the chart part. Look up via `pkg.related_one(slide, rid)`.
- **Order matters in <p:spTree>**: shapes are rendered in document order.
  New shapes should be appended at the end of the sp tree.
