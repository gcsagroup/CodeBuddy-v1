import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceDocument } from './WorkspaceDocument';
import type { PanelRequest, PanelReply } from './workspacePanelTypes';

const renderer = vi.hoisted(() => ({ load: vi.fn(), body: vi.fn() }));
vi.mock('./dshDocumentRenderer', () => ({
  loadDshDocumentRenderer: renderer.load,
  DshDocumentRenderer: (props: { kind: string; data: Uint8Array; signal: AbortSignal }) => {
    renderer.body(props);
    return <div>interactive-{props.kind}</div>;
  },
}));
const scope = { sessionId: 'document-test', root: '/fixture' };
const invoke = vi.fn<(request: PanelRequest) => Promise<PanelReply>>();
beforeEach(() => {
  invoke.mockReset();
  renderer.body.mockClear();
  renderer.load.mockReset().mockResolvedValue({});
  Object.assign(window.electron, { workspacePanel: invoke });
});
const reply = (kind: 'pdf' | 'excel' = 'pdf'): PanelReply => ({
  documentPreview: { kind, data: new Uint8Array([1, 2, 3]), missingFonts: [] },
});
const show = (path = 'report.docx') =>
  render(<WorkspaceDocument scope={scope} path={path} title={path} />, {
    wrapper: IntlTestWrapper,
  });

it('preserves read-only reference routing on render, retry and explicit application open', async () => {
  invoke.mockImplementation(async (r) => (r.action === 'document-preview' ? reply('excel') : {}));
  render(
    <WorkspaceDocument
      scope={scope}
      path="C:/old-workspace/report.xlsx"
      title="report.xlsx"
      reference
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(await screen.findByText('interactive-excel')).toBeVisible();
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'document-preview',
      reference: true,
      path: 'C:/old-workspace/report.xlsx',
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reload file from disk' }));
  expect(await screen.findByText('interactive-excel')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Open in default application' }));
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'open-target', reference: true, path: 'C:/old-workspace/report.xlsx' })
  );
  expect(
    invoke.mock.calls.filter(([r]) => r.action === 'document-preview').every(([r]) => r.reference)
  ).toBe(true);
});

it.each(['report.pdf', 'report.docx', 'report.pptx', 'report.xlsx'])(
  'delivers %s to its interactive renderer without opening another application',
  async (path) => {
    const kind = path.endsWith('.xlsx') ? 'excel' : 'pdf';
    invoke.mockImplementation(async (r) => (r.action === 'document-preview' ? reply(kind) : {}));
    const view = show(path);
    expect(await screen.findByText('interactive-' + kind)).toBeVisible();
    expect(renderer.load).toHaveBeenCalledWith(kind);
    const props = renderer.body.mock.lastCall![0];
    expect(Array.from(props.data)).toEqual([1, 2, 3]);
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'open-external' }));
    view.unmount();
    expect(props.signal.aborted).toBe(true);
    const request = invoke.mock.calls.find(([r]) => r.action === 'document-preview')![0];
    expect(invoke).toHaveBeenCalledWith({
      scope,
      action: 'document-preview-cancel',
      requestId: 'requestId' in request ? request.requestId : '',
    });
  }
);

it('offers quiet failure feedback and a fresh retry without leaking engine diagnostics', async () => {
  invoke.mockRejectedValueOnce(new Error('private engine diagnostics'));
  invoke.mockImplementation(async (r) => (r.action === 'document-preview' ? reply() : {}));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not preview this document');
  expect(screen.queryByText('private engine diagnostics')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reload file from disk' }));
  expect(await screen.findByText('interactive-pdf')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('cancels pending work on unmount and ignores a late source reply', async () => {
  let resolve!: (r: PanelReply) => void;
  invoke.mockImplementation((r) =>
    r.action === 'document-preview'
      ? new Promise((res) => {
          resolve = res;
        })
      : Promise.resolve({})
  );
  const view = show();
  view.unmount();
  await act(async () => resolve(reply()));
  expect(renderer.body).not.toHaveBeenCalled();
});
