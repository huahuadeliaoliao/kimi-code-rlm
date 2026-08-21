import { createHash } from 'node:crypto';

import type { Message } from '#/kosong/contract/message';
import type { ResponseInputItem } from 'openai/resources/responses/responses.js';

export type ResponsesOutputItem = Record<string, unknown>;

export interface ResponsesReplayCapture {
  readonly responseId: string | null;
  readonly outputItems: readonly ResponsesOutputItem[];
}

export interface ResponsesReplayParent {
  readonly hashes: readonly string[];
}

export interface ResponsesReplayResolution {
  readonly itemsByHistoryIndex: ReadonlyMap<number, readonly ResponseInputItem[]>;
  readonly upstreamCallIdByAgentCallId: ReadonlyMap<string, string>;
}

interface ReplayView {
  readonly text: string;
  readonly thinking: string;
  readonly encrypted: readonly string[];
  readonly tools: readonly { name: string; arguments: string }[];
}

interface ReplayEntry {
  readonly responseId: string | null;
  readonly parentHashes: readonly string[];
  readonly outputItems: readonly ResponsesOutputItem[];
  readonly view: ReplayView;
  readonly bytes: number;
}

interface ReplayBucket {
  entries: ReplayEntry[];
  bytes: number;
}

const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_SESSION_BUCKETS = 64;
const MAX_ENTRIES_PER_SESSION = 32;

export class OpenAIResponsesReplayLedger {
  private readonly buckets = new Map<string, ReplayBucket>();
  private totalBytes = 0;

  parent(history: readonly Message[]): ResponsesReplayParent {
    return { hashes: conversationSpine(history).map(({ hash }) => hash) };
  }

  record(
    cacheKey: string | undefined,
    parent: ResponsesReplayParent,
    capture: ResponsesReplayCapture,
  ): void {
    if (cacheKey === undefined) return;
    const outputItems = capture.outputItems
      .filter(isReplayableOutputItem)
      .map((item) => structuredClone(item));
    if (outputItems.length === 0) return;
    const view = viewFromOutputItems(outputItems);
    if (isEmptyView(view)) return;
    const bytes = Buffer.byteLength(JSON.stringify(outputItems), 'utf8');
    if (bytes > MAX_ENTRY_BYTES || bytes > MAX_TOTAL_BYTES) return;

    let bucket = this.buckets.get(cacheKey);
    if (bucket === undefined) {
      bucket = { entries: [], bytes: 0 };
      this.buckets.set(cacheKey, bucket);
    } else {
      this.touch(cacheKey, bucket);
    }

    if (
      capture.responseId !== null &&
      bucket.entries.some((entry) => entry.responseId === capture.responseId)
    ) {
      return;
    }

    const entry: ReplayEntry = {
      responseId: capture.responseId,
      parentHashes: [...parent.hashes],
      outputItems,
      view,
      bytes,
    };
    bucket.entries.push(entry);
    bucket.bytes += bytes;
    this.totalBytes += bytes;

    while (bucket.entries.length > MAX_ENTRIES_PER_SESSION) {
      this.evictOldestEntry(cacheKey, bucket);
    }
    while (this.buckets.size > MAX_SESSION_BUCKETS) {
      this.evictOldestBucket();
    }
    while (this.totalBytes > MAX_TOTAL_BYTES && this.buckets.size > 0) {
      const oldest = this.buckets.entries().next().value;
      if (oldest === undefined) break;
      this.evictOldestEntry(oldest[0], oldest[1]);
    }
  }

  resolve(
    cacheKey: string | undefined,
    history: readonly Message[],
  ): ResponsesReplayResolution | undefined {
    if (cacheKey === undefined) return undefined;
    const bucket = this.buckets.get(cacheKey);
    if (bucket === undefined) return undefined;
    this.touch(cacheKey, bucket);

    const spine = conversationSpine(history);
    const candidates = new Map<number, ReplayEntry[]>();
    for (const entry of bucket.entries) {
      if (!isPrefix(entry.parentHashes, spine)) continue;
      const candidate = spine[entry.parentHashes.length];
      if (candidate === undefined || candidate.message.role !== 'assistant') continue;
      if (!sameView(entry.view, viewFromMessage(candidate.message))) continue;
      const atIndex = candidates.get(candidate.historyIndex) ?? [];
      atIndex.push(entry);
      candidates.set(candidate.historyIndex, atIndex);
    }

    const itemsByHistoryIndex = new Map<number, readonly ResponseInputItem[]>();
    const upstreamCallIdByAgentCallId = new Map<string, string>();
    for (const [historyIndex, matches] of candidates) {
      if (matches.length !== 1) continue;
      const entry = matches[0]!;
      itemsByHistoryIndex.set(
        historyIndex,
        entry.outputItems.map(
          (item) => structuredClone(item) as unknown as ResponseInputItem,
        ),
      );
      const message = history[historyIndex];
      if (message === undefined) continue;
      const calls = entry.outputItems.filter(
        (item) => item['type'] === 'function_call',
      );
      for (let i = 0; i < Math.min(message.toolCalls.length, calls.length); i++) {
        const upstreamCallId = calls[i]?.['call_id'];
        if (typeof upstreamCallId === 'string') {
          upstreamCallIdByAgentCallId.set(message.toolCalls[i]!.id, upstreamCallId);
        }
      }
    }

    if (itemsByHistoryIndex.size === 0) return undefined;
    return { itemsByHistoryIndex, upstreamCallIdByAgentCallId };
  }

