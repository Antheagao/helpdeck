import { createRoot } from 'react-dom/client'

import { Widget } from './Widget'

/**
 * Self-mounting entry: a site embeds the built bundle with
 *   <script src="widget.js" defer data-endpoint="https://host/api/chat"></script>
 * and the widget attaches itself to a container it creates. Confirm and cancel
 * go to the matching /api/actions route; data-actions-endpoint overrides that
 * when the chat endpoint does not end in /chat.
 */
const script = document.currentScript as HTMLScriptElement | null
const container = document.createElement('div')
container.id = 'helpdeck-widget'
document.body.appendChild(container)

createRoot(container).render(
  <Widget
    endpoint={script?.dataset.endpoint || '/api/chat'}
    actionsEndpoint={script?.dataset.actionsEndpoint || undefined}
    title={script?.dataset.title || 'Ask the docs'}
  />,
)
