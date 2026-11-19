import { it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BrowserController } from './browserControl';
const inputReply = (method: string) => {
  if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } };
  if (method === 'DOM.resolveNode') return { object: { objectId: 'input' } };
  if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
  return {};
};
it('keeps requested page context after pagination without a second observation', async () => {
  let page=1;
  const next={backendDOMNodeId:1,role:{value:'button'},name:{value:'下一页'}};
  const send=vi.fn(async(method:string,args?:{type?:string})=>{
    if(method.startsWith('Accessibility.'))return {nodes:[next,{backendDOMNodeId:2,role:{value:'StaticText'},name:{value:page===1?'杭州 有效':'苏州 有效'}}]};
    if(method==='Input.dispatchMouseEvent'&&args?.type==='mouseReleased')page=2;
    if(method==='DOM.describeNode')return {node:{nodeType:1,localName:'button'}};
    return inputReply(method);
  });
  const wc={on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',executeJavaScriptInIsolatedWorld:vi.fn(),debugger:{isAttached:()=>true,sendCommand:send}} as unknown as WebContents;
  const controller=new BrowserController(wc);
  const before=await controller.run({operation:'observe',view:'page'});
  const after=await controller.run({operation:'click',observationId:before.observationId,candidateId:before.candidates![0].id});
  expect(after.view).toBe('page');
  expect(after.nodes).toEqual(expect.arrayContaining([expect.objectContaining({name:'苏州 有效'})]));
  await controller.run({operation:'observe',view:'controls'});
  const compact=await controller.run({operation:'click',node:1});
  expect(compact.view).toBe('controls');
  expect(compact.nodes?.some(node=>node.name==='苏州 有效')).toBe(false);
});
it('retains literal references across observations but clears them explicitly and on navigation', async () => {
  const events = new Map<string, (...args: unknown[]) => void>();
  const wc = {on:(name:string,fn:(...args:unknown[])=>void)=>events.set(name,fn),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',
    debugger:{isAttached:()=>true,sendCommand:async()=>({nodes:[{backendDOMNodeId:1,role:{value:'textbox'},name:{value:'公司'}}]})}} as unknown as WebContents;
  const c=new BrowserController(wc), textValues=[{id:'company',text:'海风测试'}];
  await c.run({operation:'observe',textValues});
  expect((await c.run({operation:'observe',view:'controls'})).candidates).toEqual(expect.arrayContaining([expect.objectContaining({valueId:'company'})]));
  expect((await c.run({operation:'observe',textValues:[]})).candidates!.every(x=>!x.valueId)).toBe(true);
  await c.run({operation:'observe',textValues});
  events.get('did-start-navigation')!({},'http://other/',false,true);
  expect((await c.run({operation:'observe'})).candidates!.every(x=>!x.valueId)).toBe(true);
});

it('bounds continuously changing readback without replaying the action', async () => {
  let written=false, revision=0;
  const field={backendDOMNodeId:1,role:{value:'textbox'},name:{value:'搜索'}};
  const send=vi.fn(async(method:string)=>{
    if(method.startsWith('Accessibility.'))return {nodes:[field,...(written?[{backendDOMNodeId:2,role:{value:'status'},name:{value:String(++revision)}}]:[])]};
    if(method==='Input.insertText')written=true;
    return inputReply(method);
  });
  const wc={on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',debugger:{isAttached:()=>true,sendCommand:send}} as unknown as WebContents;
  const c=new BrowserController(wc);await c.run({operation:'observe'});
  const result=await c.run({operation:'type',node:1,text:'海风'});
  expect(result).toMatchObject({dispatched:true,verified:false});
  expect(revision).toBeGreaterThan(2);
  expect(revision).toBeLessThan(20);
  expect(send.mock.calls.filter(([m])=>m==='Input.insertText')).toHaveLength(1);
}, 3000);

it('invalidates the after-state when navigation happens while waiting', async () => {
  const events=new Map<string,(...args:unknown[])=>void>();
  const node={backendDOMNodeId:1,role:{value:'textbox'},name:{value:'搜索'}};
  const send=vi.fn(async(method:string)=>{
    if(method.startsWith('Accessibility.'))return {nodes:[node]};
    if(method==='Input.insertText')setTimeout(()=>events.get('did-start-navigation')!({},'http://other/',false,true),20);
    return inputReply(method);
  });
  const wc={on:(name:string,fn:(...args:unknown[])=>void)=>events.set(name,fn),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',debugger:{isAttached:()=>true,sendCommand:send}} as unknown as WebContents;
  const c=new BrowserController(wc);const before=await c.run({operation:'observe'});
  const action={operation:'type' as const,observationId:before.observationId,candidateId:before.candidates!.find(c=>c.operation==='type')!.id,text:'海风'};
  expect(await c.run(action)).toMatchObject({dispatched:true,observationError:expect.stringContaining('changed')});
  await expect(c.run(action)).rejects.toThrow('stale');
  expect(send.mock.calls.filter(([m])=>m==='Input.insertText')).toHaveLength(1);
});
it('keeps status text attached to its owner, distinct from a matching suggestion', async () => {
  const nodes = [
    {nodeId:'root',backendDOMNodeId:1,role:{value:'RootWebArea'},childIds:['status','button']},
    {nodeId:'status',parentId:'root',backendDOMNodeId:2,role:{value:'status'},name:{value:'已选客户'},childIds:['wrapper']},
    {nodeId:'wrapper',parentId:'status',ignored:true,childIds:['result']},
    {nodeId:'result',parentId:'wrapper',backendDOMNodeId:3,role:{value:'StaticText'},name:{value:'海风测试'}},
    {nodeId:'button',parentId:'root',backendDOMNodeId:4,role:{value:'button'},name:{value:'海风账单'}},
  ];
  const wc = {on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',
    debugger:{isAttached:()=>true,sendCommand:async()=>({nodes})}} as unknown as WebContents;
  const observed=await new BrowserController(wc).run({operation:'observe'});
  expect(observed.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({node:2,role:'status',name:'已选客户',text:'海风测试'}),
    expect.objectContaining({node:3,parent:2}),
  ]));
  expect(observed.nodes?.find(n=>n.node===2)?.text).not.toContain('海风账单');
});

it('returns fresh compact controls and value candidates with the executed action', async () => {
  let value='';
  const field=()=>({backendDOMNodeId:700,role:{value:'textbox'},name:{value:'公司'},value:{value}});
  const send=vi.fn(async(method:string,args?:{text?:string})=>{
    if(method==='Accessibility.getFullAXTree')return {nodes:[
      ...Array.from({length:450},(_,i)=>({backendDOMNodeId:i+1,role:{value:'StaticText'},name:{value:`历史 ${i}`}})),field(),
    ]};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[field()]};
    if(method==='Input.insertText')value=args!.text!;
    return inputReply(method);
  });
  const wc={on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',debugger:{isAttached:()=>true,sendCommand:send}} as unknown as WebContents;
  const c=new BrowserController(wc);
  const first=await c.run({operation:'observe',view:'controls',textValues:[{id:'company',text:'海风测试'}]});
  const candidate=first.candidates!.find(x=>x.operation==='type')!;
  const action={operation:'type' as const,observationId:first.observationId,candidateId:candidate.id};
  const after=await c.run(action);
  expect(after).toMatchObject({dispatched:true,verified:false,view:'controls',nodes:[expect.objectContaining({node:700,value:'海风测试'})]});
  expect(after.observationId).not.toBe(first.observationId);
  expect(after.candidates).toEqual(expect.arrayContaining([expect.objectContaining({operation:'type',valueId:'company',value:'海风测试'})]));
  await expect(c.run(action)).rejects.toThrow('stale');
  expect(send.mock.calls.filter(([method])=>method==='Input.insertText')).toHaveLength(1);
});

it('preserves dispatch when after-state fails and does not replay uncertain input', async () => {
  const field={backendDOMNodeId:12,role:{value:'textbox'},name:{value:'公司'}};
  let written=false;
  const send=vi.fn(async(method:string)=>{
    if(method==='Accessibility.getFullAXTree' && written)throw new Error('Tab went away during readback');
    if(method.startsWith('Accessibility.'))return {nodes:[field]};
    if(method==='Input.insertText')written=true;
    return inputReply(method);
  });
  const wc={on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',debugger:{isAttached:()=>true,sendCommand:send}} as unknown as WebContents;
  const c=new BrowserController(wc),o=await c.run({operation:'observe'});
  const action={operation:'type' as const,observationId:o.observationId,candidateId:o.candidates!.find(x=>x.operation==='type')!.id,text:'海风测试'};
  expect(await c.run(action)).toMatchObject({dispatched:true,verified:false,observationError:expect.stringContaining('readback')});
  await expect(c.run(action)).rejects.toThrow('stale');
  expect(send.mock.calls.filter(([method])=>method==='Input.insertText')).toHaveLength(1);
});
it('rejects incomplete text before consuming a valid candidate or dispatching input', async () => {
  const node = { backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: '公司' } };
  const send = vi.fn(async (method: string) => method.startsWith('Accessibility.') ? {nodes:[node]} : inputReply(method));
  const wc = { on:vi.fn(),isDestroyed:()=>false,getURL:()=>'',getTitle:()=>'',debugger:{isAttached:()=>true,sendCommand:send} } as unknown as WebContents;
  const controller = new BrowserController(wc), observed = await controller.run({operation:'observe'});
  const action = {operation:'type' as const,observationId:observed.observationId,candidateId:observed.candidates!.find(c=>c.operation==='type')!.id};
  await expect(controller.run({...action,textValues:[{id:'company',text:'海风测试'}]})).rejects.toThrow('No input was dispatched');
  expect(send.mock.calls.some(([method])=>method==='Input.insertText')).toBe(false);
  await expect(controller.run({...action,text:'海风测试'})).resolves.toMatchObject({dispatched:true});
  expect(send.mock.calls.filter(([method])=>method==='Input.insertText')).toHaveLength(1);
});

it('invalidates candidates after uncertain input and serializes overlapping requests', async () => {
  const node = { backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: '公司' } };
  let writes = 0;
  const wc = { on: vi.fn(), isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: { isAttached: () => true, sendCommand: async (method: string) => {
      if (method.startsWith('Accessibility.')) return { nodes: [node] };
      if (method === 'Input.insertText') { writes++; throw new Error('Connection lost after dispatch'); }
      return inputReply(method);
    } } } as unknown as WebContents;
  const controller = new BrowserController(wc);
  const observed = await controller.run({ operation: 'observe' });
  const action = { operation: 'type' as const, observationId: observed.observationId,
    candidateId: observed.candidates!.find(c => c.operation === 'type')!.id, text: '海风测试' };
  const results = await Promise.allSettled([controller.run(action), controller.run(action)]);
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(writes).toBe(1);
  await expect(controller.run({operation: 'observe'})).resolves.toHaveProperty('observationId');
});

