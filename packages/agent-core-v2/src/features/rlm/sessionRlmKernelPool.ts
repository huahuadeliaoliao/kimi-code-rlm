import { createDecorator } from '#/_base/di/instantiation';
import type { RuntimeLease } from '#/runtime/runtime';
import type { ToolUpdate } from '#/tool/toolContract';
import type { RlmOutputReference } from './rlmOutputStore';

export type RlmCellAccess = 'inspect' | 'work';

export interface RlmVariableInfo {
  readonly name: string;
  readonly type: string;
  readonly preview: string;
}

export interface RlmCellEffects {
  readonly filesWritten: readonly string[];
  readonly filesDeleted: readonly string[];
  readonly subprocessStarted: boolean;
  readonly lingeringThreads: readonly string[];
}

export interface RlmKernelBinding {
  readonly agentId: string;
  readonly persistenceScope: string;
  readonly workDir: string;
  readonly workspaceRoot: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly pythonCommand: string;
  readonly lease: RuntimeLease;
}

export interface RlmHostRequest {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RlmExecuteRequest {
  readonly code: string;
  readonly access: RlmCellAccess;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly onHostRequest?: (request: RlmHostRequest, signal: AbortSignal) => Promise<unknown>;
}

export interface RlmExecuteResult {
  readonly output: string;
  readonly isError: boolean;
  readonly effects: RlmCellEffects;
  readonly state: readonly RlmVariableInfo[];
  readonly outputReference?: RlmOutputReference;
  readonly checkpointGeneration?: number;
  readonly checkpointSkipped?: readonly { readonly name: string; readonly reason: string }[];
}

export interface ISessionRlmKernelPool {
  readonly _serviceBrand: undefined;
  execute(binding: RlmKernelBinding, request: RlmExecuteRequest): Promise<RlmExecuteResult>;
  state(binding: RlmKernelBinding, signal?: AbortSignal): Promise<readonly RlmVariableInfo[]>;
  checkpoint(agentId: string): Promise<void>;
  release(agentId: string): Promise<void>;
  flush(): Promise<void>;
}

export const ISessionRlmKernelPool =
  createDecorator<ISessionRlmKernelPool>('sessionRlmKernelPool');
