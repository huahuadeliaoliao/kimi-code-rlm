import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import type {
  IRlmProcessTaskLauncher,
  RlmProcessTaskInput,
} from './rlmProcessTaskLauncher';

export class RlmProcessTaskLauncherService implements IRlmProcessTaskLauncher {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  async run(
    input: RlmProcessTaskInput,
    options: { readonly signal: AbortSignal },
  ): Promise<AgentTaskInfo> {
    options.signal.throwIfAborted();
    const lease = this.runtime.acquire(['process']);
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspace);
    const environment = lease.runtime.environment;
    const cwd = view.resolve(input.cwd ?? view.workDir);
    let child: IHostProcess;
    try {
      child = lease.track(
        await lease.runtime.process!.spawn(environment.shellPath, ['-c', input.command], {
          cwd,
          env: {
            NO_COLOR: '1',
            TERM: 'dumb',
            GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
            SHELL: environment.shellPath,
          },
        }),
      );
      child.stdin.end();
    } catch (error) {
      lease.dispose();
      throw error;
    }

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(
          child,
          input.command,
          input.description,
          undefined,
          () => {
            lease.dispose();
          },
        ),
        {
          detached: true,
          timeoutMs: input.timeoutMs,
        },
      );
    } catch (error) {
      await child.kill('SIGKILL').catch(() => undefined);
      lease.dispose();
      throw error;
    }
    const info = this.tasks.getTask(taskId);
    if (info === undefined) {
      await this.tasks.stop(taskId, 'RLM task registration failed');
      throw new Error(`RLM task was not registered: ${taskId}`);
    }
    return info;
  }
}
