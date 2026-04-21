# Placeholder reference

PPT placeholders live in a slide's `<p:sp>` as:

```xml
<p:nvSpPr>
  <p:nvPr>
    <p:ph type="..." idx="..." sz="..."/>
  </p:nvPr>
</p:nvSpPr>
```

## Common `type` values

| `type` value | Meaning                                     |
|--------------|---------------------------------------------|
| `title`      | Regular slide title                         |
| `ctrTitle`   | Centered title (title slide layout)         |
| `subTitle`   | Subtitle                                    |
| `body`       | Body text / bullet list                     |
| `dt`         | Date                                        |
| `ftr`        | Footer                                      |
| `sldNum`     | Slide number                                |
| `pic`        | Picture                                     |
| `chart`      | Chart                                       |
| `tbl`        | Table                                       |
| `media`      | Media                                       |
| `hdr`        | Header (notes slides only)                  |

If `type` is absent, treat it as body (legacy convention).

## `idx` — identifies the placeholder position within a layout

- `idx="0"` — usually the title area
- `idx="1"` — usually the body / primary content area
- higher indices — additional body slots in multi-column layouts

The selector logic in `helpers/patch.py` falls back on:
- `idx="1"` as the body shape if no `type="body"` exists
- Topmost text shape as title if no placeholder is declared (our own
  spec renderers don't emit placeholders; they use raw text boxes).

## Typical structure for the 12 spec slide types

Our renderers don't always use placeholders — they often use raw text boxes.
When reverse-engineering a deck built elsewhere (e.g. PowerPoint), expect:

| Slide type      | Shape layout                                            |
|-----------------|---------------------------------------------------------|
| title           | ctrTitle + subTitle                                     |
| section         | title + (optional subTitle)                             |
| bullets         | title + body                                            |
| two_column      | title + 2 body placeholders (idx=1, idx=2)              |
| image           | (picture) + (optional title) + (optional caption text)  |
| table           | title + graphicFrame (tbl)                              |
| chart           | title + graphicFrame (c:chart)                          |
| comparison      | title + N body columns                                  |
| quote           | body (large text)                                       |
| steps           | title + N small text boxes in a row                     |
| kpi             | title + N text boxes (big number + label)               |
| closing         | ctrTitle or title                                       |
