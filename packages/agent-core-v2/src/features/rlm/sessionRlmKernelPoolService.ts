import { setTimeout as delay } from 'node:timers/promises';

import { Disposable } from '#/_base/di/lifecycle';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { RLM_PYTHON_WORKER } from './pythonWorker';
import { IRlmOutputStore, type RlmOutputReference } from './rlmOutputStore';
import {
  type ISessionRlmKernelPool,
  type RlmCellEffects,
  type RlmExecuteRequest,
  type RlmExecuteResult,
  type RlmHostRequest,
  type RlmKernelBinding,
  type RlmVariableInfo,
  ISessionRlmKernelPool as ISessionRlmKernelPoolToken,
  normalizeRlmCellAccess,
} from './sessionRlmKernelPool';

const MAX_ACTIVE_KERNELS = 2;
const IDLE_EVICT_MS = 120_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_VARIABLE_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const CONTROL_SETTLE_MS = 20;
const CHECKPOINT_KEY = 'checkpoint.json';
const CHECKPOINT_INDEX_KEY = 'checkpoint-index.json';
const CHECKPOINT_VERSION = 1;

interface ExecuteFrame {
  readonly id: number;
  readonly type: 'execute.result';
  readonly ok: boolean;
  readonly error?: string;
  readonly traceback?: string;
  readonly effects: RlmCellEffects;
  readonly state: readonly RlmVariableInfo[];
}

interface StateFrame {
  readonly id: number;
  readonly type: 'state.result';
  readonly variables: readonly RlmVariableInfo[];
}

interface RestoreFrame {
  readonly id: number;
  readonly type: 'restore.result';
  readonly restored: readonly string[];
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

interface SnapshotVariableFrame {
  readonly id: number;
  readonly type: 'snapshot.variable';
  readonly name: string;
  readonly valueType: string;
  readonly serializer: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly data: string;
}

interface SnapshotResultFrame {
  readonly id: number;
  readonly type: 'snapshot.result';
  readonly saved: readonly string[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly bytes: number;
  readonly serializer: string;
  readonly cwd: string;
}

interface ShutdownFrame {
  readonly id: number;
  readonly type: 'shutdown.result';
}

interface HostRequestFrame {
  readonly id: number;
  readonly type: 'host.request';
  readonly hostRequestId: number;
  readonly requestType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface ProtocolErrorFrame {
  readonly id?: number;
  readonly type: 'protocol.error';
  readonly error: string;
}

type ControlFrame =
  | ExecuteFrame
  | StateFrame
  | RestoreFrame
  | SnapshotVariableFrame
  | SnapshotResultFrame
  | ShutdownFrame
  | HostRequestFrame
  | ProtocolErrorFrame;

interface SnapshotVariable {
  readonly name: string;
  readonly valueType: string;
  readonly serializer: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly data: Uint8Array;
}

interface SnapshotPayload {
  readonly variables: readonly SnapshotVariable[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly bytes: number;
  readonly cwd: string;
}

interface CheckpointVariable {
  readonly name: string;
  readonly valueType: string;
  readonly serializer: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface CheckpointIndexEntry {
  readonly bytes: number;
  readonly hashes: readonly string[];
}

interface CheckpointIndex {
  readonly version: number;
  readonly agents: Readonly<Record<string, CheckpointIndexEntry>>;
}

interface CheckpointManifest {
  readonly version: number;
  readonly generation: number;
  readonly workspaceRoot: string;
  readonly workDir: string;
  readonly cwd: string;
  readonly variables: readonly CheckpointVariable[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly bytes: number;
}

type WorkerHostRequestHandler = (request: RlmHostRequest) => Promise<unknown>;
type WorkerExecuteRequest = Omit<RlmExecuteRequest, 'onHostRequest'> & {
  readonly onHostRequest?: WorkerHostRequestHandler;
};

interface PendingRequest {
  readonly terminalType: ControlFrame['type'];
  readonly resolve: (frame: ControlFrame) => void;
  readonly reject: (error: unknown) => void;
  readonly snapshotVariables: SnapshotVariableFrame[];
  readonly onHostRequest?: WorkerHostRequestHandler;
}

interface OutputCapture {
  stdout: string;
  stderr: string;
  truncated: boolean;
  readonly onUpdate?: RlmExecuteRequest['onUpdate'];
}

interface KernelSlot {
  readonly binding: RlmKernelBinding;
  readonly worker: KernelWorker;
  busy: boolean;
  lastUsed: number;
  generation: number;
  checkpointSkipped: readonly { readonly name: string; readonly reason: string }[];
  idleTimer?: ReturnType<typeof setTimeout>;
}

function rlmError(code: string, message: string, cause?: unknown): Error2 {
  return new Error2(code as (typeof ErrorCodes)[keyof typeof ErrorCodes], message, { cause });
}

function normalizeRuntimePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return normalized.startsWith('/private/var/') ? normalized.slice('/private'.length) : normalized;
}

function appendBounded(current: string, chunk: string): { readonly text: string; readonly truncated: boolean } {
  if (current.length >= MAX_CAPTURE_BYTES) return { text: current, truncated: true };
  const remaining = MAX_CAPTURE_BYTES - current.length;
  if (chunk.length <= remaining) return { text: `${current}${chunk}`, truncated: false };
  return { text: `${current}${chunk.slice(0, remaining)}`, truncated: true };
}

class KernelWorker {
  private nextId = 1;
  private controlBuffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private capture: OutputCapture | undefined;
  private orphanStdout = '';
  private orphanStderr = '';
  private disposed = false;

