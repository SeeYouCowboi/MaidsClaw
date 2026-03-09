import { resolveProviderCredential } from "../../config.js";
import type { AuthConfig } from "../../config-schema.js";
import type { ProviderCatalogEntry } from "../provider-types.js";

export class SelectionPolicyGuard {
  constructor(private readonly providers: ProviderCatalogEntry[]) {}

  isEligibleForAutoDefault(providerId: string): boolean {
    const provider = this.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      return false;
    }
    return provider.riskTier !== "experimental";
  }

  isEligibleForAutoFallback(providerId: string): boolean {
    const provider = this.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      return false;
    }
    return provider.riskTier !== "experimental";
  }

  getDiscoverableProviders(auth: AuthConfig | undefined): ProviderCatalogEntry[] {
    return this.providers.filter((provider) => this.hasCredential(provider.id, auth));
  }

  getAutoSelectableProviders(auth: AuthConfig | undefined): ProviderCatalogEntry[] {
    return this.providers.filter((provider) => {
      if (!this.hasCredential(provider.id, auth)) {
        return false;
      }
      return this.isEligibleForAutoDefault(provider.id) && this.isEligibleForAutoFallback(provider.id);
    });
  }

  private hasCredential(providerId: string, auth: AuthConfig | undefined): boolean {
    const resolved = resolveProviderCredential(providerId, auth ?? { credentials: [] });
    return resolved !== null;
  }
}
