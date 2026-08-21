import { z } from 'zod';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { BashInputSchema } from '#/agent/tools/os/bash/bash';
import { TaskListInputSchema } from '#/agent/tools/task/task-list/task-list';
import { TaskOutputInputSchema } from '#/agent/tools/task/task-output/task-output';
import { TaskStopInputSchema } from '#/agent/tools/task/task-stop/task-stop';
import { Error2, ErrorCodes } from '#/errors';

import type { IAgentRlmHostBridge, RlmHostRequestContext } from './agentRlmHostBridge';
import { IRlmOutputStore } from './rlmOutputStore';
import { IRlmProcessTaskLauncher } from './rlmProcessTaskLauncher';
import type { RlmHostRequest } from './sessionRlmKernelPool';

const TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

const TaskWaitInputSchema = z.object({
  task_id: z.string().optional(),
  timeout: z.number().int().positive().max(86_400).default(600),
});

const OutputReadInputSchema = z.object({
  handle: z.string(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(256 * 1024).default(32 * 1024),
});

const OutputSearchInputSchema = z.object({
  handle: z.string(),
  pattern: z.string().min(1).max(1_000),
  max_matches: z.number().int().positive().max(200).default(50),
});

function hostRequestError(message: string, details?: Record<string, unknown>): Error2 {
  return new Error2(ErrorCodes.RLM_PROTOCOL_ERROR, message, { details });
}

function taskToWire(info: AgentTaskInfo): Record<string, unknown> {
  const value = info as AgentTaskInfo & Record<string, unknown>;
  const {
    taskId: _taskId,
    startedAt: _startedAt,
    endedAt: _endedAt,
    stopReason: _stopReason,
    timeoutMs: _timeoutMs,
    ...rest
  } = value;
  return {
    ...rest,
    task_id: info.taskId,
    started_at: info.startedAt,
    ended_at: info.endedAt,
    stop_reason: info.stopReason,
    timeout_ms: info.timeoutMs,
  };
}

export class AgentRlmHostBridgeService implements IAgentRlmHostBridge {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IRlmProcessTaskLauncher private readonly processTasks: IRlmProcessTaskLauncher,
    @IRlmOutputStore private readonly outputs: IRlmOutputStore,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  async handle(request: RlmHostRequest, context: RlmHostRequestContext): Promise<unknown> {
    switch (request.type) {
      case 'task.run': {
        const parsed = BashInputSchema.safeParse({
          command: request.payload['command'],
          cwd: request.payload['cwd'] ?? undefined,
          timeout: request.payload['timeout'],
          description: request.payload['description'],
          run_in_background: true,
          disable_timeout: request.payload['disable_timeout'],
        });
        if (!parsed.success || parsed.data.description?.trim().length === 0) {
          throw hostRequestError('Invalid rlm.task.run request.');
        }
        const info = await this.processTasks.run(
          {
            command: parsed.data.command,
            cwd: parsed.data.cwd,
            timeoutMs: parsed.data.disable_timeout
              ? undefined
              : (parsed.data.timeout ?? 600) * 1000,
            description: parsed.data.description!.trim(),
          },
          context,
        );
        return taskToWire(info);
      }
      case 'task.list': {
        const parsed = TaskListInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.task.list request.');
        return this.tasks
          .list(parsed.data.active_only, parsed.data.limit)
          .map((info) => taskToWire(info));
      }
      case 'task.output': {
        const parsed = TaskOutputInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.task.output request.');
        return this.taskOutput(parsed.data.task_id);
      }
      case 'task.wait': {
        const parsed = TaskWaitInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.task.wait request.');
        return this.waitForTask(parsed.data.task_id, parsed.data.timeout * 1000, context.signal);
      }
      case 'task.stop': {
        const parsed = TaskStopInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.task.stop request.');
        const info = await this.tasks.stop(parsed.data.task_id, parsed.data.reason);
        if (info === undefined) throw hostRequestError(`Task not found: ${parsed.data.task_id}`);
        return taskToWire(info);
      }
      case 'output.read': {
        const parsed = OutputReadInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.output.read request.');
        return this.outputs.read(
          this.agent.agentId,
          parsed.data.handle,
          parsed.data.offset,
          parsed.data.limit,
        );
      }
      case 'output.search': {
        const parsed = OutputSearchInputSchema.safeParse(request.payload);
        if (!parsed.success) throw hostRequestError('Invalid rlm.output.search request.');
        return this.outputs.search(
          this.agent.agentId,
          parsed.data.handle,
          parsed.data.pattern,
          parsed.data.max_matches,
        );
      }
      default:
        throw hostRequestError('Unknown RLM host request.', { type: request.type });
    }
  }

  private async taskOutput(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.getTask(taskId);
    if (task === undefined) throw hostRequestError(`Task not found: ${taskId}`);
    const output = await this.tasks.getOutputSnapshot(taskId, TASK_OUTPUT_PREVIEW_BYTES);
    const reference = output.fullOutputAvailable
      ? await this.outputs.save(
          this.agent.agentId,
          await this.tasks.readOutput(taskId),
          false,
        )
      : undefined;
    return {
      task: taskToWire(task),
      output: output.preview,
      output_handle: reference?.handle,
      output_size_bytes: output.outputSizeBytes,
      output_preview_bytes: output.previewBytes,
      output_truncated: output.truncated,
      full_output_available: output.fullOutputAvailable,
    };
  }

  private async waitForTask(
    taskId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    let task: AgentTaskInfo | undefined;
    if (taskId !== undefined) {
      if (this.tasks.getTask(taskId) === undefined) throw hostRequestError(`Task not found: ${taskId}`);
      task = await this.tasks.wait(taskId, timeoutMs, signal);
    } else {
      const running = this.tasks.list(true);
      if (running.length === 0) {
        return { wait_status: 'no_tasks', waited_ms: 0, timeout_ms: timeoutMs };
      }
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        task = await Promise.race(
          running.map((candidate) => this.tasks.wait(candidate.taskId, timeoutMs, controller.signal)),
        );
      } finally {
        signal.removeEventListener('abort', abort);
        controller.abort();
      }
    }
    if (task === undefined) throw hostRequestError(`Task not found: ${taskId ?? ''}`);
    const terminal = task.status !== 'running';
    if (terminal) {
      this.tasks.markTasksDeliveredViaWait([{ taskId: task.taskId, status: task.status }]);
    }
    return {
      wait_status: terminal ? 'completed' : 'timed_out',
      waited_ms: Date.now() - startedAt,
      timeout_ms: timeoutMs,
      ...(await this.taskOutput(task.taskId)),
    };
  }
}
