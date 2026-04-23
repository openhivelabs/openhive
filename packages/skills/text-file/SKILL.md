---
name: text-file
description: Write a UTF-8 text file (markdown, code, plain text, CSV, JSON…) into the run's artifact directory. Use when you need to produce a file the user can download.
triggers:
  keywords: [markdown, csv, json, txt, 텍스트, 마크다운, 파일, file, 저장]
  patterns: ['\.(md|markdown|csv|txt|json|tsv|yaml|yml)\b']
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  properties:
    filename:
      type: string
      description: "Output filename including extension (e.g. 'report.md', 'notes.txt'). No directory components."
    content:
      type: string
      description: "Full text contents of the file."
  required: [filename, content]
---

# text-file

The simplest possible artifact-producing skill. Takes a filename + content and
writes the file to `OPENHIVE_OUTPUT_DIR`. Used as the canonical example for the
skill subsystem and as a fallback when richer formats (PPTX, DOCX) aren't yet
installed — the agent can always emit a markdown report.

The script refuses path-separator characters in `filename` to keep writes
inside the artifact directory.
