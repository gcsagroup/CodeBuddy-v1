// ACP presentation only. Harness owns the questions, deadlines and late replies.
export function questionForm(sessionId, questions, wait) {
  const properties = Object.fromEntries(questions.map((q, i) => [`answer_${i}`, {
    type: q.multiSelect && q.options?.length ? 'array' : 'string', title: q.question,
    ...(q.detail ? { description: q.detail } : {}),
    ...(q.multiSelect && q.options?.length ? { items: { type: 'string', enum: q.options.map(o => o.label) } } : {}),
  }]));
  const questionFields = Object.fromEntries(questions.flatMap((q, i) => {
    if (!q.options?.length) return [];
    const customKey = q.multiSelect ? `answer_${i}_custom` : undefined;
    if (customKey) properties[customKey] = { type: 'string', title: q.question };
    return [[`answer_${i}`, { options: q.options, ...(customKey ? { customKey } : {}) }]];
  }));
  return {
    sessionId, mode: 'form', message: '', requestedSchema: { type: 'object', properties },
    _meta: { 'codepro/questionFields': questionFields, ...(wait ? { 'codebuddy/question': wait } : {}) },
  };
}

export function questionAnswer(questions, reply) {
  if (reply?.action === 'cancel' || reply?.action === 'decline')
    return { answers: questions.map(q => ({ id: q.id, selected: [] })) };
  if (reply?.action !== 'accept') throw new Error('未收到有效的用户答复。');
  return { answers: questions.map((q, i) => {
    const answer = reply.content?.[`answer_${i}`];
    const values = answer === undefined || answer === '' ? [] : q.multiSelect && Array.isArray(answer) ? answer : [answer];
    if (values.some(value => typeof value !== 'string')) throw new Error('用户答复格式无效。');
    const selected = values.filter(value => (q.options ?? []).some(o => o.label === value));
    const customAnswer = reply.content?.[`answer_${i}_custom`];
    if (customAnswer !== undefined && typeof customAnswer !== 'string') throw new Error('用户答复格式无效。');
    const custom = [...values.filter(value => !(q.options ?? []).some(o => o.label === value)), ...(q.multiSelect && customAnswer ? [customAnswer] : [])].join('\n');
    return { id: q.id, selected, ...(custom ? { custom } : {}) };
  }) };
}

export function questionNotification(sessionId, snapshot) {
  return { sessionId, update: { sessionUpdate: 'session_info_update', _meta: {
    'codebuddy/questions': {
      active: snapshot.active.map(q => ({ callId: q.callId, state: q.state,
        request: questionForm(sessionId, q.questions, { callId: q.callId, nativeSessionId: snapshot.nativeSessionId, state: q.state }) })),
      settled: snapshot.settled.map(q => ({ callId: q.callId,
        skipped: q.answers.every(a => a.selected.length === 0 && !a.custom) })),
    },
  } } };
}
