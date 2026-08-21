import { createDecorator } from '#/_base/di/instantiation';

import type {
  RlmCellAccess,
  RlmExecuteResult,
  RlmVariableInfo,
} from './sessionRlmKernelPool';
import type { ToolUpdate } from '#/tool/toolContract';

export interface AgentRlmExecuteOptions {
  readonly access: RlmCellAccess;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly onForegroundTaskStart?: (taskId: string) => void;
}

export interface IAgentRlmKernel {
  readonly _serviceBrand: undefined;
  execute(code: string, options: AgentRlmExecuteOptions): Promise<RlmExecuteResult>;
  state(signal?: AbortSignal): Promise<readonly RlmVariableInfo[]>;
  checkpoint(): Promise<void>;
}

export const IAgentRlmKernel = createDecorator<IAgentRlmKernel>('agentRlmKernel');
