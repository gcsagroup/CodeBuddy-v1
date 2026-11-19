import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const observationLimit = 400;
const controlRoles = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem', 'DisclosureTriangle',
]);
interface ObservedAXNode {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
}
interface ObservedCandidate {
  node: ObservedAXNode;
  operation: 'click' | 'type';
  valueId?: string;
  text?: string;
}
export interface BrowserControlInput {
  operation: 'open' | 'observe' | 'click' | 'type' | 'key' | 'screenshot' | 'console' | 'close';
  id?: string;
  url?: string;
  htmlPath?: string;
  node?: number;
  text?: string;
  key?: string;
  observationId?: string;
  candidateId?: string;
  candidateOffset?: number;
  view?: 'controls' | 'page';
  textValues?: { id: string; text: string }[];
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
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ring.animate([{ scale: '0.65' }, { scale: '1.3', offset: 0.4 }, { scale: '1' }], 650);
  setTimeout(() => {
    ring.remove();
    if (world.codeBuddyClickRing === ring) delete world.codeBuddyClickRing;
  }, 1100);
}

export class BrowserController {
  private textValues: BrowserControlInput['textValues'];
  private actionControlsOnly = true;
  private observationId = '';
  private navigationRevision = 0;
  private candidates = new Map<string, ObservedCandidate>();
  private queue: Promise<unknown> = Promise.resolve();
  private nodes = new Set<number>();
  private messages: string[] = [];
  private hasClickMarker = false;
  constructor(private wc: WebContents) {
    wc.on('did-start-navigation', (_e, _url, inPlace, main) => {
      if (main) {
        this.navigationRevision++;
        this.actionControlsOnly = true;
        this.textValues = undefined;
        this.observationId = '';
        this.candidates.clear();
      }
      if (main && !inPlace) {
        this.nodes.clear();
        this.messages = [];
        this.hasClickMarker = false;
      }
    });
    wc.on('console-message', (_e, level, message) => {
      this.messages.push(`${level}: ${message}`.slice(0, 2000));
      this.messages = this.messages.slice(-50);
    });
  }
  run(input: BrowserControlInput): Promise<Partial<Awaited<ReturnType<BrowserController['observe']>>> & {
    messages?: string[];
    content?: { type: string; mimeType: string; data: string }[];
    browserObservation?: { schemaVersion: number; webContentsId: number; navigationRevision: number };
    dispatched?: boolean; verified?: boolean; observationError?: string; next?: string;
  }> {
    const result = this.queue.then(() => this.runExclusive(input));
    this.queue = result.catch(() => {});
    return result;
  }
  private async runExclusive(input: BrowserControlInput) {
    if (this.wc.isDestroyed()) throw new Error('Browser tab was closed');
    if (input.operation === 'console') return { messages: [...this.messages] };
    if (input.operation === 'screenshot') {
      await this.clearClickMarker();
      const revision = this.navigationRevision;
      const png = await this.wc.capturePage();
      if (revision !== this.navigationRevision) throw new Error('Page navigated during capture. Observe again.');
      return {
        browserObservation: { schemaVersion: 1, webContentsId: this.wc.id, navigationRevision: this.navigationRevision },
        content: [{ type: 'image', mimeType: 'image/png', data: png.toPNG().toString('base64') }],
      };
    }
    const debug = this.wc.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    if (input.operation === 'observe') {
      this.actionControlsOnly = input.view === 'controls';
      return this.observe(input, this.actionControlsOnly);
    }
    if (['click', 'type'].includes(input.operation)) {
      let verifyCandidate = async () => {};
      if (input.candidateId !== undefined || input.observationId !== undefined) {
        const candidate = this.candidates.get(input.candidateId ?? '');
        if (!this.observationId || input.observationId !== this.observationId || !candidate || candidate.operation !== input.operation)
          throw new Error('Candidate is stale or incompatible. Observe again.');
        if (candidate.text !== undefined) {
          if (input.text !== undefined && input.text !== candidate.text) throw new Error('Candidate text does not match its observed value reference.');
          input = { ...input, text: candidate.text };
        }
        const revision = this.navigationRevision;
        verifyCandidate = async () => {
          const current = await debug.sendCommand('Accessibility.getPartialAXTree', {
            backendNodeId: candidate.node.backendDOMNodeId, fetchRelatives: false,
          });
          const node = current.nodes.find((item: ObservedAXNode & { ignored?: boolean }) =>
            !item.ignored && item.backendDOMNodeId === candidate.node.backendDOMNodeId);
          const signature = (item: ObservedAXNode) => JSON.stringify([
            item.role?.value, item.name?.value ?? '', item.value?.value ?? '',
            (item.properties ?? []).filter(p => ['disabled', 'readonly', 'checked', 'selected', 'expanded'].includes(p.name))
              .map(p => [p.name, p.value.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          ]);
          if (revision !== this.navigationRevision || !node || signature(node) !== signature(candidate.node))
            throw new Error('Candidate target changed. Observe again.');
        };
        await verifyCandidate();
        input = { ...input, node: candidate.node.backendDOMNodeId };
        this.nodes.add(input.node!);
      }
      if (!Number.isInteger(input.node) || input.node! < 1)
        throw new Error(
          `${input.operation} requires a positive integer node from observe, even when the element is focused.`
        );
      if (!this.nodes.has(input.node!))
        throw new Error('Observe this tab first and use a returned node');
      if (input.operation === 'type' && (typeof input.text !== 'string' || input.text.length > 20000))
        throw new Error('Type requires text or a candidate with valueId. To reference literals, call observe with textValues first; textValues on an action does not define its input. No input was dispatched.');
      this.observationId = '';
      this.candidates.clear();
      if (input.operation === 'type') {
        await this.clickPoint(input.node!, true);
        await debug.sendCommand('DOM.focus', { backendNodeId: input.node });
        const { object } = await debug.sendCommand('DOM.resolveNode', { backendNodeId: input.node });
        try {
          const focused = await debug.sendCommand('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { return this.isConnected && this.getRootNode().activeElement === this && !this.matches(":disabled") && !this.readOnly; }',
            returnByValue: true,
          });
          if (focused.result?.value !== true) throw new Error('Target lost keyboard focus. Observe again.');
        } finally {
          await debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
        }
        // Focus and scrolling can run page handlers that change the field's meaning.
        await verifyCandidate();
        await debug.sendCommand('Input.insertText', { text: input.text });
      } else {
        const { node } = await debug.sendCommand('DOM.describeNode', { backendNodeId: input.node });
        if (node.nodeType !== 1) {
          throw new Error(
            'Target is a text node, not an element. Choose the observed button, link or form control that performs the intended action; do not retry this text node.'
          );
        }
        if (node.localName === 'option') {
          await this.selectOption(input.node!, verifyCandidate);
        } else {
          const { x, y } = await this.clickPoint(input.node!);
          await this.markClick(x, y);
          await verifyCandidate();
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
      return this.afterAction();
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
      this.observationId = '';
      this.candidates.clear();
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
      return this.afterAction();
    }
    throw new Error('Unsupported browser operation');
  }

  private async afterAction(): Promise<Partial<Awaited<ReturnType<BrowserController['observe']>>> & {
    dispatched: true; verified: false; observationError?: string; next?: string;
  }> {
    try {
      const revision = this.navigationRevision;
      // A requested page view may contain the table cells or review details
      // needed for the next decision. Keep that view until changed or navigated.
      const controlsOnly = this.actionControlsOnly;
      const started = Date.now();
      let changedAt = started;
      let observed = await this.observe({ operation: 'observe' }, controlsOnly);
      let signature = JSON.stringify(observed.nodes);
      // Briefly sample accessibility changes caused by async input handlers.
      // This bounds extra waiting; a quiet interval is not task completion.
      while (Date.now() - started < 800 && Date.now() - changedAt < 240) {
        await delay(80);
        if (this.wc.isDestroyed() || revision !== this.navigationRevision)
          throw new Error('Page changed during action readback. Observe again.');
        const next = await this.observe({ operation: 'observe' }, controlsOnly);
        if (revision !== this.navigationRevision)
          throw new Error('Page changed during action readback. Observe again.');
        const nextSignature = JSON.stringify(next.nodes);
        if (nextSignature !== signature) changedAt = Date.now();
        signature = nextSignature;
        observed = next;
      }
      return { ...observed, dispatched: true, verified: false,
        next: 'These controls were read after the action. Compare them with the requested outcome and finish if satisfied. verified:false means the host does not judge task completion, not that another observe is required. Reobserve only for a missing or pending result.' };
    } catch (error) {
      // Input already happened. Losing its readback must never invite a replay.
      this.observationId = '';
      this.candidates.clear();
      return { dispatched: true, verified: false, observationError: error instanceof Error ? error.message : String(error),
        next: 'Observe again to resolve the result; do not repeat an uncertain action.' };
    }
  }

  private async observe(input: BrowserControlInput, controlsOnly = false) {
    const debug = this.wc.debugger;
    const offset = input.candidateOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid candidate offset');
    const values = input.textValues ?? this.textValues;
    if (values !== undefined && (!Array.isArray(values) || values.length > 24 ||
        values.some(value => !value || typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.text !== 'string' || value.text.length > 20000) ||
        new Set(values.map(value => value.id)).size !== values.length)) throw new Error('Invalid text values');
    this.observationId = '';
    this.candidates.clear();
    this.textValues = values?.map(value => ({ ...value }));
    const navigationRevision = this.navigationRevision;
    const result = await debug.sendCommand('Accessibility.getFullAXTree');
    if (navigationRevision !== this.navigationRevision) throw new Error('Page navigated during observation. Observe again.');
    const meaningful: ObservedAXNode[] = result.nodes
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
          ['RootWebArea', 'status', 'alert'].includes(n.role?.value ?? '') || controlRoles.has(n.role?.value ?? '')
      );
    const byId = new Map<string, ObservedAXNode>(result.nodes.filter((n: ObservedAXNode) => n.nodeId).map((n: ObservedAXNode) => [n.nodeId!, n]));
    const statusText = (node: ObservedAXNode) => {
      const seen = new Set<string>();
      const pending = [...(node.childIds ?? [])].reverse();
      const parts: string[] = [];
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const child = byId.get(id);
        if (!child) continue;
        if (!child.ignored && child.role?.value === 'StaticText') parts.push(String(child.name?.value ?? ''));
        else pending.push(...[...(child.childIds ?? [])].reverse());
      }
      return parts.join(' ');
    };
    const priority = (n: ObservedAXNode) => controlRoles.has(n.role?.value ?? '') || ['RootWebArea', 'heading', 'status', 'alert'].includes(n.role?.value ?? '');
    const selectedView = controlsOnly ? meaningful.filter(priority) : meaningful;
    let visible = selectedView;
    if (selectedView.length > observationLimit) {
      // Reserve space for controls even when long articles precede a form.
      // Return the selected nodes in page order so nearby labels keep their context.
      const selected = new Set<ObservedAXNode>();
      for (const node of selectedView) {
        if (priority(node)) selected.add(node);
        if (selected.size === observationLimit) break;
      }
      for (const node of selectedView) {
        if (selected.size === observationLimit) break;
        selected.add(node);
      }
      visible = selectedView.filter(node => selected.has(node));
    }
    const retained = new Set(visible.map(n => n.backendDOMNodeId));
    const parent = (node: ObservedAXNode) => {
      const seen = new Set<string>();
      let id = node.parentId;
      while (id && !seen.has(id)) {
        seen.add(id);
        const ancestor = byId.get(id);
        if (!ancestor) break;
        if (retained.has(ancestor.backendDOMNodeId)) return ancestor.backendDOMNodeId;
        id = ancestor.parentId;
      }
      return undefined;
    };
    const nodes = visible.map(
        (n) => ({
          node: n.backendDOMNodeId,
          parent: parent(n),
          ...(['status', 'alert'].includes(n.role?.value ?? '') ? { text: statusText(n).slice(0, 2000), textTruncated: statusText(n).length > 2000 } : {}),
          role: n.role?.value,
          name: n.name ? String(n.name.value).slice(0, 1000) : undefined,
          value: n.value ? String(n.value.value).slice(0, 2000) : undefined,
          // Form controls need their actual state to verify a click; a label
          // alone cannot distinguish an unchecked box from a checked one.
          ...Object.fromEntries(
            (n.properties ?? [])
              .filter((p) =>
                ['checked', 'selected', 'disabled', 'required', 'expanded', 'readonly'].includes(p.name)
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
    // A compact action receipt must not revoke still-present nodes previously
    // returned by a full observation to legacy node callers.
    this.nodes = new Set([
      ...(controlsOnly ? meaningful.filter(n => this.nodes.has(n.backendDOMNodeId)).map(n => n.backendDOMNodeId) : []),
      ...nodes.map(n => n.node),
    ]);
    this.observationId = randomUUID();
    const actionable = meaningful.flatMap(node => {
      const properties = Object.fromEntries((node.properties ?? []).map(p => [p.name, p.value.value]));
      if (properties.disabled === true || properties.disabled === 'true' || !controlRoles.has(node.role?.value ?? '')) return [];
      const operations: ('click' | 'type')[] = ['click'];
      if (['textbox', 'searchbox'].includes(node.role?.value ?? '') && properties.readonly !== true && properties.readonly !== 'true') operations.push('type');
      return operations.flatMap<ObservedCandidate>(operation => operation === 'type' && values?.length
        ? values.map(value => ({ node, operation, valueId: value.id, text: value.text }))
        : [{ node, operation, valueId: undefined, text: undefined }]);
    });
    const candidates = actionable.slice(offset, offset + 24).map((candidate, index) => {
      const id = `${this.observationId}:${offset + index}`;
      this.candidates.set(id, candidate);
      return { id, operation: candidate.operation, node: candidate.node.backendDOMNodeId,
        name: candidate.node.name?.value ?? '', role: candidate.node.role?.value,
        value: candidate.node.value?.value ?? '', valueId: candidate.valueId };
    });
    return {
      url: this.wc.getURL(),
      title: this.wc.getTitle(),
      nodes,
      view: controlsOnly ? 'controls' : 'page',
      truncated: selectedView.length > observationLimit,
      observationId: this.observationId,
      candidates,
      alternatives: ['reobserve', 'abstain'],
      candidateCount: actionable.length,
      nextCandidateOffset: offset + 24 < actionable.length ? offset + 24 : null,
    };
  }

  private async clickPoint(backendNodeId: number, editable = false) {
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
          'function(x, y, editable) { if (!this.isConnected || this.matches(":disabled") || (editable && (this.readOnly || !(this.isContentEditable || this.tagName === "TEXTAREA" || (this.tagName === "INPUT" && ["text", "email", "search", "url", "tel", "password", "number"].includes(this.type)))))) return false; let target = this; while (target) { const root = target.getRootNode(); const hit = root.elementFromPoint?.(x, y); if (target !== hit && !target.contains(hit)) return false; target = root.host; } return true; }',
        arguments: [{ value: x }, { value: y }, { value: editable }],
        returnByValue: true,
      });
      if (hit.result?.value !== true)
        throw new Error('Target is covered, disabled, not editable or outside the viewport. Observe the page again.');
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

  private async selectOption(backendNodeId: number, verifyCandidate: () => Promise<void>) {
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
      await debug.sendCommand('DOM.focus', { backendNodeId: node.backendNodeId });
      await verifyCandidate();
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
