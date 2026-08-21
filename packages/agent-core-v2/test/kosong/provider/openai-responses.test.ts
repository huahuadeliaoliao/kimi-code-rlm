import { describe, expect, it, vi } from 'vitest';

import { generate } from '#/kosong/contract/generate';
import { createToolMessage, type Message, type StreamedMessagePart } from '#/kosong/contract/message';
import type { GenerateOptions } from '#/kosong/contract/provider';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '#/kosong/provider/bases/openai/openai-responses';
import { OpenAIResponsesReplayLedger } from '#/kosong/provider/bases/openai/openai-responses-replay';

async function drain(stream: AsyncIterable<StreamedMessagePart>): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

async function* events(items: readonly Record<string, unknown>[]) {
  yield* items;
}

function completedEvents(text = 'ok'): AsyncIterable<Record<string, unknown>> {
  return events([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'msg_done',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_done',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ]);
}

function captureClient(
  provider: OpenAIResponsesChatProvider,
  responseFactory: () => AsyncIterable<Record<string, unknown>> = completedEvents,
) {
  let params: Record<string, unknown> | undefined;
  let requestOptions: Record<string, unknown> | undefined;
  const client = (provider as unknown as {
    _client: { responses: { create: unknown } };
  })._client;
  client.responses.create = vi.fn().mockImplementation((body: unknown, options: unknown) => {
    params = body as Record<string, unknown>;
    requestOptions = options as Record<string, unknown> | undefined;
    return Promise.resolve(responseFactory());
  });
  return {
    params: () => params,
    requestOptions: () => requestOptions,
  };
}

describe('OpenAI Responses request compatibility', () => {
  it('replays assistant text as an EasyInputMessage with inferred commentary phase', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-5.6-sol', apiKey: 'sk-probe' });
    const capture = captureClient(provider);
    const history: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will inspect it.' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'inspect', arguments: '{}' }],
      },
      createToolMessage('call_1', 'done'),
    ];

    await drain(await provider.generate('', [], history));

    const input = capture.params()?.['input'] as Record<string, unknown>[];
    expect(input[0]).toEqual({
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: 'I will inspect it.',
    });
    expect(input[0]).not.toHaveProperty('id');
    expect(input[0]).not.toHaveProperty('status');
  });

  it('clamps public Responses max_output_tokens to the official minimum', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'sk-probe' });
    const capture = captureClient(provider);

    await drain(await provider.generate('', [], [], { maxCompletionTokens: 3 }));

    expect(capture.params()?.['max_output_tokens']).toBe(16);
  });

  it('uses the ChatGPT Codex Responses subset without persisting a separate protocol', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-5.6-sol',
      apiKey: 'sk-probe',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    });
    const capture = captureClient(provider);
    const options: GenerateOptions = {
      cacheKey: 'session-probe',
      maxCompletionTokens: 128,
      thinking: { effort: 'xhigh' },
    };

    await drain(await provider.generate('system', [], [], options));

    expect(capture.params()).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      text: { verbosity: 'low' },
    });
    expect(capture.params()).not.toHaveProperty('max_output_tokens');
    expect(capture.params()?.['tools']).toBeUndefined();
    expect(capture.requestOptions()?.['headers']).toEqual({
      'session-id': 'session-probe',
      'x-client-request-id': 'session-probe',
    });
  });
});

describe('OpenAI Responses stream lifecycle', () => {
  it('rejects a stream that closes before a terminal response event', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      events([
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'partial',
        },
      ]),
      true,
    );

    await expect(drain(stream)).rejects.toThrow(
      'stream ended before a terminal response event',
    );
  });

  it('uses output_item.done as the authoritative text fallback', async () => {
    const stream = new OpenAIResponsesStreamedMessage(completedEvents('done-only'), true);

    await expect(drain(stream)).resolves.toEqual([{ type: 'text', text: 'done-only' }]);
  });

  it('recovers a function call from output_item.done without an added event', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      events([
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'inspect',
            arguments: '{}',
            status: 'completed',
          },
        },
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed', output: [] },
        },
      ]),
      true,
    );

    await expect(drain(stream)).resolves.toEqual([
      {
        type: 'function',
        id: 'call_1',
        name: 'inspect',
        arguments: '{}',
        _streamIndex: 'fc_1',
      },
    ]);
  });

  it('streams refusal text and reconciles the done value without duplication', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      events([
        {
          type: 'response.refusal.delta',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'cannot ',
        },
        {
          type: 'response.refusal.done',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          refusal: 'cannot comply',
        },
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed', output: [] },
        },
      ]),
      true,
    );

    await expect(drain(stream)).resolves.toEqual([
      { type: 'text', text: 'cannot ' },
      { type: 'text', text: 'comply' },
    ]);
  });

  it('accounts for cache writes separately from ordinary input', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      events([
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 100,
              output_tokens: 7,
              input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
            },
          },
        },
      ]),
      true,
    );

    await drain(stream);

    expect(stream.usage).toEqual({
      inputOther: 50,
      output: 7,
      inputCacheRead: 30,
      inputCacheCreation: 20,
    });
  });
});

