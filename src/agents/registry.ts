// Agent registry — in-memory registry of AgentProfiles

import type { AgentProfile } from "./profile.js";
import { MaidsClawError } from "../core/errors.js";

export class AgentRegistry {
  private readonly agents: Map<string, AgentProfile> = new Map();

  /** Register an agent profile. Throws AGENT_ALREADY_REGISTERED if id already exists. */
  register(profile: AgentProfile): void {
    if (this.agents.has(profile.id)) {
      throw new MaidsClawError({
        code: "AGENT_ALREADY_REGISTERED",
        message: `Agent "${profile.id}" is already registered`,
        retriable: false,
        details: { agentId: profile.id },
      });
    }
    this.agents.set(profile.id, profile);
  }

  /** Unregister an agent by id. Throws AGENT_NOT_FOUND if id doesn't exist. */
  unregister(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new MaidsClawError({
        code: "AGENT_NOT_FOUND",
        message: `Agent "${agentId}" is not registered`,
        retriable: false,
        details: { agentId },
      });
    }
    this.agents.delete(agentId);
  }

  /** Get an agent profile by id. Returns undefined if not found. */
  get(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  /** Get all registered agent profiles. */
  getAll(): AgentProfile[] {
    return Array.from(this.agents.values());
  }

  /** Check if an agent is registered. */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }
}