  private touch(cacheKey: string, bucket: ReplayBucket): void {
    this.buckets.delete(cacheKey);
    this.buckets.set(cacheKey, bucket);
  }

  private evictOldestEntry(cacheKey: string, bucket: ReplayBucket): void {
    const entry = bucket.entries.shift();
    if (entry === undefined) {
      this.buckets.delete(cacheKey);
      return;
    }
    bucket.bytes -= entry.bytes;
    this.totalBytes -= entry.bytes;
    if (bucket.entries.length === 0) this.buckets.delete(cacheKey);
  }

  private evictOldestBucket(): void {
    const oldest = this.buckets.entries().next().value;
    if (oldest === undefined) return;
    this.totalBytes -= oldest[1].bytes;
    this.buckets.delete(oldest[0]);
  }
}

function conversationSpine(
  history: readonly Message[],
): Array<{ historyIndex: number; message: Message; hash: string }> {
  const spine: Array<{ historyIndex: number; message: Message; hash: string }> = [];
  for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
    const message = history[historyIndex]!;
    if (message.role === 'system') continue;
    spine.push({ historyIndex, message, hash: hashMessage(message) });
  }
  return spine;
}

function hashMessage(message: Message): string {
  return createHash('sha256').update(JSON.stringify(messageHashInput(message))).digest('hex');
}

function messageHashInput(message: Message): unknown {
  return {
    role: message.role,
    name: message.name,
    content: message.content,
    toolCalls: message.toolCalls.map(({ type, id, name, arguments: args }) => ({
      type,
      id,
      name,
      arguments: args,
    })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

function isPrefix(
  parentHashes: readonly string[],
  spine: readonly { hash: string }[],
): boolean {
  if (parentHashes.length >= spine.length) return false;
  for (let i = 0; i < parentHashes.length; i++) {
    if (parentHashes[i] !== spine[i]?.hash) return false;
  }
  return true;
}

function isReplayableOutputItem(item: ResponsesOutputItem): boolean {
  return item['type'] === 'message' || item['type'] === 'reasoning' || item['type'] === 'function_call';
}

function viewFromMessage(message: Message): ReplayView {
  const encrypted = new Set<string>();
  let text = '';
  let thinking = '';
  for (const part of message.content) {
    if (part.type === 'text') text += part.text;
    if (part.type === 'think') {
      thinking += part.think;
      if (part.encrypted !== undefined) encrypted.add(part.encrypted);
    }
  }
  return {
    text,
    thinking,
    encrypted: [...encrypted],
    tools: message.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments ?? '{}',
    })),
  };
}

function viewFromOutputItems(items: readonly ResponsesOutputItem[]): ReplayView {
  const encrypted = new Set<string>();
  const tools: Array<{ name: string; arguments: string }> = [];
  let text = '';
  let thinking = '';
  for (const item of items) {
    if (item['type'] === 'message') {
      for (const content of objectArray(item['content'])) {
        if (content['type'] === 'output_text') text += stringField(content, 'text');
        if (content['type'] === 'refusal') {
          text += stringField(content, 'refusal') || stringField(content, 'text');
        }
      }
    } else if (item['type'] === 'reasoning') {
      const encryptedContent = item['encrypted_content'];
      if (typeof encryptedContent === 'string') encrypted.add(encryptedContent);
      for (const part of [...objectArray(item['summary']), ...objectArray(item['content'])]) {
        thinking += stringField(part, 'text');
      }
    } else if (item['type'] === 'function_call') {
      const name = item['name'];
      const args = item['arguments'];
      if (typeof name === 'string') {
        tools.push({ name, arguments: typeof args === 'string' ? args : '{}' });
      }
    }
  }
  return { text, thinking, encrypted: [...encrypted], tools };
}

function objectArray(value: unknown): ResponsesOutputItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ResponsesOutputItem =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function stringField(object: ResponsesOutputItem, key: string): string {
  const value = object[key];
  return typeof value === 'string' ? value : '';
}

function isEmptyView(view: ReplayView): boolean {
  return view.text.length === 0 && view.thinking.length === 0 && view.tools.length === 0;
}

function sameView(left: ReplayView, right: ReplayView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
