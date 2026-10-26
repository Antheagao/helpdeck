/** The widget's stylesheet, injected next to the markup so the embed stays a
 *  single script tag. Every color is a token on .hd-root, redefined for dark. */
export const STYLES = `
.hd-root {
  --hd-surface: #fcfcfb;
  --hd-page: #f9f9f7;
  --hd-ink: #0b0b0b;
  --hd-ink-2: #52514e;
  --hd-muted: #6f6d67;
  --hd-accent: #2672d0;
  --hd-accent-ink: #ffffff;
  --hd-accent-soft: rgba(38, 114, 208, 0.1);
  --hd-shade: rgba(0, 0, 0, 0.16);
  --hd-border: rgba(11, 11, 11, 0.12);
  --hd-critical: #c42f2f;
  --hd-ok: #1a7f4b;
  --hd-warn: #8a5a00;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--hd-ink);
}
@media (prefers-color-scheme: dark) {
  .hd-root {
    --hd-surface: #1a1a19;
    --hd-page: #0d0d0d;
    --hd-ink: #ffffff;
    --hd-ink-2: #c3c2b7;
    --hd-muted: #a3a198;
    --hd-accent: #2b73c8;
    --hd-accent-soft: rgba(90, 160, 245, 0.16);
    --hd-shade: rgba(255, 255, 255, 0.22);
    --hd-border: rgba(255, 255, 255, 0.14);
    --hd-critical: #ff7b7b;
    --hd-ok: #4cc38a;
    --hd-warn: #e3b341;
  }
}
.hd-root *, .hd-root *::before, .hd-root *::after { box-sizing: border-box; }
.hd-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.hd-launcher {
  width: 56px; height: 56px; border-radius: 50%; border: none;
  background: var(--hd-accent); color: var(--hd-accent-ink);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  cursor: pointer; display: grid; place-items: center;
}
.hd-root :focus-visible { outline: 2px solid var(--hd-accent); outline-offset: 2px; }
.hd-launcher:focus-visible { outline-width: 3px; outline-offset: 3px; }
.hd-panel {
  width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 96px));
  background: var(--hd-surface); border: 1px solid var(--hd-border);
  border-radius: 14px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  display: flex; flex-direction: column; overflow: hidden;
}
.hd-head {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--hd-border);
}
.hd-head strong { font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hd-head .hd-spacer { flex: 1; }
.hd-head button {
  background: none; border: none; color: var(--hd-ink-2); cursor: pointer;
  font: inherit; font-size: 12px; padding: 4px 6px; min-height: 28px; border-radius: 6px;
}
.hd-head button:hover { background: var(--hd-page); color: var(--hd-ink); }
.hd-pill {
  flex: none; font-size: 11px; font-weight: 600; line-height: 1; padding: 5px 9px; border-radius: 999px;
  color: var(--hd-ink); background: var(--hd-accent-soft); border: 1px solid var(--hd-accent);
}
.hd-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.hd-empty { color: var(--hd-muted); font-size: 13px; margin: auto 0; text-align: center; }
.hd-msg { max-width: 86%; min-width: 0; }
.hd-msg.user { align-self: flex-end; }
.hd-msg.assistant { max-width: 100%; }
.hd-msg.assistant .hd-bubble, .hd-msg.assistant .hd-sources, .hd-msg.assistant .hd-tools { max-width: 86%; }
.hd-bubble {
  padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
}
.hd-msg.user .hd-bubble { background: var(--hd-accent); color: var(--hd-accent-ink); border-bottom-right-radius: 4px; }
.hd-msg.assistant .hd-bubble { background: var(--hd-page); border: 1px solid var(--hd-border); border-bottom-left-radius: 4px; }
.hd-msg.failed .hd-bubble { border-color: var(--hd-critical); color: var(--hd-critical); }
.hd-msg.user.failed .hd-bubble { background: var(--hd-page); border: 1px solid var(--hd-critical); color: var(--hd-ink); }
.hd-sources, .hd-tools { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.hd-tools { margin: 0 0 6px; }
.hd-chip {
  font-size: 11px; line-height: 1.4; color: var(--hd-ink-2); background: var(--hd-page);
  border: 1px solid var(--hd-border); border-radius: 999px; padding: 2px 8px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hd-chip-tool { display: inline-flex; align-items: center; gap: 5px; }
.hd-chip-tool svg { flex: none; }
.hd-note { margin-top: 3px; font-size: 11px; line-height: 1.4; color: var(--hd-muted); text-align: right; }
.hd-note.bad { color: var(--hd-critical); }
.hd-dots span {
  display: inline-block; width: 6px; height: 6px; margin-right: 3px; border-radius: 50%;
  background: var(--hd-muted); animation: hd-blink 1.2s infinite;
}
.hd-dots span:nth-child(2) { animation-delay: 0.2s; }
.hd-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes hd-blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .hd-dots span { animation: none; opacity: 0.6; } }

.hd-card {
  margin-top: 8px; padding: 12px; border: 1px solid var(--hd-border); border-radius: 12px;
  background: var(--hd-surface); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.hd-card-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.hd-card-details { margin: 0; display: grid; gap: 8px; }
.hd-card-row { min-width: 0; }
.hd-card-row dt { font-size: 11px; line-height: 1.3; color: var(--hd-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.hd-card-row dd {
  margin: 2px 0 0; font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
}
.hd-card-row dd.long {
  max-height: 11em; overflow-y: auto; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--hd-border); font-size: 12px;
  /* Shadows at the top and bottom edge that show only while there is more to scroll to. */
  background:
    linear-gradient(var(--hd-page) 30%, transparent) top / 100% 18px no-repeat local,
    linear-gradient(transparent, var(--hd-page) 70%) bottom / 100% 18px no-repeat local,
    radial-gradient(farthest-side at 50% 0, var(--hd-shade), transparent) top / 100% 7px no-repeat scroll,
    radial-gradient(farthest-side at 50% 100%, var(--hd-shade), transparent) bottom / 100% 7px no-repeat scroll,
    var(--hd-page);
}
.hd-card-actions { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.hd-btn {
  font: inherit; font-size: 13px; font-weight: 600; min-height: 32px; min-width: 64px; padding: 5px 14px;
  border-radius: 8px; border: 1px solid var(--hd-border); background: transparent; color: var(--hd-ink);
  cursor: pointer;
}
.hd-btn:hover { background: var(--hd-page); }
.hd-btn.primary { background: var(--hd-accent); border-color: var(--hd-accent); color: var(--hd-accent-ink); }
.hd-btn.primary:hover { filter: brightness(0.9); background: var(--hd-accent); }
.hd-btn[aria-disabled='true'] { opacity: 0.6; cursor: default; filter: none; }
.hd-card-status { margin: 10px 0 0; display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.45; }
.hd-card-status > span { min-width: 0; overflow-wrap: anywhere; }
.hd-card-status svg { flex: none; margin-top: 3px; }
.hd-card-status.ok { color: var(--hd-ok); }
.hd-card-status.muted { color: var(--hd-ink-2); }
.hd-card-status.bad { color: var(--hd-critical); }
.hd-card-status:focus-visible { outline-offset: 4px; border-radius: 6px; }
.hd-card.settled { background: var(--hd-page); box-shadow: none; }

.hd-banner {
  display: flex; gap: 8px; align-items: flex-start; padding: 9px 14px; font-size: 12.5px; line-height: 1.45;
  color: var(--hd-ink); background: var(--hd-accent-soft); border-top: 1px solid var(--hd-border);
}
.hd-banner svg { flex: none; margin-top: 2px; color: var(--hd-accent); }
.hd-form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--hd-border); }
.hd-form input {
  flex: 1; min-width: 0; font: inherit; padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--hd-border); background: var(--hd-page); color: var(--hd-ink);
}
.hd-form input::placeholder { color: var(--hd-muted); opacity: 1; }
.hd-form input:focus-visible { outline-offset: 1px; }
.hd-form button {
  font: inherit; padding: 9px 14px; border-radius: 9px; border: none;
  background: var(--hd-accent); color: var(--hd-accent-ink); cursor: pointer;
}
.hd-form button:disabled { opacity: 0.5; cursor: default; }
@media (prefers-reduced-motion: no-preference) {
  .hd-btn, .hd-head button { transition: background-color 0.12s ease, opacity 0.12s ease; }
}
`
