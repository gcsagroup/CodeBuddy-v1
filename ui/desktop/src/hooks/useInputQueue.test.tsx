import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInputQueue } from './useInputQueue';
import { inputQueueRequest, type InputQueueSnapshot } from '../acp/inputQueue';
vi.mock('../acp/inputQueue', () => ({ inputQueueRequest: vi.fn() }));
const api = vi.mocked(inputQueueRequest);
const snapshot = (revision = 0): InputQueueSnapshot => ({ version: 1, revision, paused: false, activeRunId: 'old-run', selection: null, items: [] });
const item = { id: 'a', content: '中文 with image', images: [{data:'aGVsbG8=',mimeType:'image/png'}], timestamp:1, desktopGeneration:'g', state:'pending' as const };
beforeEach(() => { localStorage.clear(); api.mockReset().mockImplementation(async () => snapshot()); });
async function ready() {
 const view = renderHook(({id}) => useInputQueue(id), {initialProps:{id:'s'}});
 await waitFor(() => expect(view.result.current.ready).toBe(true)); return view;
}
it.each(['queue', 'steer'])('durably stages ten independent %s inputs while the first acknowledgement is delayed', async mode => {
 const view = await ready(), staged = vi.fn();
 let release!: (value: InputQueueSnapshot) => void;
 const first = new Promise<InputQueueSnapshot>(resolve => { release = resolve; });
 let writes = 0;
 api.mockImplementation(async (_id, command) => command.action === 'get' ? snapshot() : ++writes === 1 ? first : snapshot(writes));
 const operations: Promise<boolean>[] = [];
 act(() => {
   for (let index = 0; index < 10; index++) operations.push(view.result.current.mutate({ action: 'enqueue',
     ...(mode === 'steer' ? { expectedRunId: 'old-run' } : {}), items: [{ ...item, id: `input-${index}`, content: '1', mode }] }, undefined, staged));
 });
 expect(staged).toHaveBeenCalledTimes(10);
 expect(writes).toBe(1);
 await act(async () => { release(snapshot(1)); await Promise.all(operations); });
 const sent = api.mock.calls.filter(([, command]) => command.action === 'enqueue').map(([, command]) => command);
 expect(sent).toHaveLength(10);
 expect(new Set(sent.map(command => command.commandId)).size).toBe(10);
 expect(sent.map(command => (command.items as typeof item[])[0].id)).toEqual(Array.from({ length: 10 }, (_, index) => `input-${index}`));
 expect(sent.map(command => (command.items as typeof item[])[0].content)).toEqual(Array(10).fill('1'));
 expect(view.result.current.busy).toBe(false);
});
it('clears the draft only after server acknowledgement and retains image identity', async () => {
 const view=await ready(), accepted=vi.fn(); let release!: (value:InputQueueSnapshot)=>void;
 api.mockImplementation(async (_id, command) => command.action==='get'?snapshot():new Promise(resolve=>{release=resolve;}));
 let operation!:Promise<boolean>; act(()=>{operation=view.result.current.mutate({action:'enqueue',items:[item]},accepted);});
 expect(accepted).not.toHaveBeenCalled(); expect(view.result.current.busy).toBe(true);
 expect(api.mock.calls[api.mock.calls.length - 1]?.[1]).toEqual(expect.objectContaining({revision:0,commandId:expect.any(String),items:[item]}));
 await act(async()=>{release({...snapshot(1),items:[item]});await operation;});
 expect(accepted).toHaveBeenCalledOnce(); expect(view.result.current.snapshot.items[0].images).toEqual(item.images);
});
it('retries a lost acknowledgement with the identical durable command', async () => {
 const view=await ready();api.mockRejectedValueOnce(new Error('lost reply'));
 await act(async()=>{await view.result.current.mutate({action:'enqueue',items:[item]});});
 const sent=api.mock.calls[api.mock.calls.length - 1]?.[1];expect(view.result.current.busy).toBe(true);
 api.mockImplementation(async(_id,c)=>c.action==='get'?snapshot():{...snapshot(1),items:[item]});
 await act(async()=>{await view.result.current.retry();});
 expect(api.mock.calls[api.mock.calls.length - 1]?.[1]).toEqual(sent);expect(view.result.current.busy).toBe(false);
});
it('reconciles applied commands after reload without resending', async () => {
 const view=await ready();api.mockRejectedValueOnce(new Error('disconnected'));
 await act(async()=>{await view.result.current.mutate({action:'clear'});});view.unmount();
 api.mockClear().mockResolvedValue({...snapshot(1),commandApplied:true});
 const restored=await ready();expect(api.mock.calls.every(([,c])=>c.action==='get')).toBe(true);
 expect(restored.result.current.busy).toBe(false);
});
it('retains edits on revision conflict and uses the refreshed revision', async()=>{
 const view=await ready();api.mockRejectedValueOnce(Object.assign(new Error('changed'),{code:-32602}));
 const accepted=vi.fn();await act(async()=>{expect(await view.result.current.mutate({action:'edit',id:'a',content:'new'},accepted)).toBe(false);});
 expect(accepted).not.toHaveBeenCalled();expect(view.result.current.busy).toBe(false);
 api.mockResolvedValue(snapshot(7));await act(async()=>{await view.result.current.refresh();});
 await act(async()=>{await view.result.current.mutate({action:'remove',id:'a'});});expect(api.mock.calls[api.mock.calls.length - 1]?.[1].revision).toBe(7);
});
it('isolates late responses from the previous conversation',async()=>{
 const view=await ready();let release!:(v:InputQueueSnapshot)=>void;
 api.mockImplementation(async(id,c)=>id==='s'&&c.action!=='get'?new Promise(resolve=>{release=resolve;}):snapshot());
 let operation!:Promise<boolean>;act(()=>{operation=view.result.current.mutate({action:'enqueue',items:[item]});});
 view.rerender({id:'other'});await waitFor(()=>expect(view.result.current.ready).toBe(true));
 await act(async()=>{release({...snapshot(8),items:[item]});await operation;});expect(view.result.current.snapshot.items).toEqual([]);
});

