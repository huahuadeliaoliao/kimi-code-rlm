import { join } from 'pathe';

import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { Error2, ErrorCodes } from '#/errors';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';

import type { IRlmPythonRuntime } from './rlmPythonRuntime';

const BOOTSTRAP_TIMEOUT_MS = 180_000;
const RLM_RUNTIME_DIR = 'rlm-python-v1';

const RLM_PYTHON_BOOTSTRAP = String.raw`
import os
import shutil
import subprocess
import sys
import time
import venv

root = os.path.abspath(sys.argv[1])
lock = root + ".lock"
os.makedirs(os.path.dirname(root), exist_ok=True)
acquired = False
for _ in range(1200):
    try:
        os.mkdir(lock)
        acquired = True
        break
    except FileExistsError:
        try:
            if time.time() - os.path.getmtime(lock) > 300:
                shutil.rmtree(lock, ignore_errors=True)
                continue
        except OSError:
            pass
        time.sleep(0.1)
if not acquired:
    raise RuntimeError("timed out waiting for the RLM Python runtime lock")
try:
    python = os.path.join(root, "Scripts", "python.exe") if os.name == "nt" else os.path.join(root, "bin", "python")
    valid = False
    if os.path.exists(python):
        valid = subprocess.run([python, "-c", "import sys"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not valid:
        shutil.rmtree(root, ignore_errors=True)
        venv.EnvBuilder(with_pip=False, clear=True, symlinks=os.name != "nt").create(root)
    probe = subprocess.run([python, "-c", "import dill"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode != 0:
        uv = shutil.which("uv")
        if uv:
            subprocess.run([uv, "pip", "install", "--python", python, "dill==0.3.8"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check = subprocess.run([python, "-c", "import sys; print(sys.executable)"], capture_output=True, text=True)
    if check.returncode != 0:
        raise RuntimeError(check.stderr.strip() or "managed Python validation failed")
    print(check.stdout.strip(), flush=True)
finally:
    shutil.rmtree(lock, ignore_errors=True)
`;

function readProcessOutput(process: IHostProcess): { readonly stdout: Promise<string>; readonly stderr: Promise<string> } {
  const collect = (stream: NodeJS.ReadableStream): Promise<string> =>
    new Promise((resolve, reject) => {
      let value = '';
      stream.on('data', (chunk: Buffer | string) => {
        if (value.length < 16_384) value += chunk.toString().slice(0, 16_384 - value.length);
      });
      stream.once('end', () => {
        resolve(value);
      });
      stream.once('error', reject);
    });
  return { stdout: collect(process.stdout), stderr: collect(process.stderr) };
}

export class RlmPythonRuntimeService implements IRlmPythonRuntime {
  declare readonly _serviceBrand: undefined;

  private resolving: Promise<string> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly processes: IHostProcessService,
  ) {}

  resolve(): Promise<string> {
    this.resolving ??= this.resolveManagedPython().catch((error) => {
      this.resolving = undefined;
      throw error;
    });
    return this.resolving;
  }

  private async resolveManagedPython(): Promise<string> {
    const commands = ['python3', 'python'] as const;
    const runtimeDir = join(this.bootstrap.cacheDir, RLM_RUNTIME_DIR);
    let lastError: unknown;
    for (const command of commands) {
      let process: IHostProcess;
      try {
        process = await this.processes.spawn(command, ['-u', '-c', RLM_PYTHON_BOOTSTRAP, runtimeDir], {
          env: { PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      process.stdin.end();
      const output = readProcessOutput(process);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          process.wait(),
          new Promise<number>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new Error2(
                ErrorCodes.RLM_KERNEL_UNAVAILABLE,
                'Managed RLM Python setup timed out.',
              ));
            }, BOOTSTRAP_TIMEOUT_MS);
          }),
        ]);
        const [stdout, stderr] = await Promise.all([output.stdout, output.stderr]);
        if (exitCode === 0 && stdout.trim().length > 0) return stdout.trim().split(/\r?\n/).at(-1)!;
        lastError = new Error2(
          ErrorCodes.RLM_KERNEL_UNAVAILABLE,
          'Managed RLM Python setup failed.',
          { details: { exitCode, stderr: stderr.trim().slice(-1000) } },
        );
      } catch (error) {
        lastError = error;
        await process.kill('SIGKILL').catch(() => undefined);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        await process.dispose();
      }
    }
    for (const command of commands) {
      const existing = await this.probeExisting(command);
      if (existing !== undefined) return existing;
    }
    throw new Error2(
      ErrorCodes.RLM_KERNEL_UNAVAILABLE,
      'No usable Python interpreter was found for the managed RLM runtime.',
      { cause: lastError },
    );
  }

  private async probeExisting(command: string): Promise<string | undefined> {
    let process: IHostProcess;
    try {
      process = await this.processes.spawn(
        command,
        ['-c', 'import dill, sys; print(sys.executable)'],
        { env: { PYTHONDONTWRITEBYTECODE: '1' } },
      );
    } catch {
      return undefined;
    }
    process.stdin.end();
    const output = readProcessOutput(process);
    try {
      const exitCode = await process.wait();
      const stdout = await output.stdout;
      await output.stderr;
      if (exitCode !== 0 || stdout.trim().length === 0) return undefined;
      return stdout.trim().split(/\r?\n/).at(-1);
    } finally {
      await process.dispose();
    }
  }
}
