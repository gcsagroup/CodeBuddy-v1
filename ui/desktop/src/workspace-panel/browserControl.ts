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

// This isolated world holds only the decoration; it exposes no browser control to the page.
const feedbackWorld = 1701;
function paintClick(x: number, y: number) {
  const world = globalThis as typeof globalThis & { codeBuddyClickRing?: HTMLElement };
  world.codeBuddyClickRing?.remove();
  const ring = document.createElement('span');
  world.codeBuddyClickRing = ring;
  ring.setAttribute('aria-hidden', 'true');
  ring.inert = true;
  ring.style.cssText = 'all:initial;display:block!important;position:fixed!important;pointer-events:none!important;' +
    'z-index:2147483647!important;box-sizing:border-box!important;border-radius:50%!important;' +
    'border:2px solid #3bb4ff!important;background:rgba(59,180,255,.18)!important;' +
    'box-shadow:0 0 0 4px rgba(59,180,255,.25)!important;width:24px!important;height:24px!important;' +
    `left:${x - 12}px!important;top:${y - 12}px!important;`;
  (document.fullscreenElement ?? document.documentElement).append(ring);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    ring.animate([{ scale: '0.65' }, { scale: '1.3', offset: 0.4 }, { scale: '1' }], 650);
  setTimeout(() => {
    ring.remove();
    if (world.codeBuddyClickRing === ring) delete world.codeBuddyClickRing;
  }, 1100);
}

export class BrowserController {
  private nodes = new Set<number>();
  private messages: string[] = [];
  private hasClickMarker = false;
  constructor(private wc: WebContents) {
    wc.on('did-start-navigation', (_e, _url, inPlace, main) => {
      if (main && !inPlace) {
        this.nodes.clear();
        this.hasClickMarker = false;
      }
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
      await this.clearClickMarker();
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
        if (node.nodeType !== 1) {
          throw new Error(
            'Target is a text node, not an element. Choose the observed button, link or form control that performs the intended action; do not retry this text node.'
          );
        }
        if (node.localName === 'option') {
          await this.selectOption(input.node!);
        } else {
          const { x, y } = await this.clickPoint(input.node!);
          await this.markClick(x, y);
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

  private async clickPoint(backendNodeId: number) {
    const debug = this.wc.debugger;
    await debug.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = await debug.sendCommand('DOM.getBoxModel', { backendNodeId });
    const q = model.content as number[];
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    const { object } = await debug.sendCommand('DOM.resolveNode', { backendNodeId });
    try {
      const hit = await debug.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        // Check every containing shadow root so an outer overlay still rejects.
        functionDeclaration:
          'function(x, y) { let target = this; while (target) { const root = target.getRootNode(); const hit = root.elementFromPoint?.(x, y); if (target !== hit && !target.contains(hit)) return false; target = root.host; } return true; }',
        arguments: [{ value: x }, { value: y }],
        returnByValue: true,
      });
      if (hit.result?.value !== true)
        throw new Error('Target is covered or outside the viewport. Observe the page again.');
      return { x, y };
    } finally {
      await debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    }
  }

  private async markClick(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      await this.wc.executeJavaScriptInIsolatedWorld(feedbackWorld, [{ code: `(${paintClick})(${x},${y})` }]);
      this.hasClickMarker = true;
    } catch {
      // Navigation or a closed renderer can race a decorative frame.
    }
  }

  private async clearClickMarker() {
    if (!this.hasClickMarker) return;
    this.hasClickMarker = false;
    await this.wc.executeJavaScriptInIsolatedWorld(feedbackWorld, [{
      // capturePage can return the previous compositor frame just after a DOM removal.
      // Background tabs may suspend animation frames, so keep the wait bounded.
      code: `(() => {
        if (!globalThis.codeBuddyClickRing) return;
        globalThis.codeBuddyClickRing.remove();
        delete globalThis.codeBuddyClickRing;
        return new Promise(resolve => {
          const fallback = setTimeout(resolve, 120);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(fallback);
            resolve();
          }));
        });
      })()`,
    }]).catch(() => {});
  }

  private async selectOption(backendNodeId: number) {
    const debug = this.wc.debugger;
    const { object } = await debug.sendCommand('DOM.resolveNode', { backendNodeId });
    let selectId: string | undefined;
    try {
      const owner = await debug.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return this.closest("select"); }',
      });
      selectId = owner.result?.objectId;
      if (!selectId) throw new Error('Option has no owning select. Observe the page again.');
      const { node } = await debug.sendCommand('DOM.describeNode', { objectId: selectId });
      const point = await this.clickPoint(node.backendNodeId);
      // macOS native select menus are outside the renderer's CDP keyboard path.
      // Select the exact observed option and emit the standard form events, as
      // browser automation selectOption does; never infer a value from its label.
      const result = await debug.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(select) {
          if (!this.isConnected || this.closest('select') !== select)
            return 'Option changed. Observe the page again.';
          if (select.matches(':disabled') || this.disabled || this.parentElement?.matches('optgroup:disabled'))
            return 'Option or select is disabled.';
          select.focus();
          if (select.multiple) this.selected = true;
          else select.selectedIndex = this.index;
          select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return null;
        }`,
        arguments: [{ objectId: selectId }],
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error('Option selection failed. Observe the page again.');
      if (result.result?.value !== null)
        throw new Error(result.result?.value || 'Option selection returned no result.');
      await this.markClick(point.x, point.y);
    } finally {
      if (selectId) await debug.sendCommand('Runtime.releaseObject', { objectId: selectId });
      await debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    }
  }
}
