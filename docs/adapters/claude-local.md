---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- Claude logged in with a subscription, **or** `ANTHROPIC_API_KEY` set in the agent's adapter config `env`

A bare `ANTHROPIC_API_KEY` in the host environment is deliberately **not** passed to agents — see [API key inheritance](#api-key-inheritance).

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login, and whether a host key is inherited)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness

## API key inheritance

`claude_local` runs the Claude CLI as a child process. The child inherits the
Paperclip server's environment, minus `ANTHROPIC_API_KEY`.

That one exclusion exists because the CLI treats a present `ANTHROPIC_API_KEY`
as "use API-key auth", which bills metered API credit rather than a Claude
subscription. A key added to the server environment for some unrelated
feature would therefore move **every** agent onto metered billing silently. In
September 2026 that is exactly what happened to this project's own fleet: a key
added for one feature ran the whole deployment's credit down in 31 hours and
every company's agents stopped (RK9-228).

So the choice is per agent:

| Where the key is set | What the agent uses |
|---|---|
| Agent's adapter config `env` | API-key auth (metered) |
| Host environment only | Subscription auth; the key is ignored |
| Host environment + `PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY=1` | API-key auth for every agent |

Use the opt-in when there is no interactive subscription login to use — a
container started with `-e ANTHROPIC_API_KEY=...` is the usual case. It is a
deployment-wide switch, so write down why it is on.

The "Test Environment" check reports which of the three cases applies.
