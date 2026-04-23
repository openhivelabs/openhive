import { ArrowLeft, ArrowUp, FileText, Plus, X } from '@phosphor-icons/react'
import { memo, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useT } from '@/lib/i18n'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useSessionsStore } from '@/lib/stores/useSessionsStore'

/** 새 채팅 초기 화면. 실제 세션 페이지(`RunDetailPage`)와 레이아웃은 같고,
 *  대화 영역은 비어있고 composer 만 보임. 오른쪽 사이드바는 공간만 차지.
 *  메시지를 보내면 ad-hoc 세션을 시작해 `/s/{id}` 로 이동. 드래프트(Task)는
 *  만들지 않는다 — 새 채팅은 템플릿이 아니라 일회성 실행이기 때문. */
export function NewChatPage() {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams<{ companySlug: string; teamSlug: string }>()
  const team = useCurrentTeam()
  const teamPanelCollapsed = useAppStore((s) => s.teamPanelCollapsed)
  const chatColOffsetPx = teamPanelCollapsed ? 168 : 0
  const startSession = useSessionsStore((s) => s.startSession)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // While the backend is still creating the session, show the user's
  // message as a bubble on this page so they don't stare at an empty
  // chat for 1-2 seconds before /s/{id} takes over.
  const [pendingText, setPendingText] = useState<string | null>(null)

  const backHref =
    params?.companySlug && params?.teamSlug
      ? `/${params.companySlug}/${params.teamSlug}/tasks`
      : '/'

  async function startFromMessage(text: string) {
    const body = text.trim()
    if (!body || !team || sending) return
    setSending(true)
    setError(null)
    setPendingText(body)
    try {
      const session = await startSession({ team, taskId: null, goal: body })
      if (!session) {
        setError('세션을 시작하지 못했습니다')
        setSending(false)
        setPendingText(null)
        return
      }
      if (params?.companySlug && params?.teamSlug) {
        // Hand off the optimistic bubble to the session page so there's no
        // blank flash between navigation and the first SSE refetch. Keyed by
        // sessionId and cleared as soon as the real user_message arrives.
        try {
          sessionStorage.setItem(`openhive:pending:${session.id}`, body)
        } catch {
          /* sessionStorage unavailable — non-fatal */
        }
        navigate(`/${params.companySlug}/${params.teamSlug}/s/${session.id}`, { replace: true })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'start failed')
      setSending(false)
      setPendingText(null)
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* Top bar — 실제 세션 페이지와 동일 톤 */}
      <div className="flex items-center justify-between px-4 h-12 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate(backHref)}
            aria-label={t('tasks.backToList')}
            title={t('tasks.backToList')}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {t('chatPage.newChat')}
          </h1>
        </div>
      </div>

      {/* Split: empty chat | invisible sidebar (공간만 확보) */}
      <div className="flex-1 min-h-0 flex">
        <div
          className="flex-1 min-w-0 flex flex-col transition-[padding]"
          style={{ paddingLeft: chatColOffsetPx }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-quiet">
            <div className="max-w-[760px] mx-auto px-6 pt-6 pb-4 space-y-4">
              {pendingText && (
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100 px-4 py-3 text-[15.5px] whitespace-pre-wrap leading-relaxed opacity-60">
                    {pendingText}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="shrink-0 px-6 pb-4">
            <div className="max-w-[760px] mx-auto">
              {error && (
                <div className="mb-2 text-[12px] text-red-600">{error}</div>
              )}
              <Composer sending={sending} onSend={startFromMessage} />
            </div>
          </div>
        </div>
        {/* 오른쪽 사이드바 자리 — 공간만 차지, 렌더 X */}
        <aside
          className="w-[272px] shrink-0"
          aria-hidden
        />
      </div>
    </div>
  )
}

interface Attachment {
  id: string
  file: File
}

function fmtFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const Composer = memo(function Composer({
  sending,
  onSend,
}: {
  sending: boolean
  onSend: (text: string) => void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const disabled = sending || (!text.trim() && attachments.length === 0)

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const MAX = 240
    ta.style.height = 'auto'
    const next = Math.min(ta.scrollHeight, MAX)
    ta.style.height = `${next}px`
    ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden'
  }, [text])

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: Attachment[] = []
    for (const f of Array.from(files)) {
      next.push({
        id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
        file: f,
      })
    }
    setAttachments((prev) => [...prev, ...next])
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const submit = () => {
    const body = text.trim()
    if (sending) return
    if (!body && attachments.length === 0) return
    onSend(body)
    setText('')
    setAttachments([])
  }

  return (
    <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 pt-2.5 pb-2 focus-within:border-neutral-400 dark:focus-within:border-neutral-600">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800 text-[12px] text-neutral-700 dark:text-neutral-300"
            >
              <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="max-w-[180px] truncate">{a.file.name}</span>
              <span className="text-[10.5px] font-mono text-neutral-400 shrink-0">
                {fmtFileSize(a.file.size)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label="첨부 제거"
                className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={t('chatPage.composerPlaceholder')}
        rows={1}
        autoFocus
        className="w-full resize-none bg-transparent text-[15.5px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 outline-none max-h-60 py-0.5 leading-relaxed scrollbar-quiet"
      />

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="파일 첨부"
            title="파일 첨부"
            className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="shrink-0 w-8 h-8 rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neutral-800 dark:hover:bg-neutral-200"
          aria-label={t('chatPage.send')}
        >
          <ArrowUp className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  )
})
