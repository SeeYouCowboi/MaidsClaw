import type { PersonaService } from "../../persona/service.js";
import type { PersonaDataSource } from "../prompt-data-sources.js";

export class PersonaAdapter implements PersonaDataSource {
  constructor(private readonly personaService: PersonaService) {}

  getSystemPrompt(personaId: string): string | undefined {
    const card = this.personaService.getCard(personaId);
    if (!card) {
      return undefined;
    }

    let prompt = card.systemPrompt ?? card.persona;

    if (card.hiddenTasks && card.hiddenTasks.length > 0) {
      const taskList = card.hiddenTasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
      prompt += `\n\n<hidden_objectives>\n${taskList}\n</hidden_objectives>`;
    }

    if (card.privatePersona) {
      prompt += `\n\n<private_persona>\n${card.privatePersona}\n</private_persona>`;
    }

    return prompt;
  }
}
