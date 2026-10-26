import { useEffect, useRef } from 'react'

import type { ActionItem } from './chatState'

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const Alert = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 2l6.5 11.5h-13L8 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8 6.5v3M8 11.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export interface ActionCardProps {
  item: ActionItem
  onConfirm: () => void
  onCancel: () => void
}

/** Details this long, or with line breaks, get a bordered, scrollable box. */
const isLong = (value: string) => value.length > 90 || value.includes('\n')

/**
 * The confirm card for a write the bot proposed. Everything shown is rendered
 * by the server from validated arguments, so the customer approves exactly
 * what will run. Buttons use aria-disabled while confirming, so keyboard focus
 * stays put; when the buttons go away, focus moves to the result line.
 */
export function ActionCard({ item, onConfirm, onCancel }: ActionCardProps) {
  const { view, state } = item
  const statusRef = useRef<HTMLParagraphElement>(null)
  const used = useRef(false)
  const settled =
    state.status === 'done' || state.status === 'cancelled' || (state.status === 'failed' && !state.retryable)

  useEffect(() => {
    // The buttons the customer just used are gone; keep keyboard focus on the card.
    if (settled && used.current) {
      statusRef.current?.focus()
      used.current = false
    }
  }, [settled])

  const busy = state.status === 'confirming'
  const press = (act: () => void) => () => {
    if (busy) return
    used.current = true
    act()
  }

  return (
    <div className={`hd-card${settled ? ' settled' : ''}`} role="group" aria-label={view.title}>
      <p className="hd-card-title">{view.title}</p>
      <dl className="hd-card-details">
        {view.details.map((detail) => {
          const long = isLong(detail.value)
          return (
            <div className="hd-card-row" key={detail.label}>
              <dt>{detail.label}</dt>
              <dd
                className={long ? 'long' : undefined}
                tabIndex={long ? 0 : undefined}
                role={long ? 'region' : undefined}
                aria-label={long ? detail.label : undefined}
              >
                {detail.value}
              </dd>
            </div>
          )
        })}
      </dl>

      {state.status === 'failed' && (
        <p className="hd-card-status bad" role="alert" ref={settled ? statusRef : undefined} tabIndex={settled ? -1 : undefined}>
          <Alert />
          <span>{state.message}</span>
        </p>
      )}
      {state.status === 'done' && (
        <p className="hd-card-status ok" ref={statusRef} tabIndex={-1}>
          <Check />
          <span>{state.message}</span>
        </p>
      )}
      {state.status === 'cancelled' && (
        <p className="hd-card-status muted" ref={statusRef} tabIndex={-1}>
          <Cross />
          <span>Cancelled. Nothing was done.</span>
        </p>
      )}

      {(state.status === 'pending' ||
        state.status === 'confirming' ||
        (state.status === 'failed' && state.retryable)) && (
        <div className="hd-card-actions">
          <button type="button" className="hd-btn primary" aria-disabled={busy} onClick={press(onConfirm)}>
            {busy ? 'Confirming...' : state.status === 'failed' ? 'Retry' : view.confirmLabel}
          </button>
          <button type="button" className="hd-btn" aria-disabled={busy} onClick={press(onCancel)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
