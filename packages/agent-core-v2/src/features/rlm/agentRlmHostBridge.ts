import { createDecorator } from '#/_base/di/instantiation';
import type { RlmHostRequest } from './sessionRlmKernelPool';
import type { ToolUpdate } from '#/tool/toolContract';

export interface RlmHostRequestContext {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly onForegroundTaskStart?: (taskId: string) => void;
}

export interface IAgentRlmHostBridge {
  readonly _serviceBrand: undefined;
  handle(request: RlmHostRequest, context: RlmHostRequestContext): Promise<unknown>;
}

export const IAgentRlmHostBridge =
  createDecorator<IAgentRlmHostBridge>('agentRlmHostBridge');