  private constructor(
    private readonly process: IHostProcess,
    private readonly lease: RlmKernelBinding['lease'],
  ) {
    process.control!.on('data', (chunk: Buffer | string) => {
      this.onControlData(chunk.toString());
    });
    process.control!.on('error', (error) => {
      this.failPending(error);
    });
    process.stdout.on('data', (chunk: Buffer | string) => {
      this.onOutput('stdout', chunk.toString());
    });
    process.stderr.on('data', (chunk: Buffer | string) => {
      this.onOutput('stderr', chunk.toString());
    });
    void process.wait().then(
      (code) => {
        this.failPending(
          rlmError(
            ErrorCodes.RLM_KERNEL_UNAVAILABLE,
            `RLM kernel exited with code ${String(code)}.`,
          ),
        );
      },
      (error) => {
        this.failPending(
          rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'RLM kernel process failed.', error),
        );
      },
    );
  }

  static async start(binding: RlmKernelBinding): Promise<KernelWorker> {
    const processService = binding.lease.runtime.process;
    if (processService === undefined) {
      binding.lease.dispose();
      throw rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'The selected runtime has no process capability.');
    }
    let process: IHostProcess;
    try {
      process = binding.lease.track(
        await processService.spawn(binding.pythonCommand, ['-u', '-c', RLM_PYTHON_WORKER], {
          cwd: binding.workDir,
          env: { PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' },
          controlPipe: true,
        }),
      );
    } catch (error) {
      binding.lease.dispose();
      throw rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'Failed to start the RLM Python worker.', error);
    }
    if (process.control === undefined) {
      await process.kill('SIGKILL').catch(() => undefined);
      binding.lease.dispose();
      throw rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, 'The RLM Python worker has no control pipe.');
    }
    return new KernelWorker(process, binding.lease);
  }

  async execute(request: WorkerExecuteRequest): Promise<{
    readonly frame: ExecuteFrame;
    readonly output: string;
    readonly outputTruncated: boolean;
  }> {
    const capture: OutputCapture = {
      stdout: this.orphanStdout,
      stderr: this.orphanStderr,
      truncated: false,
      onUpdate: request.onUpdate,
    };
    this.orphanStdout = '';
    this.orphanStderr = '';
    this.capture = capture;
    if (capture.stdout.length > 0) request.onUpdate?.({ kind: 'stdout', text: capture.stdout });
    if (capture.stderr.length > 0) request.onUpdate?.({ kind: 'stderr', text: capture.stderr });
    try {
      const frame = await this.request<ExecuteFrame>(
        'execute.result',
        {
          operation: 'execute',
          code: request.code,
          access: request.access,
        },
        request.onHostRequest,
      );
      await delay(CONTROL_SETTLE_MS);
      const sections: string[] = [];
      if (capture.stdout.length > 0) sections.push(capture.stdout);
      if (capture.stderr.length > 0) sections.push(capture.stderr);
      if (!frame.ok && frame.error !== undefined && !capture.stderr.includes(frame.error)) {
        sections.push(frame.traceback ?? frame.error);
      }
      if (capture.truncated) sections.push('[RLM cell output truncated at 16 MiB]');
      return {
        frame,
        output: sections.join(sections.length > 1 ? '\n' : ''),
        outputTruncated: capture.truncated,
      };
    } finally {
      this.capture = undefined;
    }
  }

