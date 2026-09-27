// --- RK9 Custom (RK9-228): whole file is fork-only. Upstream has no equivalent; see doc/upgrade/acpx-claude-local.md ---
/**
 * What the Claude CLI inherits from the Paperclip server process.
 *
 * `claude_local` runs the CLI as a child process, so by default the child would
 * see every variable the server has. For one variable that default is wrong.
 *
 * The CLI treats a present `ANTHROPIC_API_KEY` as "use API-key auth", which
 * bills metered API credit instead of a Claude subscription. So a key added to
 * the server environment for some unrelated feature moves *every* agent onto
 * metered billing, silently and all at once. On 2026-09-13 a key added for
 * outreach drafting did exactly that to this project's own fleet: $19.72 over
 * 38 runs in 31 hours, and when the credit ran out every company's agents
 * stopped for a day and a half before anyone noticed (RK9-228).
 *
 * The rule that came out of it: API-key auth is a per-agent choice. An agent
 * that wants it sets `adapter_config.env.ANTHROPIC_API_KEY`, which is merged on
 * top of the inherited environment and still wins.
 */
const HOST_ENV_KEYS_NOT_INHERITED = ["ANTHROPIC_API_KEY"] as const;

/**
 * Opt-in escape hatch for deployments with no other way to pass credentials —
 * a container with no interactive subscription login, where
 * `-e ANTHROPIC_API_KEY=...` is the documented setup (see `doc/DOCKER.md`).
 * It restores inheritance for every agent, so it is a deployment-wide decision.
 */
export const INHERIT_OPT_IN_ENV_KEY = "PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY";

export function inheritsHostAnthropicApiKey(
  hostEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = hostEnv[INHERIT_OPT_IN_ENV_KEY];
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** The host environment as agents are allowed to see it. */
export function inheritableHostEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...hostEnv };
  if (inheritsHostAnthropicApiKey(hostEnv)) return inherited;
  for (const key of HOST_ENV_KEYS_NOT_INHERITED) delete inherited[key];
  return inherited;
}

/**
 * The environment the Claude CLI actually runs with: the inheritable host
 * environment with the agent's own adapter config layered on top.
 */
export function resolveClaudeEffectiveEnv(
  adapterEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...inheritableHostEnv(hostEnv), ...adapterEnv }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * The keys to pass as `doNotInheritEnvKeys` when spawning the CLI.
 *
 * This is the one that actually matters at runtime: `runChildProcess` builds the
 * child environment itself (`{ ...sanitizeInheritedPaperclipEnv(process.env),
 * ...opts.env }`), so filtering `process.env` here in the adapter is not enough
 * — the spawn helper has to be told which keys the host may not contribute.
 */
export function hostEnvKeysNotInherited(
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return inheritsHostAnthropicApiKey(hostEnv) ? [] : [...HOST_ENV_KEYS_NOT_INHERITED];
}

/**
 * Why the ACP engine may not start on this server, or null when it may.
 *
 * The ACP engine (`adapter-utils/src/acpx-engine`) starts the agent with the
 * whole server environment and ignores `doNotInheritEnvKeys`, so it would hand
 * a server-wide `ANTHROPIC_API_KEY` to every ACP run (RK9-228). Until the guard
 * is ported into the engine itself, ACP runs refuse to start while such a key is
 * present and the deployment has not opted in. This replaces the acpx_local
 * guard (RK9-312): upstream retired acpx_local in v2026.720.0 and migration 0136
 * moved its agents to claude_local with `engine: "acp"`.
 */
export function acpHostKeyBlockReason(
  hostEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const present = hostEnvKeysNotInherited(hostEnv).filter((key) => {
    const value = hostEnv[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (present.length === 0) return null;
  return (
    `The Claude ACP engine is disabled on this server: it passes the whole server environment ` +
    `to the agent, including ${present.join(", ")}, which would bill runs against metered API credit ` +
    `(RK9-228). Set engine=cli, or remove the key from the server environment.`
  );
}
