import type { WebContents } from 'electron';
export interface BrowserControlInput {
  operation: 'open' | 'observe' | 'click' | 'type' | 'key' | 'screenshot' | 'console' | 'close';
  id?: string;
  url?: string;
  htmlPath?: string;
  node?: number;
  text?: string;
  key?: string;
}
export class BrowserController {
  private nodes = new Set<number>();
  private messages: string[] = [];
  constructor(private wc: WebContents) {
    wc.on('did-start-navigation', (_e, _url, inPlace, main) => {
      if (main && !inPlace) this.nodes.clear();
    });
    wc.on('console-message', (_e, level, message) => {
      this.messages.push(`${level}: ${message}`.slice(0, 2000));
      this.messages = this.messages.slice(-50);
    });
  }
  async run(input: BrowserControlInput) {
    if (this.wc.isDestroyed()) throw new Error('Browser tab was closed');
    if (input.operation === 'console') return { messages: [...this.messages] };
    if (input.operation === 'screenshot') {
      const png = await this.wc.capturePage();
      return {
        content: [{ type: 'image', mimeType: 'image/png', data: png.toPNG().toString('base64') }],
      };
    }
    const debug = this.wc.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    if (input.operation === 'observe') {
      const result = await debug.sendCommand('Accessibility.getFullAXTree');
      const meaningful = result.nodes
        .filter(
          (n: { ignored: boolean; backendDOMNodeId?: number }) => !n.ignored && n.backendDOMNodeId
        )
        .filter(
          (n: {
            name?: { value: unknown };
            value?: { value: unknown };
            role?: { value: string };
          }) =>
            String(n.name?.value ?? '').trim() ||
            String(n.value?.value ?? '').trim() ||
            [
              'RootWebArea',
              'textbox',
              'searchbox',
              'combobox',
              'checkbox',
              'radio',
              'button',
              'link',
              'slider',
              'spinbutton',
            ].includes(n.role?.value ?? '')
        );
      // Empty layout containers otherwise exhaust the budget before search
      // results and form controls. Keep unnamed controls because they still act.
      const nodes = meaningful
        .slice(0, 400)
        .map(
          (n: {
            backendDOMNodeId: number;
            role?: { value: string };
            name?: { value: string };
            value?: { value: string };
            properties?: { name: string; value: { value: unknown } }[];
          }) => ({
            node: n.backendDOMNodeId,
            role: n.role?.value,
            name: n.name ? String(n.name.value).slice(0, 1000) : undefined,
            value: n.value ? String(n.value.value).slice(0, 2000) : undefined,
            // Form controls need their actual state to verify a click; a label
            // alone cannot distinguish an unchecked box from a checked one.
            ...Object.fromEntries(
              (n.properties ?? [])
                .filter((p) =>
                  ['checked', 'selected', 'disabled', 'required', 'expanded'].includes(p.name)
                )
                .filter(
                  (p) =>
                    typeof p.value.value === 'boolean' ||
                    ['true', 'false', 'mixed'].includes(String(p.value.value))
                )
                .map((p) => [p.name, p.value.value])
            ),
          })
        );
      this.nodes = new Set(nodes.map((n: { node: number }) => n.node));
      return {
        url: this.wc.getURL(),
        title: this.wc.getTitle(),
        nodes,
        truncated: meaningful.length > 400,
      };
    }
    if (['click', 'type'].includes(input.operation)) {
      if (!Number.isInteger(input.node) || input.node! < 1)
        throw new Error(
          `${input.operation} requires a positive integer node from observe, even when the element is focused.`
        );
      if (!this.nodes.has(input.node!))
        throw new Error('Observe this tab first and use a returned node');
      if (input.operation === 'type') {
        if (typeof input.text !== 'string' || input.text.length > 20000)
          throw new Error('Invalid browser text');
        await debug.sendCommand('DOM.focus', { backendNodeId: input.node });
        await debug.sendCommand('Input.insertText', { text: input.text });
      } else {
        const { node } = await debug.sendCommand('DOM.describeNode', { backendNodeId: input.node });
        if (node.localName === 'option') {
          throw new Error(
            'Native select options have no clickable page box. Click the owning combobox, use key ArrowDown/ArrowUp and Enter, then observe its value. Do not retry clicking this option.'
          );
        }
        await debug.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: input.node });
        const { model } = await debug.sendCommand('DOM.getBoxModel', { backendNodeId: input.node });
        const q = model.content as number[];
        const x = (q[0] + q[2] + q[4] + q[6]) / 4,
          y = (q[1] + q[3] + q[5] + q[7]) / 4;
        // A fresh hit test prevents a newly opened overlay from receiving this click.
        const { object } = await debug.sendCommand('DOM.resolveNode', {
          backendNodeId: input.node,
        });
        try {
          const hit = await debug.sendCommand('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration:
              // Document hit testing returns a shadow host rather than its inner
              // button. Check every containing root so overlays still reject.
              'function(x, y) { let target = this; while (target) { const root = target.getRootNode(); const hit = root.elementFromPoint?.(x, y); if (target !== hit && !target.contains(hit)) return false; target = root.host; } return true; }',
            arguments: [{ value: x }, { value: y }],
            returnByValue: true,
          });
          if (hit.result?.value !== true)
            throw new Error('Target is covered or outside the viewport. Observe the page again.');
        } finally {
          await debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
        }
        await debug.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await debug.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      }
      return {
        dispatched: true,
        verified: false,
        next: 'Observe the page to verify the result; do not repeat an uncertain submission.',
      };
    }
    const keys: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      ArrowDown: 40,
      ArrowUp: 38,
    };
    if (
      input.operation === 'key' &&
      input.key &&
      Object.prototype.hasOwnProperty.call(keys, input.key)
    ) {
      await debug.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: input.key,
        windowsVirtualKeyCode: keys[input.key],
        ...(input.key === 'Enter' ? { text: '\r' } : {}),
      });
      await debug.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: input.key,
        windowsVirtualKeyCode: keys[input.key],
      });
      return { dispatched: true, verified: false };
    }
    throw new Error('Unsupported browser operation');
  }
}
