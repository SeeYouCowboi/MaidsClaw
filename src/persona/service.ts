import {
  createReloadable,
  type ReloadableSnapshot,
  type ReloadResult,
} from "../config/reloadable.js";
import { DriftDetector, type DriftReport } from "./anti-drift.js";
import type { CharacterCard } from "./card-schema.js";
import { PersonaLoader } from "./loader.js";

type PersonaRegistrySnapshot = ReadonlyMap<string, CharacterCard>;

export type PersonaServiceSnapshot = {
  version: number;
  cards: PersonaRegistrySnapshot;
};

export class PersonaService {
  private readonly driftDetector: DriftDetector;
  private readonly loader: PersonaLoader;
  private registrySnapshot: ReloadableSnapshot<PersonaRegistrySnapshot>;

  constructor(options?: {
    loader?: PersonaLoader;
    driftDetector?: DriftDetector;
  }) {
    this.loader = options?.loader ?? new PersonaLoader();
    this.driftDetector = options?.driftDetector ?? new DriftDetector();
    this.registrySnapshot = this.createRegistryReloadable(new Map());
  }

  private createRegistryReloadable(
    initial: PersonaRegistrySnapshot,
  ): ReloadableSnapshot<PersonaRegistrySnapshot> {
    return createReloadable<PersonaRegistrySnapshot>({
      initial,
      load: async () => this.buildRegistrySnapshot(),
    });
  }

  private buildRegistrySnapshot(): PersonaRegistrySnapshot {
    const cards = this.loader.loadCards();
    const next = new Map<string, CharacterCard>();
    for (const card of cards) {
      next.set(card.id, card);
    }
    return next;
  }

  loadAll(): CharacterCard[] {
    const nextSnapshot = this.buildRegistrySnapshot();
    this.registrySnapshot = this.createRegistryReloadable(nextSnapshot);
    return [...nextSnapshot.values()];
  }

  reload(): Promise<ReloadResult<PersonaRegistrySnapshot>> {
    return this.registrySnapshot.reload();
  }

  getSnapshot(): PersonaServiceSnapshot {
    const snapshot = this.registrySnapshot.getSnapshot();
    return {
      version: snapshot.version,
      cards: snapshot.snapshot,
    };
  }

  getCard(cardId: string): CharacterCard | undefined {
    return this.registrySnapshot.get().get(cardId);
  }

  registerCard(card: CharacterCard): void {
    const nextSnapshot = new Map(this.registrySnapshot.get());
    nextSnapshot.set(card.id, card);
    this.registrySnapshot = this.createRegistryReloadable(nextSnapshot);
  }

  detectDrift(
    cardId: string,
    currentPersonaText: string,
  ): DriftReport | undefined {
    const card = this.getCard(cardId);
    if (!card) {
      return undefined;
    }

    return this.driftDetector.detectDrift(card, currentPersonaText);
  }
}
