import { createDecorator } from '#/_base/di/instantiation';

export interface IRlmPythonRuntime {
  readonly _serviceBrand: undefined;
  resolve(): Promise<string>;
}

export const IRlmPythonRuntime = createDecorator<IRlmPythonRuntime>('rlmPythonRuntime');
