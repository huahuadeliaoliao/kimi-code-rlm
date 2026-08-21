import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentRlmHostBridge } from './agentRlmHostBridge';
import { AgentRlmHostBridgeService } from './agentRlmHostBridgeService';
import { IAgentRlmKernel } from './agentRlmKernel';
import { AgentRlmKernelService } from './agentRlmKernelService';
import { IRlmOutputStore } from './rlmOutputStore';
import { RlmOutputStoreService } from './rlmOutputStoreService';
import { IRlmProcessTaskLauncher } from './rlmProcessTaskLauncher';
import { RlmProcessTaskLauncherService } from './rlmProcessTaskLauncherService';
import { IRlmPythonRuntime } from './rlmPythonRuntime';
import { RlmPythonRuntimeService } from './rlmPythonRuntimeService';
import { ISessionRlmKernelPool } from './sessionRlmKernelPool';
import { SessionRlmKernelPoolService } from './sessionRlmKernelPoolService';
import { IRlmKernelTool } from './tools/rlm-kernel/rlm-kernel';
import { RlmKernelTool } from './tools/rlm-kernel/rlmKernelTool';

export class RlmFeature extends Feature {
  static override readonly name = 'rlm';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      IRlmPythonRuntime,
      RlmPythonRuntimeService,
      { activation: ScopeActivation.OnDemand },
    );
    this.contributeService(
      LifecycleScope.Session,
      IRlmOutputStore,
      RlmOutputStoreService,
      { activation: ScopeActivation.OnDemand },
    );
    this.contributeService(
      LifecycleScope.Session,
      ISessionRlmKernelPool,
      SessionRlmKernelPoolService,
      { activation: ScopeActivation.OnDemand },
    );
    this.contributeAgentService(IRlmProcessTaskLauncher, RlmProcessTaskLauncherService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeAgentService(IAgentRlmHostBridge, AgentRlmHostBridgeService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeAgentService(IAgentRlmKernel, AgentRlmKernelService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeTool(IRlmKernelTool, RlmKernelTool, {
      name: 'RlmKernel',
      domain: 'rlm',
      requiredRuntimeCapabilities: ['process'],
    });
  }
}

registerFeature(RlmFeature);
