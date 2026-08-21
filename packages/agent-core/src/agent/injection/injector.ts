import type { Agent } from '..';

export interface DynamicInjectionResult {
  readonly content: string;
  readonly disclosure?: unknown;
}

export abstract class DynamicInjector {
  protected injectedAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
  }

  onContextCompacted(): void {
    this.injectedAt = null;
  }

  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) {
      this.injectedAt--;
    } else if (index === this.injectedAt) {
      this.injectedAt = null;
    }
  }

  async inject(): Promise<void> {
    const injection = await this.getInjection();
    if (injection === undefined) return;
    const result = typeof injection === 'string' ? { content: injection } : injection;
    if (result.content.length === 0) return;
    this.injectedAt = this.agent.context.history.length;
    const origin =
      result.disclosure === undefined
        ? { kind: 'injection' as const, variant: this.injectionVariant }
        : {
            kind: 'injection' as const,
            variant: this.injectionVariant,
            disclosure: result.disclosure,
          };
    this.agent.context.appendSystemReminder(result.content, origin);
  }

  protected abstract readonly injectionVariant: string;

  protected abstract getInjection():
    | string
    | DynamicInjectionResult
    | Promise<string | DynamicInjectionResult | undefined>
    | undefined;
}
