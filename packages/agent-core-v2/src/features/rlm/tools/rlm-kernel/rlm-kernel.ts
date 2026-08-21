import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const RLM_DEFAULT_TIMEOUT_S = 300;
export const RLM_MAX_TIMEOUT_S = 300;

export const RlmKernelInputSchema = z.object({
  code: z
    .string()
    .min(1, 'Python code cannot be empty.')
    .max(100_000, 'Python code cannot exceed 100,000 characters.')
    .describe('Python code to execute in the persistent RLM kernel.'),
  access: z
    .enum(['inspect', 'work'])
    .default('inspect')
    .describe(
      'Use inspect for read-only Python without subprocesses. Use work when the cell may write files or start subprocesses.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .max(RLM_MAX_TIMEOUT_S)
    .default(RLM_DEFAULT_TIMEOUT_S)
    .optional()
    .describe('Cell timeout in seconds.'),
});

export type RlmKernelInput = z.input<typeof RlmKernelInputSchema>;
export type ResolvedRlmKernelInput = z.output<typeof RlmKernelInputSchema>;

export interface IRlmKernelTool extends AgentTool<RlmKernelInput> {
  readonly _serviceBrand: undefined;
}

export const IRlmKernelTool = createDecorator<IRlmKernelTool>('rlmKernelTool');
