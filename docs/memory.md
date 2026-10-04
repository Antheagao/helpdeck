# Conversation memory

## The token budget

Each session's history lives in a ConversationMemory with a hard token budget (2000 tokens by default).
What goes to the model always fits the budget: a running summary plus the most recent turns kept verbatim.

## Rolling summarization

When history outgrows the budget, the oldest overflow turns are folded into the running summary and dropped from the verbatim window.
With a real model configured the summary is written by the LLM; offline, an extractive fallback keeps the first sentence of each turn.
The most recent six turns are never summarized, so the model always sees the immediate back-and-forth exactly as it happened.

## Sessions

Each widget visitor gets a session id, and sessions expire after 30 minutes of inactivity so abandoned tabs do not leak memory on the server.
