import { boundedMediaBody } from "./media-cloud.mjs";

const regions = new Map([
  ["https://dashscope.aliyuncs.com", "cn-beijing"],
  ["https://dashscope-intl.aliyuncs.com", "ap-southeast-1"],
]);

export function workspaceOrigin(url, workspaceId) {
  if (!regions.has(url) || typeof workspaceId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workspaceId))
    throw Error("请填写百炼控制台中的业务空间 ID，并选择对应地域");
  return `https://${workspaceId}.${regions.get(url)}.maas.aliyuncs.com`;
}

// The generation adapters handle these model families. A multimodal chat
// model may accept images without being able to generate them.
export function compatibleModes(type, id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(id)) return [];
  if (type === "ark" && /^doubao-seedream-(?:[5-9]|\d{2,})-/.test(id) ||
      type === "bailian" && /^qwen-image-\d/.test(id)) return ["text_to_image", "image_to_image"];
  if (type === "ark" && id.startsWith("doubao-seedance-")) {
    if (id.includes("-i2v-")) return ["image_to_video"];
    if (id.includes("-t2v-")) return ["text_to_video"];
    return ["text_to_video", "image_to_video"];
  }
  if (type === "bailian" && /^wan\d[\d.]*-i2v(?:-|$)/.test(id)) return ["image_to_video"];
  if (type === "bailian" && /^wan\d[\d.]*-t2v(?:-|$)/.test(id)) return ["text_to_video"];
  return [];
}

export async function fetchOfficialModels({ type, url, workspaceId, key }, fetchImpl = fetch) {
  const ark = type === "ark";
  if (!(ark && url === "https://ark.cn-beijing.volces.com/api/v3" || type === "bailian" && regions.has(url)))
    throw Error("请选择厂商官方地址");
  const endpoint = ark ? url + "/models" : workspaceOrigin(url, workspaceId) + "/api/v1/models";
  if (!key) throw Error("请先填写 API Key");
  const models = new Map();
  let seen = 0;
  const signal = AbortSignal.timeout(30_000);
  for (let page = 1; page <= 100; page++) {
    const target = new URL(endpoint);
    if (!ark) {
      target.searchParams.set("page_size", "50");
      target.searchParams.set("page_no", String(page));
    }
    const reply = await fetchImpl(target, {
      headers: { Authorization: "Bearer " + key }, redirect: "error", signal,
    });
    if (!reply.ok) throw Error(`官方模型目录返回 HTTP ${reply.status}`);
    const data = JSON.parse((await boundedMediaBody(reply, 8 * 1024 * 1024)).toString());
    const rows = ark ? data.data : data.output?.models;
    if (!Array.isArray(rows) || data.success === false) throw Error("官方模型目录响应无效");
    for (const row of rows) {
      const id = ark ? row?.id : row?.model;
      const allowed = compatibleModes(type, id);
      if (!allowed.length || ark && row.status && !["Published", "Retiring"].includes(row.status)) continue;
      const input = ark ? row.modalities?.input_modalities : row.inference_metadata?.request_modality;
      const output = ark ? row.modalities?.output_modalities : row.inference_metadata?.response_modality;
      if (!Array.isArray(input) || !Array.isArray(output)) continue;
      const has = (values, value) => values.some(v => typeof v === "string" && v.toLowerCase() === value);
      const modes = allowed.filter(mode => {
        const [source, dest] = mode.split("_to_");
        return has(input, source) && has(output, dest);
      });
      if (modes.length) models.set(id, { id, label: id, modes, retiring: row.status === "Retiring" });
    }
    seen += rows.length;
    if (ark || !rows.length || (Number.isInteger(data.output.total) ? seen >= data.output.total : rows.length < 50))
      return { models: [...models.values()] };
  }
  throw Error("官方模型目录分页未结束，请稍后重试");
}
