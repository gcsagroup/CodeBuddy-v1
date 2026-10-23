// Render only structured native failures. A timeout or a connection error
// alone cannot establish whether the user's network or the service is at fault.
function requestFailureMessage(failure, observation) {
  const status = observation?.status;
  if (status === 401) return '模型服务未通过身份验证（HTTP 401）';
  if (status === 403) return '模型服务拒绝访问（HTTP 403）';
  if (status === 429) return '模型服务限制了请求（HTTP 429）';
  if (status >= 500) return `模型服务返回错误（HTTP ${status}）`;
  const codes = observation?.transportCodes ?? [];
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return '无法解析模型服务域名';
  if (codes.includes('ECONNREFUSED')) return '连接模型服务被拒绝';
  if (codes.some(code => ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code))) return '连接模型服务超时，原因尚未确认';
  if (codes.includes('UND_ERR_HEADERS_TIMEOUT')) return '等待模型服务响应超时，原因尚未确认';
  if (codes.includes('UND_ERR_BODY_TIMEOUT')) return '接收模型响应超时，原因尚未确认';
  return ({
    AUTH: '模型服务未通过身份验证',
    RATE_LIMIT: '模型服务报告请求受限',
    QUOTA: '模型服务报告额度不足',
    TIMEOUT: '模型请求超时，原因尚未确认',
    TRANSPORT: '模型连接发生错误，原因尚未确认',
    EMPTY_RESPONSE: '模型响应已结束，但没有返回可用内容',
    CONTEXT_WINDOW_EXCEEDED: '模型服务报告上下文超出限制',
  })[failure?.code] ?? '请求失败，具体原因尚未确认';
}

// Live presentation only. Native events remain the execution/terminal authority.
export function workStatusUpdates({ sessionId, sourceMessageId, runId, signal }) {
  const children = new Set();
  const observations = new Map();
  const retryMessages = new Map();
  let previous;
  let lastToolInputAt = 0;
  return event => {
    if (signal?.aborted) return [];
    let phase, modelRequestPhase, toolInput, message = '', type = 'progress';
    if (event.type === 'model_diagnostic' && event.sessionId) {
      if (event.phase === 'start') observations.delete(event.sessionId);
      else if (event.phase === 'end' && !event.cancelled)
        observations.set(event.sessionId, { status: event.status, transportCodes: event.transportCodes });
    }
    const native = event.type === 'harness_event' ? event.event : undefined;
    const retryStarted = (event.type === 'model_diagnostic' && event.phase === 'start') || native?.type === 'llm/retry-started';
    const clearedRetry = retryStarted && retryMessages.delete(event.sessionId);
    if (native?.type === 'turn/end') retryMessages.delete(event.sessionId);
    if (event.type === 'subagent_end') retryMessages.delete(event.childSessionId);
    if (event.type === 'image_observation' && event.sessionId === sessionId) {
      phase = children.size ? 'children' : 'model';
      message = event.phase === 'start' ? `正在识别图片（${event.modelId}）` : '图片识别完成，正在等待主模型回答';
    } else if (native?.type === 'llm/retry') {
      const data = native.data;
      const count = Number.isSafeInteger(data.retry) && data.retry > 0
        ? Number.isSafeInteger(data.maxRetries) && data.maxRetries >= data.retry
          ? `（${data.retry}/${data.maxRetries}）` : `（第 ${data.retry} 次）`
        : '';
      const delay = Number.isFinite(data.delayMs) && data.delayMs > 0 ? `，约 ${Math.ceil(data.delayMs / 1000)} 秒后尝试` : '';
      const action = ['TRANSPORT', 'TIMEOUT'].includes(data.failure?.code) ? '正在重新连接' : '正在重试模型请求';
      phase = children.size ? 'children' : 'model';
      message = `${event.sessionId !== sessionId ? '子任务：' : ''}${action}${count}${delay}；${requestFailureMessage(data.failure, observations.get(event.sessionId))}`;
      retryMessages.set(event.sessionId, message);
    } else if (native?.type === 'turn/end' && native.data?.reason?.kind === 'error') {
      message = requestFailureMessage(native.data.reason.error, observations.get(event.sessionId));
      if (event.sessionId === sessionId) { phase = 'model'; type = 'notice'; }
      else { children.delete(event.sessionId); phase = children.size ? 'children' : 'child_result'; message = `子任务：${message}；等待主 Agent 处理`; }
    } else if (event.type === 'subagent_start' && event.sessionId === sessionId) {
      children.add(event.childSessionId);
      phase = 'children';
    } else if (event.type === 'subagent_end' && children.delete(event.childSessionId)) {
      phase = children.size ? 'children' : 'child_result';
    } else if (event.type === 'harness_event' && event.sessionId && event.sessionId !== sessionId) {
      // Native turns cover resumed children too; spawning is not the only way to work.
      if (event.event.type === 'turn/start') {
        children.add(event.sessionId);
        phase = 'children';
      } else if (event.event.type === 'turn/end' && children.delete(event.sessionId)) {
        phase = children.size ? 'children' : 'child_result';
      }
    } else if (event.sessionId === sessionId) {
      if (event.type === 'tool_input') {
        phase = children.size ? 'children' : 'model';
        if (!children.size) { toolInput = event.preview; modelRequestPhase = 'receiving'; }
      } else if (event.type === 'model_diagnostic') {
        modelRequestPhase = ({ start: 'preparing', request_created: 'connecting', request_sent: 'waiting', response_headers: 'receiving', first_tool_arguments: 'receiving', first_text: 'receiving', first_reasoning: 'receiving' })[event.phase];
        if (event.phase === 'first_tool_arguments' && !children.size)
          message = '正在生成工具调用参数';
        if (event.phase === 'response_headers' && !(event.status >= 200 && event.status < 300)) modelRequestPhase = undefined;
        if (!modelRequestPhase && !['end', 'response_headers'].includes(event.phase)) return [];
        phase = children.size ? 'children' : 'model';
      } else if (['assistant_start', 'assistant_end', 'assistant_committed', 'tool_call'].includes(event.type))
        phase = children.size ? 'children' : 'model';
      else if (event.type === 'tool_result' && !event.internalControl)
        phase = children.size ? 'children' : 'tool_result';
    }
    if (!phase && clearedRetry) phase = children.size ? 'children' : 'model';
    if (!phase) return [];
    // One worker's recovery cannot clear another worker's active backoff.
    if (type === 'progress' && retryMessages.size) message = [...retryMessages.values()].at(-1);
    const key = `${phase}:${children.size}:${modelRequestPhase ?? ''}:${message}:${JSON.stringify(toolInput)}`;
    const now = Date.now();
    // A real fragment can arrive without changing a complete field or size.
    // Preserve that reception fact, bounded to 1 Hz; never synthesize a timer.
    if (key === previous && (!toolInput || now - lastToolInputAt < 1000)) return [];
    previous = key;
    if (toolInput) lastToolInputAt = now;
    return [{ sessionUpdate: 'status_message', status: { type, message, data: {
      schema_version: 1, event: 'execution_activity', source_user_message_id: sourceMessageId,
      run_id: typeof runId === 'function' ? runId() : runId, phase, child_count: children.size,
      ...(phase === 'model' && modelRequestPhase ? { model_request_phase: modelRequestPhase } : {}),
      ...(toolInput ? { tool_input: toolInput } : {}),
    } } }];
  };
}