describe('OpenAI Responses volatile replay ledger', () => {
  it('replays exact live response items and maps the tool result to the upstream call id', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-5.6-sol', apiKey: 'sk-probe' });
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    const client = (provider as unknown as {
      _client: { responses: { create: unknown } };
    })._client;
    client.responses.create = vi.fn().mockImplementation((body: unknown) => {
      requests.push(body as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          events([
            {
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs_1',
              output_index: 0,
              summary_index: 0,
              delta: 'inspect',
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'rs_1',
                type: 'reasoning',
                status: 'completed',
                summary: [{ type: 'summary_text', text: 'inspect' }],
                encrypted_content: 'opaque',
              },
            },
            {
              type: 'response.output_text.delta',
              item_id: 'msg_1',
              output_index: 1,
              content_index: 0,
              delta: 'Checking.',
            },
            {
              type: 'response.output_item.done',
              output_index: 1,
              item: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
              },
            },
            {
              type: 'response.output_item.added',
              output_index: 2,
              item: {
                id: 'fc_1',
                type: 'function_call',
                call_id: 'call_upstream',
                name: 'inspect',
                arguments: '',
              },
            },
            {
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_1',
              output_index: 2,
              delta: '{}',
            },
            {
              type: 'response.output_item.done',
              output_index: 2,
              item: {
                id: 'fc_1',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_upstream',
                name: 'inspect',
                arguments: '{}',
              },
            },
            {
              type: 'response.completed',
              response: { id: 'resp_1', status: 'completed', output: [] },
            },
          ]),
        );
      }
      return Promise.resolve(completedEvents('finished'));
    });

    const user: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'inspect' }],
      toolCalls: [],
    };
    const first = await generate(provider, '', [], [user], undefined, {
      cacheKey: 'session-ledger',
    });
    const agentCallId = first.message.toolCalls[0]!.id;
    expect(JSON.parse(JSON.stringify(first.message))).toEqual({
      role: 'assistant',
      content: [
        { type: 'think', think: 'inspect', encrypted: 'opaque' },
        { type: 'text', text: 'Checking.' },
      ],
      toolCalls: [
        {
          type: 'function',
          id: 'call_upstream',
          name: 'inspect',
          arguments: '{}',
        },
      ],
    });
    const history = [user, first.message, createToolMessage(agentCallId, 'done')];

    await generate(provider, '', [], history, undefined, { cacheKey: 'session-ledger' });

    const replayInput = requests[1]?.['input'] as Record<string, unknown>[];
    expect(replayInput).toContainEqual(
      expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }),
    );
    expect(replayInput).toContainEqual(
      expect.objectContaining({ type: 'message', id: 'msg_1', phase: 'commentary' }),
    );
    expect(replayInput).toContainEqual(
      expect.objectContaining({
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_upstream',
      }),
    );
    expect(replayInput).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_upstream',
      output: [{ type: 'input_text', text: 'done' }],
    });
  });

  it('fails closed when two live entries are indistinguishable', () => {
    const ledger = new OpenAIResponsesReplayLedger();
    const parent: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'same' }], toolCalls: [] },
    ];
    const capture = {
      responseId: null,
      outputItems: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'same', annotations: [] }],
        },
      ],
    };
    const replayParent = ledger.parent(parent);
    ledger.record('session', replayParent, capture);
    ledger.record('session', replayParent, {
      ...capture,
      outputItems: [
        {
          ...capture.outputItems[0],
          id: 'msg_2',
        },
      ],
    });
    const history: Message[] = [
      ...parent,
      { role: 'assistant', content: [{ type: 'text', text: 'same' }], toolCalls: [] },
    ];

    expect(ledger.resolve('session', history)).toBeUndefined();
  });
});
