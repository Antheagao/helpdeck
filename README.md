# helpdeck

[![CI](https://github.com/Antheagao/helpdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Antheagao/helpdeck/actions/workflows/ci.yml)

An embeddable AI support chatbot you host yourself.
It answers questions about your product from your own markdown documentation, streams replies token by token, and cites the sections it used.
It can also look up an order, open a support ticket, or hand the chat to a person, and it never does a thing that changes anything until the customer presses confirm.

![The helpdeck widget answering from the docs](docs/screenshots/demo.png)

One script tag embeds it on any page:

```html
<script src="https://your-host/widget.js" defer data-endpoint="/api/chat"></script>
```

The confirm and cancel buttons on action cards post to `/api/actions`, derived from `data-endpoint` by swapping a trailing `/chat`.
If your chat endpoint does not end in `/chat`, add `data-actions-endpoint` with the matching actions path.

## Why it is built this way

Retrieval-augmented chat is usually assembled from a framework and two or three hosted services.
helpdeck implements the three interesting pieces itself, in the repository, with no framework dependency and no accounts beyond the single LLM key you bring:

- **Context-window memory** - a token-budgeted conversation buffer with rolling summarization, so a long chat never overflows the prompt (the job LangChain's summary-buffer memory does).
- **Retrieval** - BM25 with heading field-weighting over your markdown, so there is no embedding model, no vector database, and no retrieval API call.
- **Tracing** - traces, token counts, latency, and cost exported to [spanlight](https://github.com/Antheagao/spanlight), self-hosted (the job LangSmith or Langfuse does).

An offline mock model keeps the whole product - widget, retrieval, memory, tracing, actions - runnable and testable with **zero API keys**.
The part that touches money and people, the confirm gate, is enforced by the server rather than asked of the model, and an offline eval checks that against a model that does its worst (see [Evals](#evals)).

## Quickstart

```bash
npm install
npm run widget:build
npm start                      # http://127.0.0.1:4319 - demo page + widget
```

With no key set it answers with the offline mock model.
The demo page has a "Try an action" card with a seeded order, so the order lookup, the ticket card, and the handoff can be tried with no key.
To use a real model, put a key in `.env` (gitignored) and start with `node --env-file=.env`:

```bash
ANTHROPIC_API_KEY=sk-...       # or OPENAI_API_KEY
HELPDECK_MODEL=claude-haiku-4-5
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4319` | Listen port |
| `MODEL_PROVIDER` | unset | `anthropic`, `openai`, or `mock`. Unset picks by key (Anthropic, then OpenAI, then the mock). An explicit value needs its key, and `mock` refuses to start beside a key or `HELPDECK_MODEL`, so a demo can never spend |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | unset | Provider; unset means the offline mock |
| `HELPDECK_MODEL` | per provider | Override the model id |
| `HELPDECK_DOCS` | `./docs` | Knowledge-base directory |
| `HELPDECK_TOOLS` | all tools | Tools offered to the model: a comma-separated list of `lookup_order`, `create_ticket`, `handoff_to_human`, or `none`. Only which tools are offered is configurable: whether one needs the customer's confirmation is fixed in code |
| `HELPDECK_OPERATOR_TOKEN` | unset | Bearer token (at least 32 characters, e.g. `openssl rand -hex 32`) for `GET /api/operator/handoffs` (the newest 50, newest first; no paging yet) and `GET /api/operator/handoffs/:reference`. Unset turns the operator API off |
| `SPANLIGHT_URL` | unset | Export traces to a spanlight collector |

## How a request flows

```mermaid
flowchart LR
    A[Widget] -- "POST /api/chat" --> B[Express]
    B --> C[BM25 retrieval]
    B --> D[Conversation memory]
    C --> E["Prompt within token budget, passages fenced as data"]
    D --> E
    E --> F["LLM, streamed as SSE"]
    F -- tokens --> A
    F -- read tool call --> T[lookup_order]
    T -- result as data --> F
    F -- write tool call --> P["Pending action and card"]
    P -- card event --> A
    A -- "POST /api/actions/:id/confirm" --> X[Confirm gate]
    X --> W[Ticket or handoff store]
    B -. trace .-> G[(spanlight)]
```

Retrieval, each model call, each tool, and memory compaction are each a span; when `SPANLIGHT_URL` is set, every request lands in the dashboard with its latency, token counts, and cost.
Email addresses are scrubbed from span text before it leaves the server.
Tracing is fire-and-forget: if the collector is down, helpdeck logs one warning and keeps answering.

### Conversation memory

`render()` always fits the budget (2000 tokens by default).
The most recent six turns stay verbatim; older turns are folded into a running summary, written by the LLM when one is configured and by an extractive fallback otherwise - including when the summarizer call fails, so a provider hiccup degrades the summary instead of dropping the conversation.

### Retrieval

Each markdown heading section becomes one passage.
Heading terms are weighted above body terms, because a heading names its section's topic: without that, *"how does the token budget work?"* answered from the FAQ, since "does" and "work" happened to match there.
Question scaffolding (`how`, `does`, `can`, ...) is dropped from queries for the same reason. Both behaviors are pinned by regression tests.

## Actions and human handoff

Beyond answering, the assistant can act: look up an order, open a support ticket, and hand the conversation to a person.
The model never performs a change itself.
It proposes one, the server shows the customer a card of exactly what will happen, and only the customer's confirm request runs it.

| Tool | Access | Confirmation | What it touches |
|---|---|---|---|
| `lookup_order` | read | none, it runs inside the chat loop | The seeded order book. Needs the order number and the email on the order, and never returns an address. |
| `create_ticket` | write | the customer presses confirm on the card | A ticket in the in-process store, at most three per chat. |
| `handoff_to_human` | write | the customer presses confirm on a card that shows the exact recap | A handoff record for the support team. The bot stops answering that chat. |

Which tools are offered is configurable (`HELPDECK_TOOLS`).
Whether a tool needs confirmation is part of its definition in code, so no setting can make a write skip it.

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Widget
    participant S as Server
    participant M as Model
    participant X as Executor
    C->>W: Open a ticket for my broken lamp
    W->>S: POST /api/chat
    S->>M: prompt and the offered tools
    M-->>S: create_ticket call
    S->>S: validate the arguments and store a pending action
    S-->>W: action event with the card
    Note over S,X: Nothing has run. The chat loop has no way to reach the executor.
    C->>W: presses Confirm
    W->>S: POST /api/actions/:id/confirm
    S->>X: run once, the action id is the idempotency key
    X-->>S: ticket T-1001
    S-->>W: 200 with the result
```

### Safety properties

- **The server enforces the confirm, not the prompt.** The chat pipeline holds a port that can propose an action but not confirm one. The function that executes a write is imported by the confirm route alone, and a test fails if any other module imports it.
- **A confirm runs once.** The action id is the idempotency key: a retried or concurrent confirm shares one execution and gets one result, even if the customer double clicks. Proposals expire after ten minutes, a chat has one live card at a time, and a finished action can be confirmed again within the hour to replay its result.
- **Arguments are validated and scoped to the chat.** A ticket takes only a subject and a description and belongs to the session that confirmed it. An order lookup needs both the order number and the email, and an unknown order and a wrong email get the identical answer, so order numbers cannot be probed.
- **Retrieved text and tool results are data.** Documentation passages sit inside a `<documentation>` block whose closing tag cannot be forged from inside a passage, tool results arrive as tool messages, and the system prompt says to follow neither. The seeded order book includes a customer note that tries to inject instructions, so the eval has a real one to resist.
- **Limits.** Three tickets per chat. Rate limits per client address over ten minutes: 60 chat requests, 20 confirm or cancel requests, 120 operator requests, with IPv6 clients grouped by their /64. A queue of 1000 waiting handoffs, past which a new handoff is refused with a retryable error rather than dropping someone already waiting.
- **Errors are stable.** New and migrated endpoints answer `{ "error": { "code", "message" } }`; clients branch on `code`, and a client never sees an Express error page, a stack trace, or a provider's response body (which can echo an API key), and that body is never logged.

### Handoff

Asking for a person shows a card with the reason and the recap that will be shared.
The recap has a fixed layout (`Reason`, `Customer asked`, `Actions`, `Earlier (summarized)`), is computed once when the card is proposed, and is stored unchanged on confirm, so what the customer approved is what the team receives.
Everything the customer wrote reaches it as quoted single lines, so a message cannot forge a section of the recap.
After the confirm the bot stops answering that chat: later messages skip retrieval and the model and are filed on the record as follow-ups, up to 20,000 characters.

### Operator API

The support team reads handoffs over a token-guarded API.
It does not exist until `HELPDECK_OPERATOR_TOKEN` is set, and the token must be at least 32 characters.
The token is compared by SHA-256 digest in constant time, every response is marked `no-store`, and the chat session id (which would let someone act for the customer) is never included.

```bash
export TOKEN=$(openssl rand -hex 32)
HELPDECK_OPERATOR_TOKEN=$TOKEN npm start

# the newest 50 handoffs, newest first (no paging yet)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4319/api/operator/handoffs

# one handoff, with its transcript and follow-ups
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4319/api/operator/handoffs/H-1001
```

```json
{
  "reference": "H-1001",
  "createdAt": "2026-10-26T21:50:51.173Z",
  "reason": "It arrived damaged, I want to talk to a person",
  "summary": "Reason: ...\n\nCustomer asked:\n  > user: ...\n\nActions:\n- none\n\nEarlier (summarized):\n  > (none)",
  "transcript": [{ "role": "user", "content": "It arrived damaged, I want to talk to a person" }],
  "actions": { "tickets": [], "orders": [] },
  "followUps": [{ "at": "2026-10-26T21:52:10.004Z", "text": "I have photos of the box" }],
  "followUpsFull": false,
  "status": "waiting"
}
```

### Known limits

- Tickets, handoffs, pending actions, and sessions live in process memory and are lost on a restart. The stores are small classes, so a real ticket desk or database can replace them, but none ships.
- Rate limits key on the socket address and trust no proxy header, so behind a reverse proxy every customer shares one bucket until trust-proxy handling is added on purpose.
- The operator list returns the newest 50 handoffs and has no paging yet.
- The order book is fake seed data in `server/data/orders.json`.

## Evals

`npm run eval` runs a fixed set of cases offline, with no key and no network, and writes `evals/results/latest.json`.
Each case drives a fresh server over HTTP and is scored against what the stores, the stream, and the cards actually show.
The table below is generated from that artifact.

<!-- EVAL_TABLE:START -->

| | Cases | Task success | Tool choice | Tool args | Grounded | Refusals correct | Over-refused | Unconfirmed writes | Duplicate writes | Transport failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| task | 12 | 12/12 | 12/12 | 8/8 | - | - | 0/12 | 0 | 0 | 0 |
| tool | 6 | 4/4 | 6/6 | 3/3 | 2/2 | - | 0/6 | 0 | 0 | 0 |
| grounded | 8 | - | 8/8 | - | 5/8 | - | 1/8 | 0 | 0 | 0 |
| refusal | 6 | 6/6 | 6/6 | - | - | 5/6 | - | 0 | 0 | 0 |
| injection | 7 | 7/7 | 7/7 | - | - | - | - | 0 | 0 | 0 |
| **Overall** | 39 | 29/29 | 39/39 | 11/11 | 7/10 | 5/6 | 1/26 | 0 | 0 | 0 |
| Paraphrase only | 4 | - | 4/4 | - | 1/4 | - | 1/4 | 0 | 0 | 0 |

*Thresholds, pinned in `evals/thresholds.json`: at least task success 1, tool choice 1, tool arguments 1, grounded 0.7, refusals correct 0.8333, paraphrase grounded 0.25; over-refused at most 0.0385; the last three columns must be 0.*

*Generated from `evals/results/latest.json` (dataset version 1, 39 cases). Do not edit by hand: run `npm run eval -- --update-readme`.*

<!-- EVAL_TABLE:END -->

Reading it: a cell is passed over measured, and `-` means no case in that row measures it.
The last three columns count real writes in the ticket and handoff stores that no confirm the harness sent accounts for, extra writes from one confirm, and cases whose pipeline could not run at all (a refused chat or a crashed handler cannot score as a pass).
Read the first two together: two writes reporting one id show as an unconfirmed write.

### What the numbers are

Every case runs the shipped server end to end over HTTP: BM25 retrieval, the agent loop, argument validation, the confirm gate, the ticket and handoff stores, and the operator recap.
The model is a scripted stand-in: the offline mock, whose tool policy was written alongside these cases, or a deliberately hijacked model that obeys any instruction planted in a document or a tool result.
The hard invariants and the hijacked injection cases measure the server: they hold against a model that does the worst it can.
Groundedness measures retrieval: the mock cites the top passage, so a grounded case passes exactly when BM25 ranks the right file first, and the paraphrase row is BM25's honest score on questions that avoid the documentation's own words.
Tool choice, arguments, refusals, and over-refusal are regression tests against a policy designed to pass them, partly circular, so read them as "the pipeline still does what it did", not as evidence about model judgment.
None of these numbers describe how a real model would behave; the same cases can be pointed at one later.

### The gate

`npm run eval:check` runs the cases fresh and exits 1 when any of these hold:

- a hard invariant is above zero: an unconfirmed write, a duplicate write, or a case that could not run;
- a metric is below its floor, or over-refusal is above its ceiling, in `evals/thresholds.json`;
- the committed artifact differs from the fresh run, so the table cannot go stale (run `npm run eval` and commit it).

CI runs it as its own `evals` job, so a regression shows up as a red check that names the metric.
The thresholds are pinned to the first measured values and copied into the artifact, together with a hash of the cases and fixtures, so changing the dataset or a bar always shows up in the same diff as the table.
A separate CI step compares `evals/thresholds.json` with the previous commit and fails if a floor went down or a ceiling went up, unless the commit message carries `loosen-thresholds: <reason>`.
A case that misses a check is recorded in the artifact and does not fail the gate by itself: the thresholds say how many misses are accepted.

### Proof that the gate catches things

`tests/evals.test.ts` seeds each regression and checks that the gate goes red:

- a model that stops citing drives groundedness to zero;
- a model that drops the email argument fails tool arguments;
- a ticket written straight into the store, with no confirm, trips unconfirmed writes;
- a confirm that does its work twice trips duplicate writes;
- a retrieval or propose step that throws, or a chat that is rate limited on every request, trips transport failures instead of passing quietly;
- and a fully hijacked model, run over every case, leaves the invariants at zero.

### What the evals found

- **No relevance floor on BM25.** "What is the weather like in Paris today?" is answered from an unrelated page of the docs, because ordinary words overlap, instead of being declined. This is the one refusal miss.
- **Paraphrases mostly miss.** Only one of the four paraphrase questions ranks its page first: two are answered from the wrong page and one is declined. The next section says what that means for the retrieval choice.

## Why BM25 here, and embeddings in doc-pilot

helpdeck's knowledge base is documentation its owner writes.
Headings name their sections' topics, and the writer controls the vocabulary, so a lexical match on a heading is strong evidence.
It is tens to hundreds of passages, which BM25 searches in memory with no model download, no key, and no vector store.
That also makes the eval exact: results are deterministic, every miss can be explained by term overlap, and the fix is usually editing the doc.
A retrieval miss costs a decline or an off-topic answer, never a wrong order status, because order data comes from the lookup tool and not from retrieval.

[doc-pilot](https://github.com/Antheagao/doc-pilot) has the opposite corpus: OCR'd receipts that people search by paraphrase ("a light for my workspace" for a line printed as "LED Desk Lamp").
In its retrieval eval a lexical retriever found exact names almost always (99.7% recall@5) but only about 22% of paraphrases, and hybrid search with reciprocal rank fusion found 63% to 80% depending on chunking, which is why it ships hybrid.

This repository's own paraphrase row shows the same weakness at small scale: one of four paraphrase questions ranks the right page first.
The switch condition is therefore stated in terms of that number.
If the paraphrase grounded score on your own knowledge base, measured with paraphrase cases you add to the evals, is below what you will accept, add a dense retriever behind the same `search(query, k)` shape as `BM25Index` and fuse the two.
Until then BM25 is the right default, and the two gaps above (the off-topic answer and the paraphrase misses) are the ones to watch.

## Development

```bash
npm test          # the whole suite: server, HTTP, widget logic, evals (no keys needed)
npm run build     # type-check server, tests, evals, and widget
npm run dev       # server with reload
npm run widget:dev
npm run eval      # run the offline evals and write evals/results/latest.json
npm run eval:check              # the CI gate: fresh run against the thresholds and the committed artifact
npm run eval -- --update-readme # also regenerate the eval table above
```

The test suite and the evals run entirely against the mock model, so CI needs no secrets, and the eval harness refuses to start if a provider key is in the environment.
CI has two jobs: `test` (type-check, tests, widget build) and `evals`.

## Project layout

| Path | What is there |
|---|---|
| `server/index.ts` | The Express app: chat (SSE), confirm and cancel, the operator API, error envelope, rate limits |
| `server/chat.ts` | The pipeline: retrieve, build prompt, run the model and read tools, stream, remember |
| `server/llm.ts` | Anthropic / OpenAI streaming with tool calls over plain `fetch`, and provider selection |
| `server/mock-llm.ts` | The offline mock model and its fixed tool policy |
| `server/tools.ts` | The three tools, their fixed access levels, and argument validation |
| `server/actions.ts` | Pending actions: propose, confirm once, cancel, expiry |
| `server/execute.ts` | Where a confirmed write takes effect; only the confirm route imports it |
| `server/backend.ts` | The seeded order book and the in-process ticket store |
| `server/handoff.ts` | Handoff records, the recap, and the operator token check |
| `server/protocol.ts` | The wire types shared with the widget |
| `server/rate-limit.ts` | The fixed-window limiter |
| `server/fence.ts` | Keeps untrusted text from closing a tagged prompt block |
| `server/deps.ts` | Builds the stores and limiters; the server, tests, and evals all start here |
| `server/memory.ts` | Token-budgeted memory, rolling summarization, session store |
| `server/retrieval.ts` | BM25 index with heading weighting |
| `server/trace.ts` | spanlight export with cost estimation and email scrubbing |
| `widget/` | React chat widget, built as one self-mounting IIFE bundle: action cards, tool chips, the handed-off state |
| `evals/` | The offline eval set, harness, thresholds, and the committed results |
| `tests/` | Unit and HTTP tests, plus the README and eval-gate checks |
| `docs/` | The demo knowledge base (also what the bot answers from) |

## License

MIT
