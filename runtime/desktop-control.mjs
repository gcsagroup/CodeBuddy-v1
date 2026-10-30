// Live presentation only. Harness remains the owner of execution and cancellation.
const tools = new Set(['open_path', 'list_apps', 'get_app_state', 'click', 'press_key',
  'type_text', 'drag', 'scroll', 'set_value', 'perform_secondary_action']
  .map(name => `mcp__qwen_computer__${name}`));

export function desktopControlPresentation({ sessionId, token, notify }) {
  let active = false;
  const publish = state => {
    try { notify('_goose/unstable/session/update', { sessionId,
      update: { sessionUpdate: 'status_message', status: { type: 'progress', message: '',
        data: { event: 'desktop_control', token, active: state } } } });
    } catch { /* A lost presentation channel must not fail or replay native input. */ }
  };
  return {
    update(state) {
      active = state.active;
      try { notify('_goose/unstable/session/update', { sessionId,
        update: { sessionUpdate: 'status_message', status: { type: 'progress', message: '',
          data: { event: 'desktop_control', token, ...state } } } }); } catch {}
    },
    start(tool) {
      if (!tools.has(tool.name)) return;
      active = true;
      publish(true);
    },
    end() {
      if (!active) return;
      active = false;
      publish(false);
    },
  };
}

export function matchesDesktopCancel(active, token) {
  return typeof token === 'string' && token.length > 0 && active?.desktopControlToken === token;
}
