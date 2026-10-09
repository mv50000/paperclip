# qmd-mcp daemon monitoring (RK9-369, RK9-371)

The `qmd-mcp` daemon on CT 364 (`192.168.1.64:8181`) serves recall. When it is down, recall falls back to a cold
`qmd` CLI start (~93 s instead of <1 s). Two layers watch it.

## Layer 1: the Paperclip server (inside the app)

- `probeQmdDaemon` runs every 60 s and only when `QMD_MCP_URL` is set. It sends a vec-only query to the `rk9`
  collection and requires at least one hit (RK9-463). A lex+vec query is not enough: qmd swallows embedding-model
  load and embed errors (`embedBatch` returns null embeddings) and `structuredSearch` skips the vec search without
  an error, so the tool returns a lex-only result without `isError`. A vec-only query has no lex fallback and returns
  zero rows when the model is broken. Zero hits, a tool-level `isError` result and a vec timeout all count as failures.
- After `PAPERCLIP_QMD_ALERT_THRESHOLD` (default 3) consecutive failures the server logs
  `qmd-mcp daemon DOWN` at ERROR, then again on every 10th failure.
- `GET /api/knowledge/qmd-status` (instance admin) returns 200 when healthy and 503 when not.
- A failing call discards its MCP session and now sends `DELETE` for it. Before that, every failing probe left
  two sessions open on the daemon.
- Shutdown stops the probe before `closeQmdMcpSession()`.

## Layer 2: Prometheus on skynet (CT 342)

A TCP probe sees the daemon port only. It does not see vec faults, including a model that failed to load; layer 1 covers those.

Versioned sources, because skynet's `/opt/prometheus` is not a git repo:

| File | Goes to |
|---|---|
| `infra/prometheus/qmd-mcp-blackbox-module.yml` | `modules:` in `/opt/prometheus/blackbox.yml` |
| `infra/prometheus/qmd-mcp-scrape.yml` | `scrape_configs:` in `/opt/prometheus/prometheus.yml` |
| `infra/prometheus/qmd-mcp-alert-rules.yml` | rule group appended to `/opt/prometheus/alert_rules.yml` (indent 2, drop `groups:`) |
| `infra/prometheus/qmd-mcp-alert-rules.test.yml` | `promtool test rules` only |

The rule `QmdMcpDaemonDown` fires after the probe has failed for 5 minutes (`severity: warning`, so it routes
Alertmanager -> rk9claude -> Telegram). Its annotation tells rk9claude to diagnose only and never to restart
`qmd-mcp` or CT 364.

### Apply (skynet, as rk9admin with sudo)

1. Back up: `sudo cp -p <file> <file>.bak-$(date -u +%Y%m%d-%H%M)-rk9-371` for the three files.
2. Append the three snippets above.
3. Validate: `sudo docker exec prometheus promtool check config /etc/prometheus/prometheus.yml`.
4. Reload blackbox (`sudo docker restart blackbox`) and Prometheus (`curl -X POST http://100.64.23.47:9090/-/reload`).
5. Verify collection:
   `curl -s --data-urlencode 'query=probe_success{job="blackbox-qmd"}' http://100.64.23.47:9090/api/v1/query` returns 1.

### Verify the rule

```
docker cp infra/prometheus/qmd-mcp-alert-rules.yml infra/prometheus/qmd-mcp-alert-rules.test.yml prometheus:/tmp/
docker exec -w /tmp prometheus promtool test rules qmd-mcp-alert-rules.test.yml
```

Run on 2026-10-09: SUCCESS. The skynet apply (steps 1-5) was not done by the agent that wrote this note: the
harness denied remote writes to skynet. See `rk9/areas/operator_todo.md` in the vault.

## Open follow-ups (RK9-463, not done)

- A JSON-RPC error unrelated to the session (e.g. -32603) discards the shared session and makes a parallel recall retry.
- `stop()` of the probe does not wait for a running probe, so it can open a session after `closeQmdMcpSession()`.
- The 60 s vec probe keeps the embedding model loaded on CT 364, unlike the deliberately disabled keepwarm. Review the interval.
- Skynet `/opt/prometheus/alert_rules.yml` needs the new `QmdMcpDaemonDown` annotation from
  `infra/prometheus/qmd-mcp-alert-rules.yml` (parent applies; agents cannot write to skynet).
