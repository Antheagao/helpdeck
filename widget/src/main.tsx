import { createRoot } from 'react-dom/client'

import { Widget } from './Widget'

/**
 * Self-mounting entry: a site embeds the built bundle with
 *   <script src="widget.js" defer data-endpoint="https://host/api/chat"></script>
 * and the widget attaches itself to a container it creates.
 */
const script = document.currentScript as HTMLScriptElement | null
const container = document.createElement('div')
container.id = 'helpdeck-widget'
document.body.appendChild(container)

createRoot(container).render(
  <Widget
    endpoint={script?.dataset.endpoint || '/api/chat'}
    title={script?.dataset.title || 'Ask the docs'}
  />,
)
