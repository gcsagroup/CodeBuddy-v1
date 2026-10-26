import { workflowCandidates } from '../comfyui-workflows.mjs';

// Simulate server-owned API exports; production never reads these bundled graphs.
export const savedFixtureGraphs = Object.fromEntries([
  ...workflowCandidates('image','text_to_image',0), ...workflowCandidates('image','image_to_image',1),
  ...workflowCandidates('video','text_to_video',0).slice(0,1),
  ...workflowCandidates('video','image_to_video',1), ...workflowCandidates('video','reference_to_video',2),
].map(s=>[s.id+'.json',s.graph]));
export const savedFixtureInventory = Object.fromEntries(Object.values(savedFixtureGraphs).flatMap(g=>Object.values(g).map(n=>[n.class_type,{input:{required:{}},output:['ANY','ANY','ANY']}])));
export function savedFixtureResponse(url) {
  const u=new URL(url,'http://fixture');
  if(u.pathname==='/object_info')return Response.json(savedFixtureInventory);
  if(u.pathname==='/userdata')return Response.json(Object.keys(savedFixtureGraphs));
  if(u.pathname.startsWith('/userdata/')){
    const file=decodeURIComponent(u.pathname.slice('/userdata/'.length)).replace(/^workflows\//,'');
    return Response.json(savedFixtureGraphs[file]);
  }
}
