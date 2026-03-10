import type { PersonaService } from "../../persona/service.js";
import type { PersonaDataSource } from "../prompt-data-sources.js";

export class PersonaAdapter implements PersonaDataSource {
  constructor(private readonly personaService: PersonaService) {}

  getSystemPrompt(personaId: string): string | undefined {
    const card = this.personaService.getCard(personaId);
    if (!card) {
      return undefined;
    }
    return card.systemPrompt ?? card.persona;
  }
}
