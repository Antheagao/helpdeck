# Retrieval

## BM25, not embeddings

helpdeck ranks documentation passages with BM25, implemented from scratch in the repository - no embeddings, no vector database, no retrieval API calls.
For a support bot over a product's documentation (tens to hundreds of passages), lexical ranking finds the right section reliably and runs anywhere, including fully offline.

## How passages are built

Every markdown file in the docs directory is split on its headings; each section becomes one passage with its source file and heading kept for citations.
The index is rebuilt on startup, so updating the knowledge base is just editing markdown and restarting.

## Citations

The top passages are placed in the prompt numbered [1] through [4], and the model is instructed to cite them.
The widget shows the cited sections under each answer so users can verify where an answer came from.
