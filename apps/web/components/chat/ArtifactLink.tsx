import { useState } from 'react'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/**
 * Renders an `artifact://` URI (as written by agents in their final response)
 * as a downloadable chip. Images get an inline preview toggle.
 *
 * Path is resolved through /api/artifacts/by-uri which streams the file from
 * ~/.openhive/sessions/{sid}/artifacts/{rel} with a proper Content-Type.
 */
export function ArtifactLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  const [previewOpen, setPreviewOpen] = useState(false)

  const filename = (() => {
    const m = href.match(/\/([^/]+)$/)
    return m?.[1] ?? String(children) ?? 'artifact'
  })()
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const isImage = IMAGE_EXTS.has(ext)

  const downloadUrl = `/api/artifacts/by-uri?uri=${encodeURIComponent(href)}`
  const inlineUrl = `${downloadUrl}&disposition=inline`

  const label =
    typeof children === 'string' && children.length > 0 ? children : filename

  return (
    <span className="inline-flex flex-col gap-1 my-1">
      <span
        className="inline-flex items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-2 py-1 text-[14px] max-w-full"
      >
        <span aria-hidden className="shrink-0 text-neutral-500">
          {isImage ? '🖼' : ext === 'pdf' ? '📄' : '📎'}
        </span>
        <a
          href={downloadUrl}
          download={filename}
          className="font-medium underline underline-offset-2 hover:text-blue-600 truncate"
          title={`Download ${filename}`}
        >
          {label}
        </a>
        {isImage && (
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="shrink-0 text-[12.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            aria-label={previewOpen ? '미리보기 닫기' : '미리보기'}
          >
            {previewOpen ? '접기' : '보기'}
          </button>
        )}
      </span>
      {previewOpen && isImage && (
        <img
          src={inlineUrl}
          alt={filename}
          className="max-h-64 rounded-md border border-neutral-200 dark:border-neutral-700"
        />
      )}
    </span>
  )
}