it('stages durably before acknowledgement and retains rejected input for retry', async()=>{
 const view=await ready(), staged=vi.fn(), accepted=vi.fn();
 api.mockRejectedValueOnce(Object.assign(new Error('temporary rejection'),{code:-32602}));
 await act(async()=>{await view.result.current.mutate({action:'enqueue',items:[item]},accepted,staged);});
 expect(staged).toHaveBeenCalledOnce();expect(accepted).not.toHaveBeenCalled();
 expect(view.result.current.busy).toBe(true);
 const saved=Object.values(localStorage).find(v=>v.includes('中文 with image'));
 expect(saved).toBeTruthy();
 api.mockImplementation(async(_id,c)=>c.action==='get'?snapshot():{...snapshot(1),items:[item]});
 await act(async()=>{await view.result.current.retry();});
 expect(staged).toHaveBeenCalledOnce();expect(accepted).toHaveBeenCalledOnce();
 expect(view.result.current.busy).toBe(false);
});
it('does not clear input when local staging fails',async()=>{
 const view=await ready(),staged=vi.fn();
 const write=vi.spyOn(window.Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage full');});
 await act(async()=>{await view.result.current.mutate({action:'enqueue',items:[item]},undefined,staged);});
 expect(staged).not.toHaveBeenCalled();expect(view.result.current.busy).toBe(false);
 write.mockRestore();
});

const recoverySnapshot = { version: 1 as const, revision: 0, paused: false, activeRunId: 'new-run', items: [], selection: null };
const recoveryItem = { id: 'original', content: 'Keep this correction', images: [{ data: 'cGlj', mimeType: 'image/png' }], mode: 'steer', timestamp: 1 };
const recoveryRejected = () => Object.assign(new Error('Run changed'), { code: -32602 });

const journalKey = (id = 's', version = 2) => `codebuddy-queue-command:v${version}:${sessionStorage.getItem('codebuddy-queue-window')}:${encodeURIComponent(id)}`;
const journal = () => JSON.parse(localStorage.getItem(journalKey())!).commands as Record<string, unknown>[];
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

it('a late GET for A cannot remove B or unlock its outstanding POST', async () => {
 const view = await ready(), a = held<InputQueueSnapshot>(), b = held<InputQueueSnapshot>(), lookup = held<InputQueueSnapshot>();
 let sends = 0;
 api.mockImplementation(async (_id, command) => command.action === 'get' ? lookup.promise : ++sends === 1 ? a.promise : b.promise);
 let first!: Promise<boolean>, second!: Promise<boolean>, query!: Promise<unknown>;
 act(() => { first = view.result.current.mutate({action:'enqueue',items:[item]}); second = view.result.current.mutate({action:'enqueue',items:[{...item,id:'b'}]}); query = view.result.current.refresh(); });
 await act(async () => { a.resolve(snapshot(1)); await first; });
 await waitFor(() => expect(sends).toBe(2));
 const pendingB = journal()[0];
 await act(async () => { lookup.resolve({...snapshot(1),commandApplied:true}); await query; });
 expect(journal()).toEqual([pendingB]); expect(view.result.current.busy).toBe(true);
 await act(async () => { b.resolve(snapshot(2)); await second; });
 expect(view.result.current.busy).toBe(false);
});

it('recovers the whole FIFO without automatically posting its unconfirmed tail', async () => {
 const view = await ready(), first = held<InputQueueSnapshot>();
 api.mockImplementation(async (_id, command) => command.action === 'get' ? snapshot() : first.promise.then(() => { throw new Error('lost reply'); }));
 let sent!: Promise<boolean>;
 act(() => { sent = view.result.current.mutate({action:'enqueue',items:[item]}); void view.result.current.mutate({action:'enqueue',items:[{...item,id:'b'}]}); });
 await act(async () => { first.resolve(snapshot(1)); await sent; });
 expect(journal()).toHaveLength(2);
 view.unmount();
 api.mockClear().mockResolvedValue(snapshot(1));
 const restored = await ready();
 expect(api.mock.calls.every(([, command]) => command.action === 'get')).toBe(true);
 expect(restored.result.current.busy).toBe(true);
 await act(async () => { await restored.result.current.retry(); });
 expect(api.mock.calls.filter(([, command]) => command.action === 'enqueue')).toHaveLength(1);
 expect(journal()).toHaveLength(1); expect(restored.result.current.busy).toBe(true);
});

it('does not auto-send recovered B after finding an applied A', async () => {
 const windowId = sessionStorage.getItem('codebuddy-queue-window') ?? crypto.randomUUID();
 sessionStorage.setItem('codebuddy-queue-window', windowId);
 const requests = ['a','b'].map(id => ({action:'enqueue',commandId:id,revision:0,items:[{...item,id}]}));
 localStorage.setItem(journalKey(), JSON.stringify({version:2,commands:requests}));
 api.mockImplementation(async (_id, command) => command.action === 'get' ? {...snapshot(1),commandApplied:command.commandId==='a'} : snapshot(2));
 const view = await ready();
 expect(journal()).toEqual([requests[1]]);
 expect(api.mock.calls.every(([, command]) => command.action === 'get')).toBe(true);
 await act(async () => { await view.result.current.retry(); });
 expect(api.mock.calls.filter(([, command]) => command.action === 'enqueue').map(([, command]) => command)).toEqual([requests[1]]);
});

it.each([false,true])('migrates v1 without replay, including a matching dual-key record: %s', async dual => {
 sessionStorage.setItem('codebuddy-queue-window','migration');
 const request = {action:'enqueue',commandId:'old',revision:7,expectedRunId:'run',items:[{...item,mode:'steer'}]};
 localStorage.setItem(journalKey('s',1), JSON.stringify(request));
 if (dual) localStorage.setItem(journalKey(), JSON.stringify({version:2,commands:[request]}));
 const view = await ready();
 expect(localStorage.getItem(journalKey('s',1))).toBeNull(); expect(journal()).toEqual([request]);
 expect(api.mock.calls.every(([, command]) => command.action==='get')).toBe(true);
 expect(view.result.current.canEnqueue).toBe(false);
});

it('retains conflicting v1/v2 records and blocks delivery', async () => {
 sessionStorage.setItem('codebuddy-queue-window','migration-conflict');
 const request = {action:'enqueue',commandId:'same',revision:0,items:[item]};
 localStorage.setItem(journalKey('s',1), JSON.stringify(request));
 localStorage.setItem(journalKey(), JSON.stringify({version:2,commands:[{...request,items:[{...item,content:'different'}]}]}));
 const before = {...localStorage}; const view = renderHook(() => useInputQueue('s'));
 await waitFor(() => expect(view.result.current.error).toMatch(/冲突/));
 expect({...localStorage}).toEqual(before); expect(api).not.toHaveBeenCalled(); expect(view.result.current.canEnqueue).toBe(false);
});

it('preserves an acknowledged head when deleting its journal fails, then reconciles without reposting', async () => {
 const view = await ready(), accepted = vi.fn();
 const remove = vi.spyOn(Storage.prototype,'removeItem').mockImplementation(() => { throw new Error('storage locked'); });
 await act(async () => { await view.result.current.mutate({action:'enqueue',items:[item]},accepted); });
 expect(journal()).toHaveLength(1); expect(accepted).not.toHaveBeenCalled();
 remove.mockRestore(); api.mockResolvedValue({...snapshot(1),commandApplied:true});
 await act(async () => { await view.result.current.refresh(); });
 expect(accepted).toHaveBeenCalledOnce(); expect(view.result.current.busy).toBe(false);
 expect(api.mock.calls.filter(([, command]) => command.action==='enqueue')).toHaveLength(1);
});

it('freezes nested input and attachments while retaining a draft if an append fails', async () => {
 const view = await ready(), first = held<InputQueueSnapshot>(), staged = vi.fn();
 api.mockImplementation(async (_id, command) => command.action==='get' ? snapshot() : first.promise);
 const original = structuredClone(item); let operation!: Promise<boolean>;
 act(() => { operation=view.result.current.mutate({action:'enqueue',items:[original]}); });
 original.content='changed'; original.images[0].data='changed';
 expect((journal()[0].items as typeof item[])[0]).toEqual(item);
 const write = vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => { throw new Error('full'); });
 await act(async () => { expect(await view.result.current.mutate({action:'enqueue',items:[{...item,id:'b'}]},undefined,staged)).toBe(false); });
 expect(staged).not.toHaveBeenCalled(); expect(journal()).toHaveLength(1);
 write.mockRestore(); await act(async () => { first.resolve(snapshot(1)); await operation; });
 expect(api.mock.calls.filter(([, command]) => command.action==='enqueue')).toHaveLength(1);
});