it('rejects observations that cross navigation and offers no guessed candidate for empty pages', async () => {
  const events = new Map<string, (...args: unknown[]) => void>();
  let navigate = true;
  const wc = { on: (name: string, callback: (...args: unknown[]) => void) => events.set(name, callback),
    isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: { isAttached: () => true, sendCommand: async () => {
      if (navigate) events.get('did-start-navigation')!({}, 'http://other/', true, true);
      return {nodes: []};
    } } } as unknown as WebContents;
  const controller = new BrowserController(wc);
  await expect(controller.run({operation: 'observe'})).rejects.toThrow('navigated');
  navigate = false;
  await expect(controller.run({operation: 'observe'})).resolves.toMatchObject({candidates: [], candidateCount: 0, nextCandidateOffset: null, alternatives: ['reobserve', 'abstain']});
});

it('binds candidate actions to fresh semantics and consumes them before dispatch', async () => {
  let node = { backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: '工作邮箱' } };
  const send = vi.fn(async (method: string) => method.startsWith('Accessibility.') ? { nodes: [node] } : inputReply(method));
  const wc = { on: vi.fn(), isDestroyed: () => false, getURL: () => 'http://localhost/', getTitle: () => '',
    debugger: { isAttached: () => true, sendCommand: send } } as unknown as WebContents;
  const controller = new BrowserController(wc);
  const observed = await controller.run({ operation: 'observe' });
  const candidate = observed.candidates!.find(item => item.operation === 'type')!;
  const action = { operation: 'type' as const, observationId: observed.observationId, candidateId: candidate.id, text: 'qa@example.test' };
  node = { ...node, name: { value: '账单邮箱' } };
  await expect(controller.run(action)).rejects.toThrow('changed');
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
  const fresh = await controller.run({ operation: 'observe' });
  const freshAction = { ...action, observationId: fresh.observationId, candidateId: fresh.candidates!.find(item => item.operation === 'type')!.id };
  await expect(controller.run(action)).rejects.toThrow('stale');
  await expect(controller.run(freshAction)).resolves.toMatchObject({ dispatched: true });
  await expect(controller.run(freshAction)).rejects.toThrow('stale');
  expect(send.mock.calls.filter(([method]) => method === 'Input.insertText')).toHaveLength(1);
});

