import type { StashProviderFactory } from "./stash-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const providers = new Map<string, StashProviderFactory>();

export function registerStashProvider(type: string, factory: StashProviderFactory): void {
  providers.set(type, factory);
}

export function resolveStashProviderFactory(type: string): StashProviderFactory | null {
  return providers.get(type) ?? null;
}
