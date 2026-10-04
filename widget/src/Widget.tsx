import { useEffect, useRef, useState } from 'react'

import { useChat } from './useChat'

const STYLES = `
.hd-root {
  --hd-surface: #fcfcfb;
  --hd-page: #f9f9f7;
  --hd-ink: #0b0b0b;
  --hd-ink-2: #52514e;
  --hd-muted: #898781;
  --hd-accent: #2a78d6;
  --hd-accent-ink: #ffffff;
  --hd-border: rgba(11, 11, 11, 0.1);
  --hd-critical: #d03b3b;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--hd-ink);
}
@media (prefers-color-scheme: dark) {
  .hd-root {
    --hd-surface: #1a1a19;
    --hd-page: #0d0d0d;
    --hd-ink: #ffffff;
    --hd-ink-2: #c3c2b7;
    --hd-muted: #898781;
    --hd-accent: #3987e5;
    --hd-border: rgba(255, 255, 255, 0.1);
  }
}
.hd-launcher {
  width: 56px; height: 56px; border-radius: 50%; border: none;
  background: var(--hd-accent); color: var(--hd-accent-ink);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  cursor: pointer; display: grid; place-items: center;
}
.hd-launcher:focus-visible { outline: 3px solid var(--hd-accent); outline-offset: 3px; }
.hd-panel {
  width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px));
  background: var(--hd-surface); border: 1px solid var(--hd-border);
  border-radius: 14px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  display: flex; flex-direction: column; overflow: hidden;
}
.hd-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--hd-border);
}
.hd-head strong { font-size: 14px; }
.hd-head .hd-spacer { flex: 1; }
.hd-head button {
  background: none; border: none; color: var(--hd-ink-2); cursor: pointer;
  font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 6px;
}
.hd-head button:hover { background: var(--hd-page); color: var(--hd-ink); }
.hd-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.hd-empty { color: var(--hd-muted); font-size: 13px; margin: auto 0; text-align: center; }
.hd-msg { max-width: 86%; }
.hd-msg.user { align-self: flex-end; }
.hd-bubble {
  padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word;
}
.hd-msg.user .hd-bubble { background: var(--hd-accent); color: var(--hd-accent-ink); border-bottom-right-radius: 4px; }
.hd-msg.assistant .hd-bubble { background: var(--hd-page); border: 1px solid var(--hd-border); border-bottom-left-radius: 4px; }
.hd-msg.failed .hd-bubble { border-color: var(--hd-critical); color: var(--hd-critical); }
.hd-sources { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.hd-chip {
  font-size: 11px; color: var(--hd-ink-2); background: var(--hd-page);
  border: 1px solid var(--hd-border); border-radius: 999px; padding: 2px 8px;
}
.hd-dots span {
  display: inline-block; width: 6px; height: 6px; margin-right: 3px; border-radius: 50%;
  background: var(--hd-muted); animation: hd-blink 1.2s infinite;
}
.hd-dots span:nth-child(2) { animation-delay: 0.2s; }
.hd-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes hd-blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .hd-dots span { animation: none; opacity: 0.6; } }
.hd-form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--hd-border); }
.hd-form input {
  flex: 1; min-width: 0; font: inherit; padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--hd-border); background: var(--hd-page); color: var(--hd-ink);
}
.hd-form input:focus-visible { outline: 2px solid var(--hd-accent); outline-offset: 1px; }
.hd-form button {
  font: inherit; padding: 9px 14px; border-radius: 9px; border: none;
  background: var(--hd-accent); color: var(--hd-accent-ink); cursor: pointer;
}
.hd-form button:disabled { opacity: 0.5; cursor: default; }
`

export interface WidgetProps {
  endpoint?: string
  title?: string
  greeting?: string
}

export function Widget({
  endpoint = '/api/chat',
  title = 'Ask the docs',
  greeting = 'Ask a question about the product and I will answer from the documentation.',
}: WidgetProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const { messages, streaming, send, reset } = useChat(endpoint)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

  return (
    <div className="hd-root">
      <style>{STYLES}</style>
      {open ? (
        <div className="hd-panel" role="dialog" aria-label={title}>
          <div className="hd-head">
            <strong>{title}</strong>
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
            {messages.map((m, i) => (
              <div
                key={i}
                className={`hd-msg ${m.role}${m.failed ? ' failed' : ''}`}
              >
                <div className="hd-bubble">
                  {m.content ||
                    (streaming && i === messages.length - 1 ? (
                      <span className="hd-dots" aria-label="Assistant is typing">
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : null)}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="hd-sources">
                    {m.sources.map((s, j) => (
                      <span className="hd-chip" key={j} title={s.source}>
                        [{j + 1}] {s.heading}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <form
            className="hd-form"
            onSubmit={(e) => {
              e.preventDefault()
              send(draft)
              setDraft('')
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a question..."
              aria-label="Your question"
            />
            <button type="submit" disabled={streaming || !draft.trim()}>
              Send
            </button>
          </form>
        </div>
      ) : (
        <button className="hd-launcher" onClick={() => setOpen(true)} aria-label={title}>
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