it('rejects candidate semantics changed by focusing the input before text dispatch', async () => {
  let node = { backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: '工作邮箱' } };
  const send = vi.fn(async (method: string) => {
    if (method.startsWith('Accessibility.')) return { nodes: [node] };
    if (method === 'DOM.focus') node = { ...node, name: { value: '账单邮箱' } };
    return inputReply(method);
  });
  const wc = { on: vi.fn(), isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: { isAttached: () => true, sendCommand: send } } as unknown as WebContents;
  const controller = new BrowserController(wc);
  const observed = await controller.run({ operation: 'observe' });
  await expect(controller.run({ operation: 'type', observationId: observed.observationId,
    candidateId: observed.candidates!.find(c => c.operation === 'type')!.id, text: 'qa@example.test' })).rejects.toThrow('changed');
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

it('inserts the stored Unicode value and rejects a rewritten candidate value', async () => {
  const send = vi.fn(async (method: string) => method.startsWith('Accessibility.')
    ? { nodes: [{backendDOMNodeId: 12, role: {value: 'textbox'}, name: {value: '公司'}}] }
    : inputReply(method));
  const wc = {on: vi.fn(), isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: {isAttached: () => true, sendCommand: send}} as unknown as WebContents;
  const controller = new BrowserController(wc);
  const observed = await controller.run({operation: 'observe', textValues: [{id:'company',text:'海风测试🙂'}]});
  const candidate = observed.candidates!.find(c => c.valueId === 'company')!;
  const action = {operation: 'type' as const, observationId: observed.observationId, candidateId: candidate.id};
  await expect(controller.run({...action,text:'改写公司'})).rejects.toThrow('value reference');
  expect(send.mock.calls.some(([method])=>method==='Input.insertText')).toBe(false);
  await controller.run(action);
  expect(send).toHaveBeenCalledWith('Input.insertText',{text:'海风测试🙂'});
});

it('pages candidates without losing late controls and excludes disabled actions', async () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ backendDOMNodeId: index + 1,
    role: { value: 'button' }, name: { value: `选择 ${index}` },
    properties: [{ name: 'disabled', value: { value: index === 0 } }],
  }));
  const wc = { on: vi.fn(), isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: { isAttached: () => true, sendCommand: async () => ({ nodes }) } } as unknown as WebContents;
  const controller = new BrowserController(wc);
  const first = await controller.run({ operation: 'observe' });
  expect(first.candidates).toHaveLength(24);
  expect(first.candidates!.some(item => item.node === 1)).toBe(false);
  const second = await controller.run({ operation: 'observe', candidateOffset: first.nextCandidateOffset! });
  expect(second.candidates).toHaveLength(5);
  expect(second.candidates![second.candidates!.length - 1].node).toBe(30);
  expect(second.nextCandidateOffset).toBeNull();
});
it('keeps search results and unnamed controls after empty layout nodes without falsely reporting truncation', async () => {
  const send = vi.fn(async () => ({
    nodes: [
      ...Array.from({ length: 600 }, (_, i) => ({
        backendDOMNodeId: i + 1,
        role: { value: 'generic' },
        name: { value: '' },
      })),
      { backendDOMNodeId: 601, role: { value: 'link' }, name: { value: 'Official documentation' } },
      { backendDOMNodeId: 602, role: { value: 'checkbox' }, name: { value: '' } },
    ],
  }));
  const wc = {
    on: vi.fn(),
    isDestroyed: () => false,
    getURL: () => 'http://localhost/',
    getTitle: () => 'Search',
    debugger: { isAttached: () => true, sendCommand: send },
  } as unknown as WebContents;
  const result = await new BrowserController(wc).run({ operation: 'observe' });
  expect(result).toMatchObject({
    truncated: false,
    nodes: [
      { node: 601, role: 'link', name: 'Official documentation' },
      { node: 602, role: 'checkbox', name: '' },
    ],
  });
});
it('preserves late form controls and page order when named content exceeds the observation budget', async () => {
  const nodes = Array.from({length: 450}, (_, i) => ({
    backendDOMNodeId: i + 1, role: {value: 'StaticText'}, name: {value: String(i)},
  }));
  nodes.push({backendDOMNodeId: 451, role: {value: 'textbox'}, name: {value: '工作邮箱'}});
  const wc = { on: vi.fn(), isDestroyed: () => false, getURL: () => '', getTitle: () => '',
    debugger: {isAttached: () => true, sendCommand: async () => ({nodes})} } as unknown as WebContents;
  const result = await new BrowserController(wc).run({operation: 'observe'});
  expect(result.truncated).toBe(true);
  expect(result.nodes).toHaveLength(400);
  expect(result.nodes?.[0].node).toBe(1);
  expect(result.nodes?.[399]).toMatchObject({node: 451, name: '工作邮箱'});
});

