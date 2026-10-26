import { useEffect, useRef, useState } from 'react'

import { ActionCard } from './ActionCard'
import { STYLES } from './styles'
import { useChat } from './useChat'

export interface WidgetProps {
  endpoint?: string
  /** Where confirm and cancel are posted; derived from `endpoint` when unset. */
  actionsEndpoint?: string
  title?: string
  greeting?: string
}

const Search = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const Person = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="5.2" r="2.7" stroke="currentColor" strokeWidth="1.6" />
    <path d="M2.8 14c.4-2.6 2.5-4.2 5.2-4.2s4.8 1.6 5.2 4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export function Widget({
  endpoint = '/api/chat',
  actionsEndpoint,
  title = 'Ask the docs',
  greeting = 'Ask a question about the product and I will answer from the documentation.',
}: WidgetProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const { messages, handoff, announcement, streaming, send, confirm, cancel, reset } = useChat(
    endpoint,
    actionsEndpoint,
  )
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, handoff])

  // Keyboard users: opening lands in the input, closing returns to the launcher.
  useEffect(() => {
    if (open) inputRef.current?.focus()
    else if (wasOpen.current) launcherRef.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <div className="hd-root">
      <style>{STYLES}</style>
      {/* Always mounted: a live region added together with its text is not announced. */}
      <div className="hd-sr" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {open ? (
        <div
          className="hd-panel"
          role="dialog"
          aria-label={title}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false)
          }}
        >
          <div className="hd-head">
            <strong>{title}</strong>
            {handoff && <span className="hd-pill">With support</span>}
            <span className="hd-spacer" />
            <button onClick={reset} title="Start a new conversation">
              Reset
            </button>
            <button onClick={() => setOpen(false)} aria-label="Close chat">
              Close
            </button>
          </div>
          <div className="hd-log" ref={logRef}>
            {messages.length === 0 && <p className="hd-empty">{greeting}</p>}
            {messages.map((m, i) => {
              const last = i === messages.length - 1
              const typing = streaming && last && m.role === 'assistant' && !m.content && !m.action
              return (
                <div key={i} className={`hd-msg ${m.role}${m.failed ? ' failed' : ''}`}>
                  {m.tools && m.tools.length > 0 && (
                    <div className="hd-tools">
                      {m.tools.map((label, j) => (
                        <span className="hd-chip hd-chip-tool" key={j}>
                          <Search />
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                  {(m.content || typing) && (
                    <div className="hd-bubble">
                      {m.content || (
                        <span className="hd-dots" aria-label="Assistant is typing">
                          <span />
                          <span />
                          <span />
                        </span>
                      )}
                    </div>
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <div className="hd-sources">
                      {m.sources.map((s, j) => (
                        <span className="hd-chip" key={j} title={s.source}>
                          [{j + 1}] {s.heading}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.action && (
                    <ActionCard
                      item={m.action}
                      onConfirm={() => void confirm(m.action!.view.id)}
                      onCancel={() => void cancel(m.action!.view.id)}
                    />
                  )}
                  {m.role === 'user' && m.followUp?.recorded && <p className="hd-note">Added to {m.followUp.reference}</p>}
                  {m.role === 'user' && m.followUp && !m.followUp.recorded && (
                    <p className="hd-note bad">
                      Not added to {m.followUp.reference}: its record is full. Please start a new chat or contact support another way.
                    </p>
                  )}
                  {m.role === 'user' && m.failed && <p className="hd-note bad">Not sent. Please try again.</p>}
                </div>
              )
            })}
          </div>
          {handoff && (
            <div className="hd-banner">
              <Person />
              <span>
                A person from the support team has this conversation (reference {handoff.reference}). Anything you
                add here goes to them.
              </span>
            </div>
          )}
          <form
            className="hd-form"
            onSubmit={(e) => {
              e.preventDefault()
              void send(draft)
              setDraft('')
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={handoff ? 'Add a note for the support team...' : 'Ask a question...'}
              aria-label={handoff ? 'Your note for the support team' : 'Your question'}
            />
            <button type="submit" disabled={streaming || !draft.trim()}>
              Send
            </button>
          </form>
        </div>
      ) : (
        <button ref={launcherRef} className="hd-launcher" onClick={() => setOpen(true)} aria-label={title}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 5h16v11H8l-4 4V5z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
