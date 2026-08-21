import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ErrorCodes, isError2 } from '#/errors';
import { BTW_DISABLED_MESSAGE, ISessionBtwService } from '#/features/btw/btw';
import { SessionBtwService } from '#/features/btw/btwService';


describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });

  afterEach(() => disposables.dispose());

  it('rejects side questions without creating another agent', async () => {
    const error = await ix.get(ISessionBtwService).start().catch((reason: unknown) => reason);

    expect(isError2(error)).toBe(true);
    expect(error).toMatchObject({ code: ErrorCodes.REQUEST_INVALID, message: BTW_DISABLED_MESSAGE });
  });
});
