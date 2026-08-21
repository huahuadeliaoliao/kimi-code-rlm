import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { bootstrap, logSeed, resolveLoggingConfig } from '#/index';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentRlmKernel } from '#/features/rlm/agentRlmKernel';
import { RLM_PYTHON_WORKER } from '#/features/rlm/pythonWorker';
import { ISessionRlmKernelPool } from '#/features/rlm/sessionRlmKernelPool';
import { RlmKernelInputSchema } from '#/features/rlm/tools/rlm-kernel/rlm-kernel';

const roots: string[] = [];
const apps: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const app of apps.splice(0).toReversed()) app.dispose();
  for (const root of roots.splice(0).toReversed()) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createHarness(): Promise<{
  readonly root: string;
  readonly sessionId: string;
  readonly agent: Awaited<ReturnType<typeof ensureMainAgent>>;
  readonly session: ISessionScopeHandle;
  readonly manager: ISessionManager;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-rlm-test-'));
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  roots.push(root);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(
    join(homeDir, 'config.toml'),
    'defaultModel = "fake"\n\n[models.fake]\nname = "fake-model"\nprotocol = "openai"\nbaseUrl = "http://localhost"\napiKey = "test-token"\nmaxContextSize = 400000\ncapabilities = ["image_in"]\n',
  );
  const { app } = bootstrap(
    {
      homeDir,
      cwd: workDir,
      clientIdentity: {
        productName: 'kimi-rlm-test',
        version: '0.0.0',
        platform: 'kimi_code_cli',
      },
    },
    [...logSeed(resolveLoggingConfig({ homeDir, env: process.env }))],
  );
  apps.push(app);
  const manager = app.accessor.get(ISessionManager);
  const session = await manager.create({
    workDir,
    mainAgentBinding: { profile: 'agent', model: 'fake' },
  });
  const agent = await ensureMainAgent(session);
  return { root, sessionId: session.id, agent, session, manager };
}

