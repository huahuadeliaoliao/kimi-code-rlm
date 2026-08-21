import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTaskInfo } from '#/agent/task/task';
import type { ToolUpdate } from '#/tool/toolContract';

export interface RlmProcessTaskInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly description: string;
}

export interface IRlmProcessTaskLauncher {
  readonly _serviceBrand: undefined;
  run(
    input: RlmProcessTaskInput,
    options: {
      readonly signal: AbortSignal;
      readonly onUpdate?: (update: ToolUpdate) => void;
    },
  ): Promise<AgentTaskInfo>;
}

export const IRlmProcessTaskLauncher =
  createDecorator<IRlmProcessTaskLauncher>('rlmProcessTaskLauncher');
