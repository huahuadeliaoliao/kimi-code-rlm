import { createDecorator } from '#/_base/di/instantiation';

export interface RlmOutputReference {
  readonly handle: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

export interface RlmOutputReadResult {
  readonly handle: string;
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly hasMore: boolean;
  readonly text: string;
}

export interface RlmOutputSearchMatch {
  readonly line: number;
  readonly text: string;
}

export interface IRlmOutputStore {
  readonly _serviceBrand: undefined;
  save(agentId: string, output: string, truncated: boolean): Promise<RlmOutputReference>;
  read(agentId: string, handle: string, offset?: number, limit?: number): Promise<RlmOutputReadResult>;
  search(
    agentId: string,
    handle: string,
    pattern: string,
    maxMatches?: number,
  ): Promise<readonly RlmOutputSearchMatch[]>;
}

export const IRlmOutputStore = createDecorator<IRlmOutputStore>('rlmOutputStore');
