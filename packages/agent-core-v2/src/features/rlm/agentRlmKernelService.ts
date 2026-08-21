import { Disposable } from '#/_base/di/lifecycle';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { Error2, ErrorCodes } from '#/errors';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { IAgentRlmHostBridge } from './agentRlmHostBridge';
import type { AgentRlmExecuteOptions, IAgentRlmKernel } from './agentRlmKernel';
import { IRlmPythonRuntime } from './rlmPythonRuntime';
import {
  ISessionRlmKernelPool,
  type RlmExecuteResult,
  type RlmKernelBinding,
  type RlmVariableInfo,
} from './sessionRlmKernelPool';

const MUTATING_HOST_REQUESTS = new Set(['task.run', 'task.stop']);

export class AgentRlmKernelService extends Disposable implements IAgentRlmKernel {
  declare readonly _serviceBrand: undefined;

  private tail: Promise<void> = Promise.resolve();

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionRlmKernelPool private readonly pool: ISessionRlmKernelPool,
    @IRlmPythonRuntime private readonly python: IRlmPythonRuntime,
    @IAgentRlmHostBridge private readonly hostBridge: IAgentRlmHostBridge,
  ) {
    super();
  }

  execute(code: string, options: AgentRlmExecuteOptions): Promise<RlmExecuteResult> {
    return this.serialize(async () =>
      this.pool.execute(await this.binding(), {
        code,
        access: options.access,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onUpdate: options.onUpdate,
        onHostRequest: (request, hostSignal) => {
          if (options.access === 'inspect' && MUTATING_HOST_REQUESTS.has(request.type)) {
            throw new Error2(
              ErrorCodes.RLM_PROTOCOL_ERROR,
              `RlmKernel inspect mode blocks ${request.type}.`,
            );
          }
          return this.hostBridge.handle(request, {
            turnId: options.turnId ?? 0,
            toolCallId: options.toolCallId ?? 'rlm-kernel',
            signal: hostSignal,
            onUpdate: options.onUpdate,
            onForegroundTaskStart: options.onForegroundTaskStart,
          });
        },
      }),
    );
  }

  state(signal?: AbortSignal): Promise<readonly RlmVariableInfo[]> {
    return this.serialize(async () => this.pool.state(await this.binding(), signal));
  }

  checkpoint(): Promise<void> {
    return this.serialize(() => this.pool.checkpoint(this.agent.agentId));
  }

  override dispose(): void {
    void this.pool.release(this.agent.agentId);
    super.dispose();
  }

  private async binding(): Promise<RlmKernelBinding> {
    const pythonCommand = await this.python.resolve();
    const lease = this.runtime.acquire(['process']);
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspace);
    return {
      agentId: this.agent.agentId,
      persistenceScope: this.agent.scope('rlm'),
      workDir: view.workDir,
      workspaceRoot: view.workDir,
      runtimeId: lease.runtime.identity.runtimeId,
      runtimeGeneration: lease.runtime.identity.generation,
      pythonCommand,
      lease,
    };
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
