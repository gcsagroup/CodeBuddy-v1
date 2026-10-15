import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import { currentWorkStage } from './currentWorkStage';

describe('current work stage', () => {
  it('uses a confirmed public stage, retains it across steer, and never reuses it on a new prompt', () => {
    const request: Message = {
      id: 'req',
      role: 'assistant',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'toolRequest',
          id: 'progress',
          toolCall: {
            status: 'success',
            value: {
              name: 'codepro__publish_progress',
              arguments: { text: '开始核对', stage: '未确认的标题' },
            },
          },
        },
      ],
    };
    const response: Message = {
      ...request,
      id: 'response',
      role: 'user',
      content: [
        {
          type: 'toolResponse',
          id: 'progress',
          toolResult: {
            status: 'success',
            value: {
              structuredContent: { published: true, stage: '正在核对任务关联' },
              isError: false,
            },
          },
        },
      ],
    };
    const question: Message = {
      ...request,
      id: 'question',
      role: 'user',
      content: [{ type: 'text', text: '为什么？' }],
      metadata: { userVisible: true, agentVisible: true, steer: true },
    };
    expect(currentWorkStage([request])).toBeUndefined();
    expect(currentWorkStage([request, response, question])).toBe('正在核对任务关联');
    expect(
      currentWorkStage([
        request,
        response,
        { ...question, metadata: { userVisible: true, agentVisible: true } },
      ])
    ).toBeUndefined();
  });

  it('keeps the published context across tools until the next confirmed stage', () => {
    const request = (id: string, name: string, args: Record<string, unknown>): Message => ({
      id: `request-${id}`,
      role: 'assistant',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'toolRequest',
          id,
          toolCall: {
            status: 'success',
            value: { name, arguments: args },
          },
        },
      ],
    });
    const response = (id: string, structuredContent?: Record<string, unknown>): Message => ({
      id: `response-${id}`,
      role: 'user',
      created: 2,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'toolResponse',
          id,
          toolResult: {
            status: 'success',
            value: { isError: false, structuredContent },
          },
        },
      ],
    });
    // Ordering from session 20260928_2: published stage, data.js receipt,
    // then index.html/styles.css without another progress title.
    const messages: Message[] = [
      request('stage', 'codepro__publish_progress', { text: '开始编写数据层' }),
      response('stage', { published: true, stage: '正在编写数据层 data.js' }),
    ];
    expect(currentWorkStage(messages)).toBe('正在编写数据层 data.js');
    messages.push(request('data', 'write', { path: 'edu-demo/data.js', __inputPreview: true }));
    expect(currentWorkStage(messages)).toBe('正在编写数据层 data.js');
    messages.push(response('data'));
    expect(currentWorkStage(messages)).toBe('正在编写数据层 data.js');
    messages.push(request('html', 'write', { path: 'edu-demo/index.html' }), response('html'));
    messages.push(request('css', 'write', { path: 'edu-demo/styles.css' }), response('css'));
    expect(currentWorkStage(messages)).toBe('正在编写数据层 data.js');
    messages.push(request('next', 'codepro__publish_progress', { text: '检查页面' }));
    expect(currentWorkStage(messages)).toBeUndefined();
    messages.push(response('next', { published: true, stage: '正在检查页面' }));
    expect(currentWorkStage(messages)).toBe('正在检查页面');
  });
});