it('an old owner cannot erase recovered records after leaving and returning to the same session', async () => {
 const view = await ready(), first = held<InputQueueSnapshot>();
 api.mockImplementation(async (_id, command) => command.action==='get' ? snapshot() : first.promise);
 act(() => { void view.result.current.mutate({action:'enqueue',items:[item]}); void view.result.current.mutate({action:'enqueue',items:[{...item,id:'b'}]}); });
 const saved = localStorage.getItem(journalKey());
 view.rerender({id:'other'}); await waitFor(() => expect(view.result.current.ready).toBe(true));
 view.rerender({id:'s'}); await waitFor(() => expect(view.result.current.ready).toBe(true));
 await act(async () => { first.resolve(snapshot(1)); });
 expect(localStorage.getItem(journalKey())).toBe(saved);
 expect(api.mock.calls.filter(([, command]) => command.action==='enqueue')).toHaveLength(1);
});
describe('input delivery recovery', () => {
  it('changes a definitely rejected target only after an explicit choice, preserving the original input', async () => {
    let sends = 0;
    vi.mocked(inputQueueRequest).mockImplementation(async (_id, command) => {
      if (command.action === 'enqueue' && sends++ === 0) throw recoveryRejected();
      return recoverySnapshot;
    });
    const { result } = renderHook(() => useInputQueue('session'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate({ action: 'enqueue', expectedRunId: 'old-run', items: [recoveryItem] }); });
    expect(result.current.canRequeueRejected).toBe(true);
    await act(async () => { await result.current.requeueRejected(); });
    const sendsOnly = vi.mocked(inputQueueRequest).mock.calls.filter(([, command]) => command.action === 'enqueue').map(([, command]) => command);
    expect(sendsOnly).toHaveLength(2);
    expect(sendsOnly[1].commandId).not.toBe(sendsOnly[0].commandId);
    expect(sendsOnly[1].expectedRunId).toBeUndefined();
    expect(sendsOnly[1].items).toEqual([{ ...recoveryItem, mode: 'queue' }]);
    expect(result.current.busy).toBe(false);
  });

  it('does not offer another destination when admission is unknown', async () => {
    vi.mocked(inputQueueRequest).mockImplementation(async (_id, command) => {
      if (command.action === 'enqueue') throw new Error('Connection lost');
      return recoverySnapshot;
    });
    const { result } = renderHook(() => useInputQueue('session'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate({ action: 'enqueue', expectedRunId: 'old-run', items: [recoveryItem] }); });
    expect(result.current.canRequeueRejected).toBe(false);
    await act(async () => { await result.current.requeueRejected(); });
    expect(vi.mocked(inputQueueRequest).mock.calls.filter(([, command]) => command.action === 'enqueue')).toHaveLength(1);
  });

  it('locks the whole retry before refreshing, so double clicks cannot leave an old admission in flight', async () => {
    let release!: (value: typeof recoverySnapshot) => void;
    vi.mocked(inputQueueRequest).mockImplementation(async (_id, command) => {
      if (command.action === 'enqueue') throw recoveryRejected();
      return recoverySnapshot;
    });
    const { result } = renderHook(() => useInputQueue('session'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate({ action: 'enqueue', expectedRunId: 'old-run', items: [recoveryItem] }); });
    const refresh = new Promise<typeof recoverySnapshot>(resolve => { release = resolve; });
    vi.mocked(inputQueueRequest).mockImplementationOnce(() => refresh);
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = result.current.retry(); second = result.current.retry(); });
    expect(result.current.canRequeueRejected).toBe(false);
    await act(async () => { release(recoverySnapshot); await Promise.all([first, second]); });
    expect(vi.mocked(inputQueueRequest).mock.calls.filter(([, command]) => command.action === 'enqueue')).toHaveLength(2);
    expect(result.current.canRequeueRejected).toBe(true);
  });
});
