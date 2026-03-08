import type { AgentProfile } from "../../agents/profile.js";

export interface ModelRouter {
  route(agentProfile: AgentProfile): string;
}

export class StaticRouter implements ModelRouter {
  route(agentProfile: AgentProfile): string {
    return agentProfile.modelId;
  }
}