  state(): Promise<StateFrame> {
    return this.request<StateFrame>('state.result', { operation: 'state' });
  }

  async snapshot(): Promise<SnapshotPayload> {
    const id = this.nextId++;
    const terminalType = 'snapshot.result' as const;
    let pendingRequest!: PendingRequest;
    const terminal = new Promise<ControlFrame>((resolve, reject) => {
      pendingRequest = { terminalType, resolve, reject, snapshotVariables: [] };
      this.pending.set(id, pendingRequest);
    });
    this.write({
      id,
      operation: 'snapshot',
      maxVariableBytes: MAX_CHECKPOINT_VARIABLE_BYTES,
      maxTotalBytes: MAX_CHECKPOINT_BYTES,
    });
    const result = (await terminal) as SnapshotResultFrame;
    return {
      variables: pendingRequest.snapshotVariables.map((frame) => ({
        name: frame.name,
        valueType: frame.valueType,
        serializer: frame.serializer,
        sha256: frame.sha256,
        bytes: frame.bytes,
        data: Buffer.from(frame.data, 'base64'),
      })),
      skipped: result.skipped,
      bytes: result.bytes,
      cwd: result.cwd,
    };
  }

  restore(
    variables: readonly (CheckpointVariable & { readonly data: Uint8Array })[],
    cwd: string,
  ): Promise<RestoreFrame> {
    return this.request<RestoreFrame>('restore.result', {
      operation: 'restore',
      cwd,
      variables: variables.map((variable) => ({
        name: variable.name,
        serializer: variable.serializer,
        sha256: variable.sha256,
        data: Buffer.from(variable.data).toString('base64'),
      })),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await Promise.race([
        this.request<ShutdownFrame>('shutdown.result', { operation: 'shutdown' }),
        delay(500),
      ]);
    } catch {
    }
    await this.process.kill('SIGKILL').catch(() => undefined);
    await this.process.dispose();
    this.lease.dispose();
    this.failPending(rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'RLM kernel disposed.'));
  }

  async interrupt(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.process.kill('SIGKILL').catch(() => undefined);
    await this.process.dispose();
    this.lease.dispose();
    this.failPending(rlmError(ErrorCodes.RLM_EXECUTION_ABORTED, 'RLM cell interrupted.'));
  }

