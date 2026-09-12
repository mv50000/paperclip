# Knowledge recall: qmd-mcp daemon path (RK9-186)

`server/src/services/knowledge-recall.ts` now tries the warm `qmd-mcp` daemon
(`qmd-mcp.service`, Streamable-HTTP MCP at `[::1]:8181/mcp`) before falling
back to spawning the `qmd` CLI. The client lives in
`server/src/services/qmd-mcp-client.ts`.

## Why

The CLI path cold-starts a `qmd vsearch` process per request, loading the
~300MB embedding model from scratch every time. Under load (or during a `qmd
embed` reindex) that alone can exceed the caller's HTTP timeout before any
search starts (measured: 23s timeouts, 0 hits, at load 4-14). The daemon keeps
the model resident; a warm call is ~0.5-1s.

## Things that look like bugs but are deliberate

- **`rerank:false` is mandatory on every daemon call.** Production
  measurement (2026-09-12): with `rerank:false`, a cold query after a 5+
  minute idle gap took ~3s and a warm one ~0.5s — both well inside the
  recall latency budget. With reranking on, the FIRST call alone took
  106.7s (loading the separate rerank model). There is no configuration to
  turn reranking back on for this feature.
- **Keepwarm exists but defaults to OFF** (`PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS`,
  default `0`). It was originally planned as a required mitigation for the
  daemon's model-unload timeout, but the `rerank:false` measurement above
  showed a cold call already meets the AC on its own — keepwarm would just be
  unattended background load. Left as an env-tunable escape hatch, not wired
  on by default.
- **On daemon success, the CLI BM25 (`qmd search`) pass is skipped
  entirely** — the daemon's `query` tool call already runs both a `lex` and a
  `vec` search in one round trip and returns one fused list. Running BM25
  again via the CLI would just repeat the same keyword search for no new
  results (measured ~0.5-0.7s wasted + one more process per recall). The CLI
  BM25+vsearch pair only runs when the daemon is unavailable.
- **The MCP session is a single, process-lifetime cache, not per-request.**
  A stale/expired session is only reinitialized after a genuine *protocol*
  failure (a JSON-RPC `error`, a bad `initialize` response, a parse error) —
  never on an abort or our own timeout firing. Clearing it on every
  disconnected/slow request would recreate the daemon-side session leak this
  design exists to avoid (observed: 387 active sessions before this fix).
  Concurrent callers racing to establish the first session share one
  in-flight `initialize()` promise instead of each opening their own.
- **A tool-level failure looks like success unless you check `isError`.**
  MCP distinguishes a protocol-level failure (top-level JSON-RPC `error`)
  from a *tool*-level one: a normal JSON-RPC result whose payload has
  `isError: true` and no `structuredContent` (verified against the real
  daemon: a malformed `collections` argument answers this way). Reading that
  as "0 results" instead of "the call failed" would silently return an empty
  recall — the exact symptom this ticket exists to fix, just moved one layer
  up. `queryQmdDaemon` treats `isError` as a failure and returns `null` so
  the caller falls back to the CLI.
- **`collections` must never be omitted from a daemon `query` call.**
  Omitting it makes the daemon search its entire index, including the
  operator's personal vault (`personal`, `personal-sensitive`). This module
  never computes or widens that list itself — it only ever forwards the
  already-filtered, non-personal scope `knowledge-recall.ts` computes for the
  CLI path (see `PERSONAL_COLLECTION_RE` there).

## Protocol/safety model

Ported from `/home/rk9admin/vault-mcp/server.js`, the existing running client
for the same daemon: same SSE-or-plain-JSON response parsing, same
`initialize` → `notifications/initialized` → `tools/call` handshake, same
personal-vault exclusion contract.
