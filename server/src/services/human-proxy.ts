export const HUMAN_PROXY_ADAPTER_TYPE = "human_proxy" as const;

export function isHumanProxyAgent(
  agent: { adapterType?: string | null } | null | undefined,
): boolean {
  return agent?.adapterType === HUMAN_PROXY_ADAPTER_TYPE;
}