  private request<T extends ControlFrame>(
    terminalType: T['type'],
    payload: Record<string, unknown>,
    onHostRequest?: WorkerHostRequestHandler,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'RLM kernel is not running.'));
    }
    const id = this.nextId++;
    const promise = new Promise<ControlFrame>((resolve, reject) => {
      this.pending.set(id, { terminalType, resolve, reject, snapshotVariables: [], onHostRequest });
    });
    this.write({ id, ...payload });
    return promise as Promise<T>;
  }

  private write(payload: Record<string, unknown>): void {
    if (this.disposed) return;
    try {
      this.process.control!.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.failPending(rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, 'Failed to write to the RLM control pipe.', error));
    }
  }

  private onControlData(chunk: string): void {
    this.controlBuffer += chunk;
    for (let index = this.controlBuffer.indexOf('\n'); index >= 0; index = this.controlBuffer.indexOf('\n')) {
      const line = this.controlBuffer.slice(0, index);
      this.controlBuffer = this.controlBuffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let frame: ControlFrame;
      try {
        frame = JSON.parse(line) as ControlFrame;
      } catch (error) {
        this.failPending(rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, 'Invalid JSON from the RLM control pipe.', error));
        continue;
      }
      if (frame.id === undefined) {
        this.failPending(rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, frame.type === 'protocol.error' ? frame.error : 'RLM control frame has no request id.'));
        continue;
      }
      const pending = this.pending.get(frame.id);
      if (pending === undefined) continue;
      if (frame.type === 'host.request') {
        void this.handleHostRequest(frame, pending);
        continue;
      }
      if (frame.type === 'snapshot.variable') {
        pending.snapshotVariables.push(frame);
        continue;
      }
      if (frame.type === 'protocol.error') {
        this.pending.delete(frame.id);
        pending.reject(rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, frame.error));
        continue;
      }
      if (frame.type !== pending.terminalType) {
        this.pending.delete(frame.id);
        pending.reject(rlmError(ErrorCodes.RLM_PROTOCOL_ERROR, `Unexpected RLM control frame: ${frame.type}.`));
        continue;
      }
      this.pending.delete(frame.id);
      pending.resolve(frame);
    }
  }

  private async handleHostRequest(frame: HostRequestFrame, pending: PendingRequest): Promise<void> {
    const handler = pending.onHostRequest;
    if (handler === undefined) {
      this.write({
        type: 'host.response',
        hostRequestId: frame.hostRequestId,
        ok: false,
        error: 'RLM host bridge is unavailable.',
      });
      return;
    }
    try {
      const value = await handler({ type: frame.requestType, payload: frame.payload });
      this.write({ type: 'host.response', hostRequestId: frame.hostRequestId, ok: true, value });
    } catch (error) {
      this.write({
        type: 'host.response',
        hostRequestId: frame.hostRequestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onOutput(kind: 'stdout' | 'stderr', chunk: string): void {
    const capture = this.capture;
    if (capture === undefined) {
      const current = kind === 'stdout' ? this.orphanStdout : this.orphanStderr;
      const appended = appendBounded(current, chunk);
      if (kind === 'stdout') this.orphanStdout = appended.text;
      else this.orphanStderr = appended.text;
      return;
    }
    const appended = appendBounded(capture[kind], chunk);
    capture[kind] = appended.text;
    capture.truncated ||= appended.truncated;
    if (!appended.truncated) capture.onUpdate?.({ kind, text: chunk });
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class SessionRlmKernelPoolService extends Disposable implements ISessionRlmKernelPool {
  declare readonly _serviceBrand: undefined;

  private readonly slots = new Map<string, KernelSlot>();
  private readonly releaseRequested = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private lock: Promise<void> = Promise.resolve();
  private checkpointLock: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IBlobStore private readonly blobs: IBlobStore,
    @IRlmOutputStore private readonly outputs: IRlmOutputStore,
  ) {
    super();
  }

  async execute(binding: RlmKernelBinding, request: RlmExecuteRequest): Promise<RlmExecuteResult> {
    const slot = await this.acquire(binding);
    try {
      const hostController = new AbortController();
      const hostRequestHandler = request.onHostRequest;
      const execution = slot.worker.execute({
        ...request,
        access: normalizeRlmCellAccess(request.access),
        onHostRequest:
          hostRequestHandler === undefined
            ? undefined
            : (hostRequest) => hostRequestHandler(hostRequest, hostController.signal),
      });
      const outcome = await this.raceExecution(slot, execution, request, hostController);
      const projected = await this.projectOutput(
        binding.agentId,
        outcome.output,
        outcome.outputTruncated,
      );
      slot.lastUsed = Date.now();
      if (!outcome.frame.ok) {
        return {
          output: projected.output,
          outputReference: projected.reference,
          isError: true,
          effects: outcome.frame.effects,
          state: outcome.frame.state,
          checkpointGeneration: slot.generation || undefined,
          checkpointSkipped: slot.checkpointSkipped,
        };
      }
      try {
        const checkpoint = await this.persistCheckpoint(slot);
        return {
          output: projected.output.length > 0 ? projected.output : 'Cell completed.',
          outputReference: projected.reference,
          isError: false,
          effects: outcome.frame.effects,
          state: outcome.frame.state,
          checkpointGeneration: checkpoint.generation,
          checkpointSkipped: checkpoint.skipped,
        };
      } catch (error) {
        return {
          output: projected.output.length > 0 ? projected.output : 'Cell completed.',
          outputReference: projected.reference,
          isError: false,
          effects: outcome.frame.effects,
          state: outcome.frame.state,
          checkpointGeneration: slot.generation || undefined,
          checkpointSkipped: [
            ...slot.checkpointSkipped,
            { name: '*', reason: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    } finally {
      await this.markIdle(binding.agentId);
    }
  }

  private async projectOutput(
    agentId: string,
    output: string,
    truncated: boolean,
  ): Promise<{ readonly output: string; readonly reference?: RlmOutputReference }> {
    if (output.length === 0) return { output };
    if (!truncated && Buffer.byteLength(output, 'utf8') <= 32 * 1024) return { output };
    try {
      const reference = await this.outputs.save(agentId, output, truncated);
      return { output: reference.preview, reference };
    } catch {
      const head = output.slice(0, 16 * 1024);
      const tail = output.slice(-16 * 1024);
      return {
        output:
          output.length <= 32 * 1024
            ? output
            : `${head}\n\n[RLM output persistence failed; middle omitted]\n\n${tail}`,
      };
    }
  }

  async state(binding: RlmKernelBinding, signal?: AbortSignal): Promise<readonly RlmVariableInfo[]> {
    const slot = await this.acquire(binding);
    try {
      if (signal?.aborted) throw rlmError(ErrorCodes.RLM_EXECUTION_ABORTED, 'RLM state request aborted.');
      return (await slot.worker.state()).variables;
    } finally {
      await this.markIdle(binding.agentId);
    }
  }

  async checkpoint(agentId: string): Promise<void> {
    const slot = this.slots.get(agentId);
    if (slot === undefined || slot.busy) return;
    slot.busy = true;
    try {
      await this.persistCheckpoint(slot);
    } finally {
      await this.markIdle(agentId);
    }
  }

  async release(agentId: string): Promise<void> {
    const slot = await this.synchronized(() => {
      const current = this.slots.get(agentId);
      if (current === undefined) return undefined;
      if (current.busy) {
        this.releaseRequested.add(agentId);
        return undefined;
      }
      this.slots.delete(agentId);
      this.releaseRequested.delete(agentId);
      return current;
    });
    if (slot !== undefined) {
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
      await slot.worker.dispose();
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    const slots = [...this.slots.values()];
    for (const slot of slots) {
      if (!slot.busy) {
        slot.busy = true;
        await this.persistCheckpoint(slot).catch(() => undefined);
      }
    }
    this.slots.clear();
    this.releaseRequested.clear();
    for (const slot of slots) {
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    }
    await Promise.all(slots.map((slot) => slot.worker.dispose()));
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.releaseRequested.clear();
    for (const slot of slots) {
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
      void slot.worker.interrupt();
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    super.dispose();
  }

  private async acquire(binding: RlmKernelBinding): Promise<KernelSlot> {
    for (;;) {
      const action = await this.synchronized(async () => {
        if (this.disposed) {
          binding.lease.dispose();
          throw rlmError(ErrorCodes.RLM_KERNEL_UNAVAILABLE, 'RLM kernel pool is disposed.');
        }
        const existing = this.slots.get(binding.agentId);
        if (existing !== undefined && this.sameRuntime(existing.binding, binding) && !existing.busy) {
          existing.busy = true;
          if (existing.idleTimer !== undefined) {
            clearTimeout(existing.idleTimer);
            existing.idleTimer = undefined;
          }
          binding.lease.dispose();
          return { kind: 'ready' as const, slot: existing };
        }
        if (existing !== undefined && existing.busy) return { kind: 'wait' as const };
        let evicted: KernelSlot | undefined;
        if (existing !== undefined) {
          this.slots.delete(binding.agentId);
          evicted = existing;
        } else if (this.slots.size >= MAX_ACTIVE_KERNELS) {
          evicted = [...this.slots.values()]
            .filter((candidate) => !candidate.busy)
            .toSorted((left, right) => left.lastUsed - right.lastUsed)[0];
          if (evicted === undefined) return { kind: 'wait' as const };
          this.slots.delete(evicted.binding.agentId);
        }
        if (evicted !== undefined) {
          if (evicted.idleTimer !== undefined) clearTimeout(evicted.idleTimer);
          await evicted.worker.dispose();
        }
        const worker = await KernelWorker.start(binding);
        const slot: KernelSlot = {
          binding,
          worker,
          busy: true,
          lastUsed: Date.now(),
          generation: 0,
          checkpointSkipped: [],
        };
        try {
          await this.restoreCheckpoint(slot);
        } catch {
        }
        this.slots.set(binding.agentId, slot);
        return { kind: 'ready' as const, slot };
      });
      if (action.kind === 'ready') return action.slot;
      await this.waitForAvailability();
    }
  }

  private waitForAvailability(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
    });
  }

  private async markIdle(agentId: string): Promise<void> {
    const released = await this.synchronized(() => {
      const slot = this.slots.get(agentId);
      if (slot !== undefined && this.releaseRequested.delete(agentId)) {
        this.slots.delete(agentId);
        const wake = this.waiters.values().next().value;
        wake?.();
        return slot;
      }
      if (slot !== undefined) {
        slot.busy = false;
        slot.lastUsed = Date.now();
        if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
        const expectedLastUsed = slot.lastUsed;
        slot.idleTimer = setTimeout(() => {
          void this.releaseIdle(agentId, expectedLastUsed);
        }, IDLE_EVICT_MS);
        slot.idleTimer.unref?.();
      }
      const wake = this.waiters.values().next().value;
      wake?.();
      return undefined;
    });
    if (released !== undefined) await released.worker.dispose();
  }

  private async releaseIdle(agentId: string, expectedLastUsed: number): Promise<void> {
    const slot = await this.synchronized(() => {
      const current = this.slots.get(agentId);
      if (current === undefined || current.busy || current.lastUsed !== expectedLastUsed) {
        return undefined;
      }
      this.slots.delete(agentId);
      return current;
    });
    if (slot !== undefined) await slot.worker.dispose();
  }

  private async raceExecution(
    slot: KernelSlot,
    execution: Promise<{
      readonly frame: ExecuteFrame;
      readonly output: string;
      readonly outputTruncated: boolean;
    }>,
    request: RlmExecuteRequest,
    hostController: AbortController,
  ): Promise<{
    readonly frame: ExecuteFrame;
    readonly output: string;
    readonly outputTruncated: boolean;
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<never>((_, reject) => {
      const interrupt = (message: string): void => {
        hostController.abort();
        void slot.worker.interrupt();
        void this.synchronized(() => this.slots.delete(slot.binding.agentId));
        reject(rlmError(ErrorCodes.RLM_EXECUTION_ABORTED, message));
      };
      timer = setTimeout(() => {
        interrupt(`RLM cell timed out after ${String(request.timeoutMs)}ms.`);
      }, request.timeoutMs);
      abortListener = () => {
        interrupt('RLM cell interrupted by user.');
      };
      request.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([execution, interruption]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined) request.signal.removeEventListener('abort', abortListener);
    }
  }

  private async persistCheckpoint(slot: KernelSlot): Promise<CheckpointManifest> {
    try {
      const snapshot = await slot.worker.snapshot();
      const manifest: CheckpointManifest = {
        version: CHECKPOINT_VERSION,
        generation: slot.generation + 1,
        workspaceRoot: slot.binding.workspaceRoot,
        workDir: slot.binding.workDir,
        cwd: snapshot.cwd,
        variables: snapshot.variables.map((variable) => ({
          name: variable.name,
          valueType: variable.valueType,
          serializer: variable.serializer,
          sha256: variable.sha256,
          bytes: variable.bytes,
        })),
        skipped: snapshot.skipped,
        bytes: snapshot.bytes,
      };
      await this.checkpointSynchronized(async () => {
        const indexScope = this.session.scope('rlm');
        const existing = await this.documents.get<CheckpointIndex>(indexScope, CHECKPOINT_INDEX_KEY);
        const agents = existing?.version === CHECKPOINT_VERSION ? { ...existing.agents } : {};
        const old = agents[slot.binding.agentId];
        const otherBytes = Object.entries(agents)
          .filter(([agentId]) => agentId !== slot.binding.agentId)
          .reduce((total, [, entry]) => total + entry.bytes, 0);
        if (otherBytes + snapshot.bytes > MAX_SESSION_CHECKPOINT_BYTES) {
          throw new Error2(
            ErrorCodes.RLM_CHECKPOINT_FAILED,
            'RLM session checkpoint quota exceeded.',
            {
              details: {
                maxBytes: MAX_SESSION_CHECKPOINT_BYTES,
                requestedBytes: otherBytes + snapshot.bytes,
              },
            },
          );
        }
        const blobScope = this.session.scope('rlm/blobs');
        await Promise.all(
          snapshot.variables.map((variable) =>
            this.blobs.put(blobScope, `${variable.sha256}.bin`, variable.data),
          ),
        );
        await this.documents.set(slot.binding.persistenceScope, CHECKPOINT_KEY, manifest);
        agents[slot.binding.agentId] = {
          bytes: snapshot.bytes,
          hashes: snapshot.variables.map((variable) => variable.sha256),
        };
        await this.documents.set(indexScope, CHECKPOINT_INDEX_KEY, {
          version: CHECKPOINT_VERSION,
          agents,
        });
        if (old !== undefined) {
          const retained = new Set(Object.values(agents).flatMap((entry) => entry.hashes));
          await Promise.all(
            old.hashes
              .filter((hash) => !retained.has(hash))
              .map((hash) => this.blobs.delete(blobScope, `${hash}.bin`).catch(() => undefined)),
          );
        }
      });
      slot.generation = manifest.generation;
      slot.checkpointSkipped = manifest.skipped;
      return manifest;
    } catch (error) {
      throw rlmError(ErrorCodes.RLM_CHECKPOINT_FAILED, 'Failed to persist the RLM checkpoint.', error);
    }
  }

  private async restoreCheckpoint(slot: KernelSlot): Promise<void> {
    const manifest = await this.documents.get<CheckpointManifest>(
      slot.binding.persistenceScope,
      CHECKPOINT_KEY,
    );
    if (manifest === undefined || manifest.version !== CHECKPOINT_VERSION) return;
    if (manifest.workspaceRoot !== slot.binding.workspaceRoot) {
      slot.checkpointSkipped = [{ name: '*', reason: 'workspace root changed; checkpoint not restored' }];
      return;
    }
    const blobScope = this.session.scope('rlm/blobs');
    const variables: Array<CheckpointVariable & { readonly data: Uint8Array }> = [];
    for (const variable of manifest.variables) {
      const data = await this.blobs.get(blobScope, `${variable.sha256}.bin`);
      if (data !== undefined) variables.push({ ...variable, data });
    }
    const normalizedRoot = normalizeRuntimePath(slot.binding.workspaceRoot);
    const manifestCwd = typeof manifest.cwd === 'string' ? manifest.cwd : slot.binding.workDir;
    const normalizedCwd = normalizeRuntimePath(manifestCwd);
    const cwd =
      normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`)
        ? manifestCwd
        : slot.binding.workDir;
    const restored = await slot.worker.restore(variables, cwd);
    slot.generation = manifest.generation;
    slot.checkpointSkipped = [
      ...manifest.skipped,
      ...restored.failed,
      ...(variables.length === manifest.variables.length
        ? []
        : [{ name: '*', reason: 'one or more checkpoint blobs are missing' }]),
    ];
  }

  private sameRuntime(left: RlmKernelBinding, right: RlmKernelBinding): boolean {
    return (
      left.runtimeId === right.runtimeId &&
      left.runtimeGeneration === right.runtimeGeneration &&
      left.pythonCommand === right.pythonCommand &&
      left.workDir === right.workDir &&
      left.workspaceRoot === right.workspaceRoot
    );
  }

  private async checkpointSynchronized<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.checkpointLock;
    let release!: () => void;
    this.checkpointLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async synchronized<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
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

export const SessionRlmKernelPool = {
  id: ISessionRlmKernelPoolToken,
  ctor: SessionRlmKernelPoolService,
};
