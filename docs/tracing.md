# Tracing and observability

## spanlight integration

Set SPANLIGHT_URL (for example http://127.0.0.1:4318) and every chat request ships a trace to spanlight, the self-hosted LLM observability tool.
Each trace carries a retrieval span, an LLM span with real token counts and estimated cost, and a memory-compaction span.

## Failure isolation

Tracing is fire-and-forget: if the collector is down, helpdeck logs one warning and keeps answering.
Observability must never take the chat down.

## What you can see

In the spanlight dashboard you get calls and spend over time, per-model latency percentiles and error rates, and a waterfall of every chat request showing where the time went.
