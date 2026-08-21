import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const RlmErrors = {
  codes: {
    RLM_KERNEL_UNAVAILABLE: 'rlm.kernel_unavailable',
    RLM_PROTOCOL_ERROR: 'rlm.protocol_error',
    RLM_EXECUTION_ABORTED: 'rlm.execution_aborted',
    RLM_CHECKPOINT_FAILED: 'rlm.checkpoint_failed',
  },
  info: {
    'rlm.kernel_unavailable': {
      title: 'RLM kernel unavailable',
      retryable: true,
      public: true,
    },
    'rlm.protocol_error': {
      title: 'RLM kernel protocol error',
      retryable: true,
      public: true,
    },
    'rlm.execution_aborted': {
      title: 'RLM cell interrupted',
      retryable: false,
      public: true,
    },
    'rlm.checkpoint_failed': {
      title: 'RLM checkpoint failed',
      retryable: true,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(RlmErrors);
