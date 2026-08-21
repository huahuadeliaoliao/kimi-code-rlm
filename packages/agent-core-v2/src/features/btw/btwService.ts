import { Error2, ErrorCodes } from '#/errors';

import { BTW_DISABLED_MESSAGE, ISessionBtwService } from './btw';

export class SessionBtwService implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  async start(): Promise<string> {
    throw new Error2(ErrorCodes.REQUEST_INVALID, BTW_DISABLED_MESSAGE);
  }
}
