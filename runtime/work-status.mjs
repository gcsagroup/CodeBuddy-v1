// Render only structured native failures. A timeout or a connection error
// alone cannot establish whether the user's network or the service is at fault.
function requestFailurePresentation(failure, observation) {
  const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
  const status = validStatus(failure?.status) ? failure.status : validStatus(observation?.status) ? observation.status : undefined;
  const http = status >= 300 ? `（HTTP ${status}）` : '';
  const code = failure?.code;
  let message, action;
  // Native semantic failures carry more information than a generic HTTP class.
  // Never inspect provider prose here or turn presentation into retry policy.
  if (['CONTEXT_WINDOW_EXCEEDED', 'LOCAL_OUTPUT_BUDGET_EXHAUSTED', 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED'].includes(code)) {
    message = '当前模型的上下文放不下这次请求及所需回复';
    action = '可先压缩历史；若仍超限，请缩短本轮输入、减少启用的工具，或切换到更大窗口的模型。';
  } else if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') {
    message = `模型服务报告账户额度不足或已达使用上限${http}`;
    action = '请检查当前模型连接的余额和使用上限，恢复额度或切换可用模型后，在当前对话继续。';
  } else if (code === 'EMPTY_RESPONSE') {
    message = observation?.reasoningDeltaChars > 0 && observation.textDeltaChars === 0 && observation.toolCallBlocks === 0
      ? '模型只返回了思考内容，没有返回正文或有效工具调用'
      : '模型响应已结束，但没有返回正文或有效工具调用';
    action = '可重试或切换模型；若持续出现，请检查模型服务的输出格式。';
  } else if (code === 'OUTPUT_LIMIT_REACHED' || code === 'OUTPUT_TRUNCATED' || code === 'OUTPUT_LENGTH_STOP') {
    message = code === 'OUTPUT_LIMIT_REACHED' ? '模型这一步达到输出长度限制，任务尚未完成'
      : code === 'OUTPUT_TRUNCATED' ? '模型响应提前截断，任务尚未完成'
      : '模型服务报告响应长度受限，实际输出额度或用量尚未确认';
    action = '请检查模型的输出上限，或切换模型后在当前对话继续。';
  } else if (code === 'INVALID_OUTPUT_BUDGET') {
    message = '设置的输出额度不符合模型服务的限制';
    action = '请调整模型输出额度后继续。';
  } else if (['NO_ADAPTER', 'UNKNOWN_PROVIDER', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND'].includes(code)) {
    message = '当前模型的连接配置不可用';
    action = '请检查模型与连接设置，重新选择可用连接后继续。';
  } else if (['MALFORMED_RESPONSE', 'STREAM_CLOSED'].includes(code)) {
    message = code === 'MALFORMED_RESPONSE' ? '模型服务返回的数据格式无效' : '模型响应在完整结束前中断';
    action = '若持续出现，请检查模型服务或网关的流式响应兼容性。';
  } else if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || status === 401 || status === 403) {
    message = status === 403 ? `模型服务拒绝访问${http}` : `模型服务未通过身份验证${http}`;
    action = '请检查当前模型连接的密钥、登录状态和访问权限。';
  } else if (status === 402) {
    message = `模型服务要求处理账户额度或付费状态${http}`;
    action = '请检查当前连接的余额和使用上限，处理后在当前对话继续。';
  } else if (status === 413) {
    message = `模型服务或网关拒绝了请求：请求体过大${http}`;
    action = '请减少本轮输入、图片或附件大小；若仍出现，请检查网关的请求大小限制。';
  } else if (status === 400 || status === 422) {
    message = `模型服务拒绝了请求参数${http}`;
    action = '请在模型连接设置中检查 API 基础路径、工具调用支持和思考强度。';
  } else if (status === 404) {
    message = `模型或 API 路径不存在，或当前账号无权访问${http}`;
    action = '请检查模型名称和 API 基础路径。';
  } else if (code === 'RATE_LIMIT' || status === 429) {
    message = `模型服务报告请求受限${http}`;
    action = '请稍后在当前对话继续；若持续受限，请检查服务状态、请求限制和账户额度。';
  } else if (status >= 500 || code === 'SERVER') {
    message = `模型请求返回服务端错误${http}`;
    action = '可稍后继续；若持续出现，请检查模型服务或网关状态。';
  } else {
    const codes = observation?.transportCodes ?? [];
    if (codes.some(value => ['ENOTFOUND', 'EAI_AGAIN'].includes(value))) message = '无法解析模型服务域名';
    else if (codes.includes('ECONNREFUSED')) message = '连接模型服务被拒绝';
    else if (codes.some(value => ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(value))) message = '连接模型服务超时，原因尚未确认';
    else if (codes.includes('UND_ERR_HEADERS_TIMEOUT')) message = '等待模型服务响应超时，原因尚未确认';
    else if (codes.includes('UND_ERR_BODY_TIMEOUT')) message = '接收模型响应超时，原因尚未确认';
    else if (codes.some(value => ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(value))) {
      message = '模型连接的 TLS 证书验证失败';
      action = '请检查模型服务的证书链、代理和系统时间。';
    } else if (code === 'TRANSPORT') message = '模型连接发生错误，原因尚未确认';
    else if (code === 'TIMEOUT') message = '模型请求超时，原因尚未确认';
    else if (code === 'INVALID_REQUEST' || code === 'UNSUPPORTED_CONTENT' || code === 'UNSUPPORTED_OPTION') {
      message = '模型服务不接受当前请求或选项';
      action = '请检查当前模型支持的输入、工具调用和思考设置。';
    } else if (status >= 300) message = `模型服务未能接受这次请求${http}`;
    else if (status >= 200) message = '模型服务已返回响应，但本次响应未能正常完成';
    else message = '本轮请求未能完成，具体原因尚未确认';
    action ??= status >= 200 || codes.length || code === 'TRANSPORT' || code === 'TIMEOUT'
      ? '请确认模型服务与连接状态后，在当前对话继续。'
      : '请根据详细原因处理后，在当前对话继续。';
  }
  return { message, action };
}

