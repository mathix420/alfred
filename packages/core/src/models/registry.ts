/**
 * Model identity in Alfred is a single string: `"<provider>/<model>"`.
 *
 *   "anthropic/claude-opus-4-8"
 *   "mistral/mistral-large-latest"
 *   "local/llama3.1:8b"           (served by any OpenAI-compatible endpoint)
 *
 * Everything downstream (provider resolution, config, app code) speaks this
 * string, so adding a provider means extending `PROVIDERS` + the switch in
 * `./providers.ts` — nothing else needs to know the difference.
 */

export const PROVIDERS = ["anthropic", "mistral", "local"] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export interface ParsedModelId {
  provider: ProviderName;
  /** Provider-specific model name; may itself contain slashes (e.g. local). */
  model: string;
}

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function parseModelId(id: string): ParsedModelId {
  const slash = id.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid model id "${id}": expected "<provider>/<model>".`);
  }

  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);

  if (!isProviderName(provider)) {
    throw new Error(`Unknown provider "${provider}" in "${id}". Known: ${PROVIDERS.join(", ")}.`);
  }
  if (model.length === 0) {
    throw new Error(`Missing model name in "${id}".`);
  }

  return { provider, model };
}
