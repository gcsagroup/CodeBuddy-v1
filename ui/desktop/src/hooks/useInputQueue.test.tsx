import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
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