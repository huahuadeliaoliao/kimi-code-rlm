import { IAgentRlmKernel } from '#/features/rlm/agentRlmKernel';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import description from './rlm-kernel.md?raw';
import {
  IRlmKernelTool,
  RLM_DEFAULT_TIMEOUT_S,
  RlmKernelInputSchema,
  type ResolvedRlmKernelInput,
  type RlmKernelInput,
} from './rlm-kernel';

const MS_PER_SECOND = 1000;

function summarizePaths(label: string, paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const visible = paths.slice(0, 20);
  const suffix = paths.length > visible.length ? `\n- … and ${String(paths.length - visible.length)} more` : '';
  return `${label}:\n${visible.map((path) => `- ${path}`).join('\n')}${suffix}`;
}

export class RlmKernelTool implements IRlmKernelTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RlmKernel' as const;
  readonly description = description;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RlmKernelInputSchema);

  constructor(
    @IAgentRlmKernel private readonly kernel: IAgentRlmKernel,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  resolveExecution(input: RlmKernelInput): ToolExecution {
    const resolved = RlmKernelInputSchema.parse(input);
    const firstLine = resolved.code.trim().split(/\r?\n/, 1)[0] ?? '';
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    return {
      description: preview.length > 0 ? `Python: ${preview}` : 'Executing Python',
      display: {
        kind: 'generic',
        summary: `${resolved.access === 'inspect' ? 'Inspect' : 'Work'} in persistent Python`,
        detail: { code: resolved.code },
      },
      approvalRule: literalRulePattern(this.name, resolved.access),
      accesses:
        resolved.access === 'inspect'
          ? ToolAccesses.readTree(this.workspace.workDir)
          : ToolAccesses.all(),
      execute: (context) => this.execute(resolved, context),
    };
  }

  private async execute(
    input: ResolvedRlmKernelInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.kernel.execute(input.code, {
        access: input.access,
        timeoutMs: (input.timeout ?? RLM_DEFAULT_TIMEOUT_S) * MS_PER_SECOND,
        signal: context.signal,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        onUpdate: context.onUpdate,
        onForegroundTaskStart: context.onForegroundTaskStart,
      });
      const details = [
        result.outputReference === undefined
          ? undefined
          : `output_handle: ${result.outputReference.handle}\noutput_bytes: ${String(result.outputReference.bytes)}\noutput_truncated: ${String(result.outputReference.truncated)}\nfull_output_available: true`,
        result.checkpointGeneration === undefined
          ? undefined
          : `checkpoint_generation: ${String(result.checkpointGeneration)}`,
        result.state.length === 0
          ? 'namespace: empty'
          : `namespace: ${result.state
              .slice(0, 50)
              .map((variable) => variable.name)
              .join(', ')}${result.state.length > 50 ? `, … and ${String(result.state.length - 50)} more` : ''}`,
        summarizePaths('files_written', result.effects.filesWritten),
        summarizePaths('files_deleted', result.effects.filesDeleted),
        result.effects.subprocessStarted ? 'subprocess_started: true' : undefined,
        result.effects.lingeringThreads.length > 0
          ? `warning: live background threads: ${result.effects.lingeringThreads.join(', ')}`
          : undefined,
        result.checkpointSkipped !== undefined && result.checkpointSkipped.length > 0
          ? `checkpoint_skipped: ${result.checkpointSkipped
              .slice(0, 20)
              .map((item) => `${item.name} (${item.reason})`)
              .join(', ')}`
          : undefined,
      ].filter((line): line is string => line !== undefined);
      const output = details.length > 0
        ? `${result.output}\n\n<rlm-state>\n${details.join('\n')}\n</rlm-state>`
        : result.output;
      return { output, isError: result.isError };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      return {
        output:
          code === 'rlm.execution_aborted'
            ? `${message}\nExternal file, process, network, or remote side effects may already have occurred and were not rolled back. Inspect the workspace and task list before retrying.`
            : message,
        isError: true,
      };
    }
  }
}
