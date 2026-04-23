import { DownloadSimple, FileText } from '@phosphor-icons/react'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

const TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  xlsx: 'Excel',
  md: 'Markdown',
  txt: 'Text',
  json: 'JSON',
  csv: 'CSV',
  html: 'HTML',
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  svg: 'SVG',
}

/**
 * Inline chat artifact card — Claude Desktop-style.
 *
 * Large horizontal card with a file icon / image thumbnail on the left,
 * filename + type label in the middle, and a download affordance on the
 * right. Clicking either the filename or the download button triggers
 * a file download via /api/artifacts/by-uri.
 *
 * For image artifacts the thumbnail shows a live preview (served inline
 * from the same endpoint with ?disposition=inline).
 *
 * Server-side strips `artifact://` URIs that don't resolve in the session
 * index before this component ever renders (see engine/post-process.ts),
 * so a rendered card always points at a real, downloadable file.
 */
export function ArtifactLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  const filename = (() => {
    const m = href.match(/\/([^/]+)$/)
    return m?.[1] ?? String(children) ?? 'artifact'
  })()
  const ext = (filename.split('.').pop() ?? '').toLowerCase()
  const isImage = IMAGE_EXTS.has(ext)
  const typeLabel = TYPE_LABELS[ext] ?? (ext ? ext.toUpperCase() : '파일')

  const downloadUrl = `/api/artifacts/by-uri?uri=${encodeURIComponent(href)}`
  const inlineUrl = `${downloadUrl}&disposition=inline`

  return (
    <span className="block my-2">
      <a
        href={downloadUrl}
        download={filename}
        className="group flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50/60 dark:bg-neutral-800/40 px-3 py-2.5 w-full hover:bg-neutral-100 dark:hover:bg-neutral-800/60 transition-colors no-underline"
        title={`Download ${filename}`}
      >
        <span
          className="shrink-0 w-10 h-10 rounded-lg bg-white dark:bg-neutral-700 border border-neutral-200 dark:border-neutral-600 flex items-center justify-center overflow-hidden"
          aria-hidden
        >
          {isImage ? (
            <img
              src={inlineUrl}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <FileText className="w-5 h-5 text-neutral-500" />
          )}
        </span>
        <span className="flex-1 min-w-0 leading-tight">
          <span className="block font-semibold text-[14px] text-neutral-900 dark:text-neutral-100 truncate group-hover:underline">
            {filename}
          </span>
          <span className="block text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5">
            {typeLabel}
          </span>
        </span>
        <span
          className="shrink-0 p-1.5 rounded-md text-neutral-400 group-hover:text-neutral-700 group-hover:bg-neutral-200 dark:group-hover:text-neutral-200 dark:group-hover:bg-neutral-700"
          aria-hidden
        >
          <DownloadSimple className="w-4 h-4" />
        </span>
      </a>
    </span>
  )
}