export function requestFailureMessage(failure, observation, terminal = false) {
  const { message, action } = requestFailurePresentation(failure, observation);
  return terminal ? `${message}。本轮已停止。${action}详细信息可展开“查看未完成原因”。` : message;
}

export function requestFailureAdvice(failure, observation) {
  const { message, action } = requestFailurePresentation(failure, observation);
  return `${message}。${action}`;
}

// Live presentation only. Native events remain the execution/terminal authority.
export function workStatusUpdates({ sessionId, sourceMessageId, runId, signal }) {
  const children = new Set();
  const observations = new Map();
  const activeRequests = new Map();
  const retryMessages = new Map();
  const activeTools = new Set();
  let previous;
  let lastToolInputAt = 0;
  let modelRequestStartedAt;
  let consecutiveToolFailures = 0;
  let responseRetries = 0;
  const observationFor = (id, failure) => {
    const observation = observations.get(id);
    if (observation?.finishKind && observation.finishKind !== 'error') return undefined;
    return observation?.failureCode && observation.failureCode !== failure?.code ? undefined : observation;
  };
  return event => {
    if (signal?.aborted) return [];
    // Auxiliary summaries, image inspection and execution reports share the
    // session but do not own its main request status or waiting clock.
    if (event.type === 'model_diagnostic') {
      if (event.purpose) return [];
      if (event.phase === 'start') {
        observations.delete(event.sessionId);
        activeRequests.delete(event.sessionId);
        if (typeof event.requestId === 'string') activeRequests.set(event.sessionId, event.requestId);
      } else if (activeRequests.has(event.sessionId) && activeRequests.get(event.sessionId) !== event.requestId) return [];
    }
    if (event.sessionId === sessionId) {
      if (event.type === 'model_diagnostic' && event.phase === 'start') modelRequestStartedAt = Date.now();
      if (event.type === 'tool_call' || event.type === 'assistant_end' ||
          event.type === 'model_diagnostic' && event.phase === 'end') modelRequestStartedAt = undefined;
      if (event.type === 'tool_result' && !event.internalControl) {
        const failed = event.isError === true || event.executionFailed === true;
        consecutiveToolFailures = failed ? Math.min(consecutiveToolFailures + 1, 10_000) : 0;
        if (!failed) responseRetries = 0;
      }
      if (event.type === 'tool_call' && !event.internalControl && typeof event.id === 'string') activeTools.add(event.id);
      if (event.type === 'tool_result') activeTools.delete(event.id);
      // The native loop awaits the whole tool batch before this next stream.
      // Clear display occupancy only; missing receipts still have unknown results.
      if (event.type === 'assistant_start') activeTools.clear();
    }
    let phase, modelRequestPhase, toolInput, message = '', type = 'progress';
    if (event.type === 'model_diagnostic' && event.sessionId) {
      if (event.phase === 'start') observations.delete(event.sessionId);
      else if (event.phase === 'end' && !event.cancelled)
        observations.set(event.sessionId, {
          status: event.status, transportCodes: event.transportCodes,
          failureCode: event.failureCode, finishKind: event.finishKind,
          textDeltaChars: event.textDeltaChars, reasoningDeltaChars: event.reasoningDeltaChars,
          toolCallBlocks: event.toolCallBlocks,
        });
    }
    const native = event.type === 'harness_event' ? event.event : undefined;
    if (event.sessionId === sessionId && native?.type === 'llm/retry') {
      const observation = observationFor(sessionId, native.data?.failure);
      // Retry counts describe observed response trouble, never model quality.
      // Transport/HTTP failures retain their existing connection diagnostics.
      const responseFailure = ['EMPTY_RESPONSE', 'OUTPUT_TRUNCATED', 'OUTPUT_LIMIT_REACHED'].includes(native.data?.failure?.code) ||
        native.data?.failure?.code === 'SERVER' && observation?.status >= 200 && observation.status < 300;
      responseRetries = responseFailure && !observation?.transportCodes?.length
        ? Math.min(responseRetries + 1, 10_000) : 0;
    }
    const retryStarted = (event.type === 'model_diagnostic' && event.phase === 'start') || native?.type === 'llm/retry-started';
    const clearedRetry = retryStarted && retryMessages.delete(event.sessionId);
    if (native?.type === 'turn/end') retryMessages.delete(event.sessionId);
    if (event.type === 'subagent_end') retryMessages.delete(event.childSessionId);
    if (event.type === 'image_observation' && event.sessionId === sessionId) {
      phase = children.size ? 'children' : 'model';
      message = event.phase === 'start' ? '正在识别图片' : '图片识别完成，正在等待主模型回答';
    } else if (event.type === 'output_recovery') {
      phase = children.size ? 'children' : 'model';
      const count = Number.isSafeInteger(event.attempt) && event.attempt > 0
        ? Number.isSafeInteger(event.maxAutomaticAttempts) && event.maxAutomaticAttempts >= event.attempt
          ? `（${event.attempt}/${event.maxAutomaticAttempts}）` : `（第 ${event.attempt} 次）`
        : '';
      message = `${event.sessionId !== sessionId ? '子任务：' : ''}模型这一步达到输出长度限制，正在保留进度并尝试恢复${count}`;
    } else if (native?.type === 'llm/retry') {
      const data = native.data;
      const count = Number.isSafeInteger(data.retry) && data.retry > 0
        ? Number.isSafeInteger(data.maxRetries) && data.maxRetries >= data.retry
          ? `（${data.retry}/${data.maxRetries}）` : `（第 ${data.retry} 次）`
        : '';
      const delay = Number.isFinite(data.delayMs) && data.delayMs > 0 ? `，约 ${Math.ceil(data.delayMs / 1000)} 秒后尝试` : '';
      const action = ['TRANSPORT', 'TIMEOUT'].includes(data.failure?.code) ? '正在重新连接' : '正在重试模型请求';
      phase = children.size ? 'children' : 'model';
      message = `${event.sessionId !== sessionId ? '子任务：' : ''}${action}${count}${delay}；${requestFailureMessage(data.failure, observationFor(event.sessionId, data.failure))}`;
      retryMessages.set(event.sessionId, message);
    } else if (native?.type === 'turn/end' && native.data?.reason?.kind === 'error') {
      message = requestFailureMessage(native.data.reason.error, observationFor(event.sessionId, native.data.reason.error), event.sessionId === sessionId);
      if (event.sessionId === sessionId) {
        phase = 'model'; type = 'notice';
      }
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
        // HTTP headers acknowledge the connection, not a model output token.
        modelRequestPhase = ({ start: 'preparing', request_created: 'connecting', request_sent: 'waiting', response_headers: 'waiting', first_tool_arguments: 'receiving', first_text: 'receiving', first_reasoning: 'receiving' })[event.phase];
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
    const toolIds = [...activeTools];
    const key = `${phase}:${children.size}:${modelRequestPhase ?? ''}:${message}:${JSON.stringify(toolInput)}:${JSON.stringify(toolIds)}:${modelRequestStartedAt}:${consecutiveToolFailures}:${responseRetries}`;
    const now = Date.now();
    // A real fragment can arrive without changing a complete field or size.
    // Preserve that reception fact, bounded to 1 Hz; never synthesize a timer.
    if (key === previous && (!toolInput || now - lastToolInputAt < 1000)) return [];
    previous = key;
    if (toolInput) lastToolInputAt = now;
    return [{ sessionUpdate: 'status_message', status: { type, message, data: {
      schema_version: 1, event: 'execution_activity', source_user_message_id: sourceMessageId,
      run_id: typeof runId === 'function' ? runId() : runId, phase, child_count: children.size,
      active_tool_call_ids: toolIds,
      response_retries: responseRetries, consecutive_tool_failures: consecutiveToolFailures,
      ...(phase === 'model' && modelRequestStartedAt !== undefined ? { model_request_started_at: modelRequestStartedAt } : {}),
      ...(phase === 'model' && modelRequestPhase ? { model_request_phase: modelRequestPhase } : {}),
      ...(toolInput ? { tool_input: toolInput } : {}),
    } } }];
  };
}
