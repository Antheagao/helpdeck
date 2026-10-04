# Frequently asked questions

## Does helpdeck work without any API keys

Yes.
With no key configured it runs a deterministic offline mock model that answers from the retrieved documentation, which is enough to evaluate the retrieval quality, the widget, and the tracing end to end.

## Which models are supported

Anthropic Claude models (claude-haiku-4-5 by default) and OpenAI models (gpt-5.6-luna by default), both streamed over plain fetch with no SDK dependency.

## How do I reset a conversation

The widget's reset button starts a new session id; on the server, sessions expire on their own after 30 minutes of inactivity.

## Can the bot answer things outside my documentation

It is instructed to decline rather than guess when retrieval finds nothing relevant, and the mock model does the same, so you can test that behavior offline.
