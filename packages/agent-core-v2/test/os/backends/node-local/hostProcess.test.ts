import { describe, expect, it } from 'vitest';

import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      cleanup();
      resolve(buffer.slice(0, index));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

describe('HostProcessService control pipe', () => {
  it('provides a bidirectional fd 3 channel separate from stdout', async () => {
    const service = new HostProcessService();
    const script = [
      "const net = require('node:net');",
      "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
      "let input = '';",
      "control.on('data', chunk => {",
      "  input += chunk.toString();",
      "  if (!input.includes('\\n')) return;",
      "  process.stdout.write('user-output\\n');",
      "  control.end(JSON.stringify({ value: input.trim() }) + '\\n');",
      '});',
    ].join('\n');
    const proc = await service.spawn(process.execPath, ['-e', script], {
      controlPipe: true,
      detached: false,
    });

    expect(proc.control).toBeDefined();
    const controlLine = readLine(proc.control!);
    const stdoutLine = readLine(proc.stdout);
    proc.control!.write('hello-control\n');

    await expect(controlLine).resolves.toBe('{"value":"hello-control"}');
    await expect(stdoutLine).resolves.toBe('user-output');
    await expect(proc.wait()).resolves.toBe(0);
    await proc.dispose();
  });
});
