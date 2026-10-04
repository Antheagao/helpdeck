# What is helpdeck

helpdeck is an embeddable AI support chatbot you host yourself.
It answers questions about your product from your own documentation, streams replies token by token, and cites the doc sections it used.

## How it works

Every chat request runs the same pipeline: retrieve relevant documentation passages with BM25, build a prompt that fits a hard token budget using the conversation memory, stream the model's answer over SSE, then fold the exchange back into memory.
When a spanlight collector is configured, each request is traced end to end with latency, token, and cost numbers per step.

## What makes it different

helpdeck has no framework dependencies and no vendor accounts beyond the one LLM key you bring.
Memory management and retrieval are implemented in the repository itself, in plain TypeScript, and an offline mock model keeps the whole product runnable with zero keys.
