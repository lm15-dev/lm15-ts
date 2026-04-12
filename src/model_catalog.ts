/**
 * Model catalog — fetch model specs from models.dev.
 */

export interface ModelSpec {
  readonly id: string;
  readonly provider: string;
  readonly context_window: number | undefined;
  readonly max_output: number | undefined;
  readonly input_modalities: readonly string[];
  readonly output_modalities: readonly string[];
  readonly tool_call: boolean;
  readonly structured_output: boolean;
  readonly reasoning: boolean;
  readonly raw: Record<string, unknown>;
}

export async function fetchModelsDev(timeout = 20_000): Promise<ModelSpec[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch("https://models.dev/api.json", {
      headers: { "User-Agent": "lm15" },
      signal: controller.signal,
    });
    const data = await resp.json() as Record<string, unknown>;

    const out: ModelSpec[] = [];
    const providers = (data.providers ?? data) as Record<string, Record<string, unknown>>;

    for (const [providerId, providerPayload] of Object.entries(providers)) {
      if (typeof providerPayload !== "object" || providerPayload === null) continue;
      const models = providerPayload.models as Record<string, Record<string, unknown>> | undefined;
      if (!models) continue;

      for (const [modelId, m] of Object.entries(models)) {
        const limit = (m.limit ?? {}) as Record<string, unknown>;
        const modalities = (m.modalities ?? {}) as Record<string, unknown>;
        out.push({
          id: modelId,
          provider: providerId,
          context_window: limit.context as number | undefined,
          max_output: limit.output as number | undefined,
          input_modalities: (modalities.input ?? []) as string[],
          output_modalities: (modalities.output ?? []) as string[],
          tool_call: !!m.tool_call,
          structured_output: !!m.structured_output,
          reasoning: !!m.reasoning,
          raw: m,
        });
      }
    }

    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function buildProviderModelIndex(specs: ModelSpec[]): Map<string, Map<string, ModelSpec>> {
  const out = new Map<string, Map<string, ModelSpec>>();
  for (const s of specs) {
    let providerMap = out.get(s.provider);
    if (!providerMap) {
      providerMap = new Map();
      out.set(s.provider, providerMap);
    }
    providerMap.set(s.id, s);
  }
  return out;
}
