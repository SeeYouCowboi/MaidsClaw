import type { AgentProfile } from "../../agents/profile.js";
import { getThinkerModelId } from "../../agents/profile.js";

export interface ModelRouter {
  route(agentProfile: AgentProfile): string;
}

export class StaticRouter implements ModelRouter {
  route(agentProfile: AgentProfile): string {
    return getThinkerModelId(agentProfile);
  }
}
