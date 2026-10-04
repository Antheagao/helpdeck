# Setup and installation

## Install and run

Install dependencies with `npm install`, then start the server with `npm start`.
The server listens on port 4319 by default; override it with the PORT environment variable.
Without any API key it runs the offline mock model, so you can try everything before configuring a provider.

## Configure a model

Set ANTHROPIC_API_KEY to answer with Claude (claude-haiku-4-5 by default), or OPENAI_API_KEY for gpt-5.6-luna.
Override the exact model id with HELPDECK_MODEL.
Keys live in a local .env file that is never committed.

## Point it at your documentation

Put markdown files in the docs directory, or set HELPDECK_DOCS to another directory.
Every heading section becomes a retrievable passage; the index rebuilds on startup.

## Embed the widget on your site

Build the widget with `npm run widget:build`, then add a single script tag to any page:
`<script src="https://your-helpdeck-host/widget.js" defer></script>`.
The widget renders a floating chat button that talks to your helpdeck server.
