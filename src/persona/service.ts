import { DriftDetector, type DriftReport } from "./anti-drift.js";
import type { CharacterCard } from "./card-schema.js";
import { PersonaLoader } from "./loader.js";

export class PersonaService {
  private readonly registry: Map<string, CharacterCard> = new Map();
  private readonly driftDetector: DriftDetector;
  private readonly loader: PersonaLoader;

  constructor(options?: { loader?: PersonaLoader; driftDetector?: DriftDetector }) {
    this.loader = options?.loader ?? new PersonaLoader();
    this.driftDetector = options?.driftDetector ?? new DriftDetector();
  }

  loadAll(): CharacterCard[] {
    this.registry.clear();

    const cards = this.loader.loadCards();
    for (const card of cards) {
      this.registry.set(card.id, card);
    }

    return cards;
  }

  getCard(cardId: string): CharacterCard | undefined {
    return this.registry.get(cardId);
  }

  registerCard(card: CharacterCard): void {
    this.registry.set(card.id, card);
  }

  detectDrift(cardId: string, currentPersonaText: string): DriftReport | undefined {
    const card = this.getCard(cardId);
    if (!card) {
      return undefined;
    }

    return this.driftDetector.detectDrift(card, currentPersonaText);
  }
}