it('requires observed nodes, clears them after navigation, and distinguishes dispatch from verification', async () => {
  const events = new Map<string, (...args: unknown[]) => void>();
  const send = vi.fn(async (method: string) =>
    method === 'Accessibility.getFullAXTree'
      ? {
          nodes: [{ backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: 'Message' } }],
        }
      : inputReply(method)
  );
  const wc = {
    on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn),
    isDestroyed: () => false,
    getURL: () => 'http://localhost/',
    getTitle: () => 'Fixture',
    debugger: { isAttached: () => true, sendCommand: send },
  } as unknown as WebContents;
  const control = new BrowserController(wc);
  await expect(control.run({ operation: 'type', text: 'hello' })).rejects.toThrow('type requires');
  await expect(control.run({ operation: 'type', node: 12, text: 'hello' })).rejects.toThrow(
    'Observe'
  );
  await control.run({ operation: 'observe' });
  expect(await control.run({ operation: 'type', node: 12, text: 'hello' })).toMatchObject({
    dispatched: true,
    verified: false,
  });
  expect(send).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 12 });
  expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'hello' });
  events.get('did-start-navigation')!({}, 'http://new/', false, true);
  await expect(control.run({ operation: 'type', node: 12, text: 'hello' })).rejects.toThrow(
    'Observe'
  );
  await expect(control.run({ operation: 'key', key: 'Unknown' })).rejects.toThrow('Unsupported');
});