describe('RLM feature', () => {
  it('keeps the default model prompt and tool surface compact and internally consistent', async () => {
    const { agent } = await createHarness();
    await agent.accessor.get(IAgentToolActivationService).activate();
    const profile = agent.accessor.get(IAgentProfileService).data();
    const policy = agent.accessor.get(IAgentToolPolicyService);
    const registry = agent.accessor.get(IAgentToolRegistryService);
    const tools = registry
      .list()
      .filter((entry) => policy.isToolActive(entry.name, entry.source))
      .map((entry) => registry.resolve(entry.name)!)
      .sort((a, b) => a.name.localeCompare(b.name));
    const toolText = JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    );
    const combined = `${profile.systemPrompt}\n${toolText}`;

    expect(tools.map((tool) => tool.name)).toEqual([
      'CreateGoal',
      'FetchURL',
      'GetGoal',
      'ReadMediaFile',
      'RlmKernel',
      'Skill',
      'UpdateGoal',
    ]);
    expect(profile.systemPrompt.length).toBeLessThan(3_500);
    expect(toolText.length).toBeLessThan(12_000);
    expect(profile.systemPrompt.length + toolText.length).toBeLessThan(16_000);
    expect(profile.systemPrompt.length).toBeLessThan(7_523 * 0.5);
    expect(toolText.length).toBeLessThan(28_314 * 0.5);
    expect(combined).not.toMatch(
      /CronCreate|CronList|CronDelete|TodoList|AskUserQuestion|SetGoalBudget|WaitFor|EnterPlanMode|ExitPlanMode|AgentSwarm|self-audit|Completion audit|Blocked audit|next concrete phase|progress notes|first emit|8–10 words|bounded, useful|end the turn normally/i,
    );
    expect(profile.systemPrompt.match(/RlmKernel/g)).toHaveLength(1);
  });

  it('does not change the default system prompt when ordinary workspace files change', async () => {
    const { root, agent } = await createHarness();
    const profile = agent.accessor.get(IAgentProfileService);
    const before = profile.getSystemPrompt();

    await writeFile(join(root, 'work', 'new-file.txt'), 'new');
    await profile.refreshSystemPrompt();

    expect(profile.getSystemPrompt()).toBe(before);
    expect(profile.getSystemPrompt()).not.toContain('new-file.txt');
  });

  it('defaults cells to inspect access and exposes no model recursion API', () => {
    expect(RlmKernelInputSchema.parse({ code: '1 + 1' }).access).toBe('inspect');
    expect(RLM_PYTHON_WORKER).not.toContain('agent.run');
    expect(RLM_PYTHON_WORKER).not.toContain('async def run(self, prompt');
  });

  it('keeps Python state, checkpoints it, and restores after worker eviction', async () => {
    const { agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const signal = new AbortController().signal;

    const first = await kernel.execute(
      'value = 41\ndef add_one(number):\n    return number + 1\nprint("created")',
      {
        access: 'work',
        timeoutMs: 30_000,
        signal,
      },
    );
    expect(first.isError).toBe(false);
    expect(first.output).toContain('created');
    expect(first.checkpointGeneration).toBe(1);

    const second = await kernel.execute('value += 1\nvalue', {
      access: 'inspect',
      timeoutMs: 30_000,
      signal,
    });
    expect(second.output).toContain('42');
    expect(second.state.some((item) => item.name === 'value')).toBe(true);

    await agent.accessor.get(ISessionRlmKernelPool).release(agent.id);

    const restored = await kernel.execute('add_one(value)', {
      access: 'inspect',
      timeoutMs: 30_000,
      signal,
    });
    expect(restored.output).toContain('43');
  }, 120_000);

  it('restores durable namespace state after the Kimi session closes and resumes', async () => {
    const { root, manager, sessionId, agent } = await createHarness();
    const signal = new AbortController().signal;
    const resumedCwd = join(root, 'work', 'nested');
    await agent.accessor.get(IAgentRlmKernel).execute(
      [
        'import os',
        'from pathlib import Path',
        `Path(${JSON.stringify(resumedCwd)}).mkdir()`,
        `os.chdir(${JSON.stringify(resumedCwd)})`,
        'resume_value = 21',
        'def double(number):',
        '    return number * 2',
      ].join('\n'),
      { access: 'work', timeoutMs: 30_000, signal },
    );

    await manager.close(sessionId);
    const resumedSession = await manager.resume(sessionId);
    expect(resumedSession).toBeDefined();
    const resumedAgent = await ensureMainAgent(resumedSession!);
    const restored = await resumedAgent.accessor.get(IAgentRlmKernel).execute(
      'import os\nprint(os.getcwd())\ndouble(resume_value)',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );

    expect(restored.isError).toBe(false);
    expect(restored.output.replace('/private/var/', '/var/')).toContain(resumedCwd);
    expect(restored.output).toContain('42');
  }, 120_000);

  it('restores durable namespace state after archive and restore', async () => {
    const { manager, sessionId, agent } = await createHarness();
    const signal = new AbortController().signal;
    await agent.accessor.get(IAgentRlmKernel).execute('archive_value = 84', {
      access: 'work',
      timeoutMs: 30_000,
      signal,
    });

    await manager.archive(sessionId);
    const restoredSession = await manager.restore(sessionId);
    expect(restoredSession).toBeDefined();
    const restoredAgent = await ensureMainAgent(restoredSession!);
    const restored = await restoredAgent.accessor.get(IAgentRlmKernel).execute(
      'archive_value // 2',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );

    expect(restored.isError).toBe(false);
    expect(restored.output).toContain('42');
  }, 120_000);

  it('starts forked sessions with a clean RLM runtime state', async () => {
    const { manager, sessionId, agent } = await createHarness();
    const signal = new AbortController().signal;
    await agent.accessor.get(IAgentRlmKernel).execute('fork_value = 42', {
      access: 'work',
      timeoutMs: 30_000,
      signal,
    });

    const forked = await manager.fork({ sourceSessionId: sessionId });
    const forkedAgent = await ensureMainAgent(forked);
    const result = await forkedAgent.accessor.get(IAgentRlmKernel).execute(
      '"fork_value" in globals()',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('False');
  }, 120_000);

  it('enforces inspect mode and keeps raw fd output off the control channel', async () => {
    const { root, agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const signal = new AbortController().signal;
    const target = join(root, 'work', 'blocked.txt');

    const denied = await kernel.execute(
      `from pathlib import Path\nPath(${JSON.stringify(target)}).write_text("no")`,
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain('inspect mode blocks file writes');
    expect(existsSync(target)).toBe(false);

    const networkDenied = await kernel.execute(
      'import socket\nsocket.create_connection(("127.0.0.1", 9), timeout=0.1)',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(networkDenied.isError).toBe(true);
    expect(networkDenied.output).toContain('inspect mode blocks network connections');

    const raw = await kernel.execute(
      [
        'import asyncio, os, threading, time',
        'await asyncio.sleep(0)',
        'os.write(1, b"RAW_FD_OUTPUT\\n")',
        'sentinel = 99',
        'def late_output():',
        '    time.sleep(0.05)',
        '    print("LATE_THREAD_OUTPUT", flush=True)',
        'threading.Thread(target=late_output, name="rlm-late-output", daemon=True).start()',
      ].join('\n'),
      { access: 'work', timeoutMs: 30_000, signal },
    );
    expect(raw.isError).toBe(false);
    expect(raw.output).toContain('RAW_FD_OUTPUT');
    expect(raw.effects.lingeringThreads).toContain('rlm-late-output');

    const next = await kernel.execute('import time\ntime.sleep(0.1)\nsentinel', {
      access: 'inspect',
      timeoutMs: 30_000,
      signal,
    });
    expect(next.output).toContain('LATE_THREAD_OUTPUT');
    expect(next.output).toContain('99');
  }, 120_000);

  it('restores the last checkpoint after timeout while preserving external side effects', async () => {
    const { root, agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const target = join(root, 'work', 'timeout-side-effect.txt');
    const signal = new AbortController().signal;

    await kernel.execute('sentinel = 1', {
      access: 'work',
      timeoutMs: 30_000,
      signal,
    });
    await expect(
      kernel.execute(
        `from pathlib import Path\nimport time\nsentinel = 2\nPath(${JSON.stringify(target)}).write_text("kept")\ntime.sleep(5)`,
        { access: 'work', timeoutMs: 100, signal },
      ),
    ).rejects.toMatchObject({ code: 'rlm.execution_aborted' });

    await expect(readFile(target, 'utf8')).resolves.toBe('kept');
    const restored = await kernel.execute('sentinel', {
      access: 'inspect',
      timeoutMs: 30_000,
      signal,
    });
    expect(restored.output).toContain('1');
  }, 120_000);

  it('pools physical workers while preserving independent agent namespaces', async () => {
    const { session } = await createHarness();
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const agents = await Promise.all([
      lifecycle.create({ agentId: 'agent-1' }),
      lifecycle.create({ agentId: 'agent-2' }),
      lifecycle.create({ agentId: 'agent-3' }),
    ]);
    const signal = new AbortController().signal;

    for (const [index, agent] of agents.entries()) {
      await agent.accessor.get(IAgentRlmKernel).execute(`owner = ${String(index + 1)}`, {
        access: 'work',
        timeoutMs: 30_000,
        signal,
      });
    }
    for (const [index, agent] of agents.entries()) {
      const result = await agent.accessor.get(IAgentRlmKernel).execute('owner', {
        access: 'inspect',
        timeoutMs: 30_000,
        signal,
      });
      expect(result.output).toContain(String(index + 1));
    }
  }, 120_000);

  it('routes long-running commands through the existing Kimi task lifecycle', async () => {
    const { agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const tasks = agent.accessor.get(IAgentTaskService);
    const signal = new AbortController().signal;

    const denied = await kernel.execute(
      'await rlm.task.run("echo denied", description="denied")',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain('inspect mode blocks task.run');
    expect(tasks.list(false, 10)).toHaveLength(0);

    const started = await kernel.execute(
      [
        'background_task = await rlm.task.run(',
        '    "python3 -c \\\"import time; time.sleep(0.1); print(12345)\\\"",',
        '    timeout=30,',
        '    description="RLM task bridge test",',
        ')',
        'print(background_task["task_id"])',
      ].join('\n'),
      { access: 'work', timeoutMs: 30_000, signal },
    );
    expect(started.isError).toBe(false);
    const task = tasks.list(false, 10).find((item) => item.description === 'RLM task bridge test');
    expect(task).toBeDefined();
    await agent.accessor.get(ISessionRlmKernelPool).release(agent.id);
    const waited = await kernel.execute(
      'waited_task = await rlm.task.wait(background_task, timeout=600000)\nprint(waited_task["wait_status"], waited_task["timeout_ms"])',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(waited.isError).toBe(false);
    expect(waited.output).toContain('completed 600000');

    const output = await kernel.execute(
      'task_result = await rlm.task.output(background_task)\nprint(task_result["output"])',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(output.isError).toBe(false);
    expect(output.output).toContain('12345');
  }, 120_000);

  it('does not expose model subagent admission inside the RLM harness', async () => {
    const { session, agent } = await createHarness();
    const signal = new AbortController().signal;
    const result = await agent.accessor.get(IAgentRlmKernel).execute(
      'await rlm.run("should not launch", background=True)',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("'_RlmApi' object has no attribute 'run'");
    expect(session.accessor.get(IAgentLifecycleService).list()).toHaveLength(1);
  }, 120_000);

  it('persists large cell output behind a readable and searchable handle', async () => {
    const { agent, manager, sessionId } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const signal = new AbortController().signal;
    const produced = await kernel.execute(
      'print("HEAD_MARKER")\nprint("x" * 100000)\nprint("TAIL_MARKER")',
      { access: 'inspect', timeoutMs: 30_000, signal },
    );

    expect(produced.isError).toBe(false);
    expect(produced.outputReference).toMatchObject({ truncated: false });
    expect(produced.output).toContain('HEAD_MARKER');
    expect(produced.output).toContain('TAIL_MARKER');
    expect(produced.output).toContain('RLM output preview omitted');

    const handle = produced.outputReference!.handle;
    const searched = await kernel.execute(
      `matches = await rlm.output.search(${JSON.stringify(handle)}, "TAIL_MARKER")\nprint(matches)`,
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(searched.isError).toBe(false);
    expect(searched.output).toContain('TAIL_MARKER');

    await manager.close(sessionId);
    const resumedSession = await manager.resume(sessionId);
    expect(resumedSession).toBeDefined();
    const resumedAgent = await ensureMainAgent(resumedSession!);
    const read = await resumedAgent.accessor.get(IAgentRlmKernel).execute(
      `page = await rlm.output.read(${JSON.stringify(handle)}, offset=0, limit=64)\nprint(page["text"])`,
      { access: 'inspect', timeoutMs: 30_000, signal },
    );
    expect(read.isError).toBe(false);
    expect(read.output).toContain('HEAD_MARKER');
  }, 120_000);

  it('excludes secret-like and oversized values from durable checkpoints', async () => {
    const { agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const signal = new AbortController().signal;

    const created = await kernel.execute(
      'api_key = "YOUR_API_KEY"\nlarge_payload = b"x" * (17 * 1024 * 1024)\nsafe_value = 7',
      { access: 'work', timeoutMs: 30_000, signal },
    );
    expect(created.checkpointSkipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'api_key', reason: 'secret-like value' }),
        expect.objectContaining({ name: 'large_payload', reason: 'exceeds per-variable checkpoint limit' }),
      ]),
    );

    await agent.accessor.get(ISessionRlmKernelPool).release(agent.id);
    const restored = await kernel.state(signal);
    expect(restored.map((item) => item.name)).toContain('safe_value');
    expect(restored.map((item) => item.name)).not.toContain('api_key');
    expect(restored.map((item) => item.name)).not.toContain('large_payload');
  }, 120_000);

  it('records write effects without changing the user config file', async () => {
    const { root, agent } = await createHarness();
    const kernel = agent.accessor.get(IAgentRlmKernel);
    const target = join(root, 'work', 'created.txt');
    const configPath = join(root, 'home', 'config.toml');
    const configBefore = await readFile(configPath, 'utf8');
    const signal = new AbortController().signal;

    const result = await kernel.execute(
      `from pathlib import Path\nPath(${JSON.stringify(target)}).write_text("ok")`,
      { access: 'work', timeoutMs: 30_000, signal },
    );

    expect(result.isError).toBe(false);
    expect(result.effects.filesWritten).toContain(target);
    await expect(readFile(target, 'utf8')).resolves.toBe('ok');
    await expect(readFile(configPath, 'utf8')).resolves.toBe(configBefore);
  }, 120_000);
});
