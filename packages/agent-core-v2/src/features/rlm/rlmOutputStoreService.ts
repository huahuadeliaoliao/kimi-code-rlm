import { randomBytes } from 'node:crypto';
import { join } from 'pathe';

import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import type {
  IRlmOutputStore,
  RlmOutputReadResult,
  RlmOutputReference,
  RlmOutputSearchMatch,
} from './rlmOutputStore';

const OUTPUT_PREVIEW_HEAD_BYTES = 16 * 1024;
const OUTPUT_PREVIEW_TAIL_BYTES = 16 * 1024;
const OUTPUT_READ_DEFAULT_BYTES = 32 * 1024;
const OUTPUT_READ_MAX_BYTES = 256 * 1024;
const OUTPUT_SESSION_QUOTA_BYTES = 128 * 1024 * 1024;
const OUTPUT_HANDLE_PATTERN = /^rlmout_[0-9a-f]{24}$/;

export class RlmOutputStoreService implements IRlmOutputStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionContext private readonly session: ISessionContext,
  ) {}

  async save(agentId: string, output: string, truncated: boolean): Promise<RlmOutputReference> {
    const handle = `rlmout_${randomBytes(12).toString('hex')}`;
    const directory = this.directory(agentId);
    const bytes = Buffer.from(output, 'utf8');
    await this.fs.mkdir(directory, { recursive: true });
    await this.fs.writeBytes(join(directory, `${handle}.log`), bytes);
    await this.collectGarbage(directory);
    return {
      handle,
      bytes: bytes.byteLength,
      truncated,
      preview: outputPreview(bytes),
    };
  }

  async read(
    agentId: string,
    handle: string,
    offset = 0,
    limit = OUTPUT_READ_DEFAULT_BYTES,
  ): Promise<RlmOutputReadResult> {
    const path = this.path(agentId, handle);
    const stat = await this.fs.stat(path);
    const boundedOffset = Math.max(0, Math.min(offset, stat.size));
    const boundedLimit = Math.max(1, Math.min(limit, OUTPUT_READ_MAX_BYTES));
    const bytes = await this.fs.readBytes(path, boundedLimit, boundedOffset);
    return {
      handle,
      offset: boundedOffset,
      bytes: bytes.byteLength,
      totalBytes: stat.size,
      hasMore: boundedOffset + bytes.byteLength < stat.size,
      text: Buffer.from(bytes).toString('utf8'),
    };
  }

  async search(
    agentId: string,
    handle: string,
    pattern: string,
    maxMatches = 50,
  ): Promise<readonly RlmOutputSearchMatch[]> {
    if (pattern.length === 0 || pattern.length > 1_000) {
      throw new Error('RLM output search pattern must contain 1-1000 characters.');
    }
    const text = await this.fs.readText(this.path(agentId, handle), {
      encoding: 'utf8',
      errors: 'replace',
    });
    const limit = Math.max(1, Math.min(maxMatches, 200));
    const matches: RlmOutputSearchMatch[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.includes(pattern)) continue;
      matches.push({ line: index + 1, text: line.slice(0, 2_000) });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private directory(agentId: string): string {
    return join(this.session.sessionDir, 'agents', agentId, 'rlm', 'outputs');
  }

  private path(agentId: string, handle: string): string {
    if (!OUTPUT_HANDLE_PATTERN.test(handle)) throw new Error(`Invalid RLM output handle: ${handle}`);
    return join(this.directory(agentId), `${handle}.log`);
  }

  private async collectGarbage(directory: string): Promise<void> {
    const entries = await this.fs.readdir(directory);
    const files: Array<{ readonly path: string; readonly size: number; readonly mtimeMs: number }> = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.log')) continue;
      const path = join(directory, entry.name);
      const stat = await this.fs.stat(path);
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs ?? 0 });
      total += stat.size;
    }
    if (total <= OUTPUT_SESSION_QUOTA_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      await this.fs.remove(file.path);
      total -= file.size;
      if (total <= OUTPUT_SESSION_QUOTA_BYTES) break;
    }
  }
}

function outputPreview(bytes: Uint8Array): string {
  if (bytes.byteLength <= OUTPUT_PREVIEW_HEAD_BYTES + OUTPUT_PREVIEW_TAIL_BYTES) {
    return Buffer.from(bytes).toString('utf8');
  }
  const head = Buffer.from(bytes.subarray(0, OUTPUT_PREVIEW_HEAD_BYTES)).toString('utf8');
  const tail = Buffer.from(bytes.subarray(bytes.byteLength - OUTPUT_PREVIEW_TAIL_BYTES)).toString('utf8');
  return `${head}\n\n[RLM output preview omitted ${String(bytes.byteLength - OUTPUT_PREVIEW_HEAD_BYTES - OUTPUT_PREVIEW_TAIL_BYTES)} bytes]\n\n${tail}`;
}
