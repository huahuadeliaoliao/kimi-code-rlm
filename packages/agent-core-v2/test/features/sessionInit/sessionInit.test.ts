import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { UserCancellationError } from '#/_base/utils/abort';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionInitService } from '#/features/sessionInit/sessionInit';
import { SessionInitService } from '#/features/sessionInit/sessionInitService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

const WORK_DIR = '/project';
const AGENTS_MD = 'latest project instructions';
const AGENTS_MD_PATH = `${WORK_DIR}/AGENTS.md`;
const GIT_DIR_PATH = `${WORK_DIR}/.git`;

describe('SessionInitService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let appendReminder: ReturnType<typeof vi.fn>;
  let seedInjected: ReturnType<typeof vi.fn>;
  let flush: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let lifecycleGet: ReturnType<typeof vi.fn>;
  let nextResult: Promise<unknown>;
  let cancelTurn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendReminder = vi.fn(() => 'reminder-id');
    seedInjected = vi.fn();
    flush = vi.fn(async () => {});
    nextResult = Promise.resolve({ type: 'completed', steps: 1, truncated: false });
    cancelTurn = vi.fn(() => true);
    enqueue = vi.fn(async () => ({
      launched: Promise.resolve({
        id: 1,
        signal: new AbortController().signal,
        ready: Promise.resolve(),
        result: nextResult,
        cancel: cancelTurn,
      }),
    }));

    const profile = { data: () => ({ modelAlias: 'mock-model', thinkingLevel: 'off' }) };
    const main = {
      id: 'main',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentProfileService) return profile;
          if (id === IAgentPromptService) return { enqueue };
          if (id === IAgentSystemReminderService) return { appendSystemReminder: appendReminder };
          if (id === IAgentAgentsMdReminderService) return { seedInjected };
          if (id === IEventDispatcher) return { flush };
          return undefined;
        },
      },
    };
    lifecycleGet = vi.fn((id: string) => (id === 'main' ? main : undefined));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      get: lifecycleGet,
    } as unknown as IAgentLifecycleService);
    ix.stub(IHostFileSystem, {
      _serviceBrand: undefined,
      stat: vi.fn(async (path: string): Promise<HostFileStat> => {
        if (path === GIT_DIR_PATH) return { isFile: false, isDirectory: true, size: 0 };
        if (path === AGENTS_MD_PATH) {
          return { isFile: true, isDirectory: false, size: AGENTS_MD.length };
        }
        throw new Error(`ENOENT: ${path}`);
      }),
      readText: vi.fn(async (path: string) => {
        if (path === AGENTS_MD_PATH) return AGENTS_MD;
        throw new Error(`ENOENT: ${path}`);
      }),
    } as unknown as IHostFileSystem);
    ix.stub(IHostEnvironment, {
      _serviceBrand: undefined,
      homeDir: '/home',
    } as unknown as IHostEnvironment);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home/brand',
    } as unknown as IBootstrapService);
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      cwd: WORK_DIR,
    } as unknown as ISessionContext);
    ix.set(ISessionInitService, new SyncDescriptor(SessionInitService));
  });

  afterEach(() => disposables.dispose());

  it('runs initialization in the main agent and reloads AGENTS.md', async () => {
    await ix.get(ISessionInitService).generateAgentsMd();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const message = enqueue.mock.calls[0]![0].message as {
      content: Array<{ type: string; text: string }>;
      origin: { kind: string; name: string };
    };
    expect(message.content[0]?.text).toContain('Task requirements:');
    expect(message.origin).toEqual({ kind: 'system_trigger', name: 'session_init' });
    expect(lifecycleGet).toHaveBeenCalledWith('main');

    expect(appendReminder).toHaveBeenCalledTimes(1);
    const [content, origin] = appendReminder.mock.calls[0] as [
      string,
      { kind: string; variant: string },
    ];
    expect(origin).toEqual({ kind: 'injection', variant: 'init' });
    expect(content).toContain('The user just ran `/init` slash command.');
    expect(content).toContain(AGENTS_MD);
    expect(seedInjected).toHaveBeenCalledWith([AGENTS_MD_PATH], WORK_DIR);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('wraps a main-agent turn failure in SESSION_INIT_FAILED', async () => {
    nextResult = Promise.resolve({ type: 'failed', steps: 1, error: new Error('init exploded') });

    const error = await ix.get(ISessionInitService).generateAgentsMd().catch((error) => error);
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.SESSION_INIT_FAILED);
    expect((error as Error2).message).toContain('init exploded');
  });

  it('throws AGENT_NOT_FOUND when the main agent is missing', async () => {
    lifecycleGet.mockReturnValue(undefined);

    const error = await ix.get(ISessionInitService).generateAgentsMd().catch((error) => error);
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.AGENT_NOT_FOUND);
  });

  it('cancelInit cancels the in-flight main turn without wrapping cancellation', async () => {
    let resolveResult!: (value: unknown) => void;
    nextResult = new Promise((resolve) => {
      resolveResult = resolve;
    });
    cancelTurn.mockImplementation((reason: unknown) => {
      resolveResult({ type: 'cancelled', steps: 0, reason });
      return true;
    });
    const service = ix.get(ISessionInitService);
    const pending = service.generateAgentsMd();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));

    service.cancelInit();

    const error = await pending.catch((error) => error);
    expect(error).toBeInstanceOf(UserCancellationError);
    expect(cancelTurn).toHaveBeenCalledTimes(1);
  });

  it('cancelInit is a no-op when no init run is in flight', () => {
    expect(() => ix.get(ISessionInitService).cancelInit()).not.toThrow();
  });
});
