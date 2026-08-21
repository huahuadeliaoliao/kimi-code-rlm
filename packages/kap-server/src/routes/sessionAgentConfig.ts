import {
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentProfileService,
  resumeSessionById,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigPartial } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

export async function applySessionAgentConfig(
  core: Scope,
  sessionId: string,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  if (agentConfig.plan_mode === true) {
    throw new Error2(
      ErrorCodes.SESSION_PLAN_MODE_INVALID,
      'Plan mode is disabled in this local RLM build.',
    );
  }
  if (agentConfig.swarm_mode === true) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Swarm mode is disabled in this local single-agent RLM build.',
    );
  }
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  if (agentConfig.model !== undefined && agentConfig.model !== '') {
    await profile.setModel(agentConfig.model);
  }
  if (agentConfig.thinking !== undefined) {
    profile.setThinking(agentConfig.thinking);
  }
  if (agentConfig.permission_mode !== undefined) {
    agent.accessor
      .get(IAgentLifecycleService)
      .broadcastPermissionMode(agentConfig.permission_mode as PermissionMode);
  }
  if (agentConfig.goal_objective !== undefined) {
    await agent.accessor.get(IAgentGoalService).createGoal({ objective: agentConfig.goal_objective });
  }
  if (agentConfig.goal_control !== undefined) {
    const goal = agent.accessor.get(IAgentGoalService);
    switch (agentConfig.goal_control) {
      case 'pause':
        await goal.pauseGoal({});
        break;
      case 'resume':
        await goal.resumeGoal({ continueIfPaused: true, continueIfBlocked: true });
        break;
      case 'cancel':
        await goal.cancelGoal({});
        break;
    }
  }
}
