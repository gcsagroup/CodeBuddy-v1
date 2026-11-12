import { randomUUID } from "node:crypto";
import { mkdir, copyFile, constants } from "node:fs/promises";
import path from "node:path";
import { protectSecret, revealSecret } from "./secrets.mjs";
import { compatibleModes, fetchOfficialModels, workspaceOrigin } from "./media-model-discovery.mjs";
import {
  comfyuiTool,
  comfyuiUrl,
  DEFAULT_COMFYUI_URL,
} from "./comfyui-tool.mjs";
import { comfyuiVideoTool } from "./comfyui-video-tool.mjs";

const model = (id, label, ...modes) => ({ id, label, modes });
export const mediaCatalog = {
  bailian: {
    urls: [
      "https://dashscope.aliyuncs.com",
      "https://dashscope-intl.aliyuncs.com",
    ],
    models: [
      model(
        "qwen-image-2.0",
        "千问 Qwen-Image 2.0",
        "text_to_image",
        "image_to_image",
      ),
      model("wan2.6-i2v", "通义万相 2.6 · 图生视频", "image_to_video"),
      model("wan2.6-t2v", "通义万相 2.6 · 文生视频", "text_to_video"),
    ],
  },
  ark: {
    urls: ["https://ark.cn-beijing.volces.com/api/v3"],
    models: [
      model(
        "doubao-seedream-5-0-pro-260628",
        "豆包 Seedream 5.0 Pro",
        "text_to_image",
        "image_to_image",
      ),
      model(
        "doubao-seedance-2-0-260128",
        "豆包 Seedance 2.0",
        "text_to_video",
        "image_to_video",
      ),
    ],
  },
  fal: {
    urls: ["https://queue.fal.run"],
    models: [
      model(
        "fal-ai/wan/v2.2-a14b/image-to-video",
        "Wan 2.2 · 图生视频",
        "image_to_video",
      ),
      model(
        "fal-ai/wan/v2.2-a14b/text-to-video",
        "Wan 2.2 · 文生视频",
        "text_to_video",
      ),
    ],
  },
  openai: { urls: ["https://api.openai.com/v1"], models: [] },
  comfy: {
    urls: [],
    models: [
      model(
        "auto-image",
        "自动选择图片工作流",
        "text_to_image",
        "image_to_image",
      ),
      model(
        "auto-video",
        "自动选择视频工作流",
        "text_to_video",
        "image_to_video",
        "reference_to_video",
      ),
    ],
  },
};
const kindOf = (m) => (m.modes[0].endsWith("_image") ? "image" : "video");
const modes = [
  "text_to_image",
  "image_to_image",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
];
const roots = ["mediaServices", "preferences"];
function registry(state) {
  if (state.mediaServices) return state.mediaServices;
  const service = {
    id: "legacy",
    type: "comfy",
    name: "ComfyUI",
    url: comfyuiUrl(state.preferences?.comfyuiBaseUrl ?? DEFAULT_COMFYUI_URL),
    models: mediaCatalog.comfy.models,
  };
  return {
    revision: 0,
    services: [service],
    defaults: {
      image: { service: "legacy", model: "auto-image" },
      video: { service: "legacy", model: "auto-video" },
    },
  };
}
const publicState = (r) => ({
  revision: r.revision,
  services: r.services.map(({ secret, ...s }) => ({ ...s, hasKey: !!secret })),
  defaults: r.defaults,
  catalog: mediaCatalog,
});
export function mediaOptions(store, kind, choice) {
  const r = registry(store.read(roots)),
    selected = choice ?? r.defaults[kind];
  const s = r.services.find((s) => s.id === selected?.service),
    m = s?.models.find((m) => m.id === selected.model);
  const authorize = async (route) => {
    if (!route) return "";
    const current = registry(store.read(roots)).services.find(
      (s) =>
        s.id === route.serviceId &&
        s.type === route.type &&
        s.url === route.url,
    );
    if (!current)
      throw Error("原生成服务已移除或地址已更改，请恢复连接后查询任务。");
    return revealSecret(current.secret);
  };
  return {
    baseUrl: s?.url,
    mediaRoute:
      s && m
        ? {
            serviceId: s.id,
            type: s.type,
            url: s.url,
            ...(s.type === "bailian" && s.workspaceId && !mediaCatalog.bailian.models.some(p => p.id === m.id)
              ? { apiBase: workspaceOrigin(s.url, s.workspaceId) } : {}),
            model: m,
            hasKey: !!s.secret,
            identity: s.identity,
          }
        : undefined,
    disabled: !m,
    authorize,
  };
}
export async function inspectMediaWorkflows(store, p) {
  const url = comfyuiUrl(p.url);
  const old = registry(store.read(roots)).services.find(
    (s) => s.id === p.id && s.type === "comfy" && s.url === url,
  );
  const key = p.apiKey?.trim() || (await revealSecret(old?.secret));
  const tool = comfyuiTool({
    cwd: store.directory,
    dataDir: store.directory,
    sessionId: "settings-inspect",
    baseUrl: url,
    mediaRoute: { type: "comfy", url, model: { id: "auto-image" } },
    authorize: async () => key,
  });
  const catalog = await tool.execute({
    operation: "inspect",
    mode: "text_to_image",
  });
  return {
    models: catalog.workflows
      .filter((w) => w.dependencies_available)
      .map((w) => model(w.id, w.label, w.mode)),
    blockers: catalog.blockers.length,
  };
}
export async function refreshMediaModels(store, p, fetchImpl = fetch) {
  if (!["ark", "bailian"].includes(p.type) || !mediaCatalog[p.type].urls.includes(p.url))
    throw Error("请选择厂商官方地址");
  const old = registry(store.read(roots)).services.find(s =>
    s.id === p.id && s.type === p.type && s.url === p.url);
  const key = p.apiKey?.trim() || await revealSecret(old?.secret);
  return fetchOfficialModels({ type: p.type, url: p.url, workspaceId: p.workspaceId, key }, fetchImpl);
}
export async function testMediaService(store, op, p) {
  if (
    !["image", "video"].includes(p.kind) ||
    typeof p.jobId !== "string" ||
    !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(p.jobId)
  )
    throw Error("无效的测试任务");
  const cwd = path.join(store.directory, "media-tests");
  const options = {
    cwd,
    dataDir: store.directory,
    sessionId: "media-settings-tests",
    ...mediaOptions(store, p.kind, { service: p.service, model: p.model }),
  };
  const tool =
    p.kind === "video" ? comfyuiVideoTool(options) : comfyuiTool(options);
  let input = { operation: "status", job_id: p.jobId };
  if (op === "test") {
    if (
      p.confirmCharge !== true ||
      !options.mediaRoute?.model.modes.includes(p.mode) ||
      kindOf(options.mediaRoute.model) !== p.kind
    )
      throw Error("请先确认测试模型、任务类型与可能产生的费用");
    await mkdir(cwd, { recursive: true });
    const image = "landscape.png";
    if (
      p.mode === "image_to_video" ||
      p.mode === "image_to_image" ||
      p.mode === "reference_to_video"
    ) {
      await copyFile(
        new URL("./assets/media-test.png", import.meta.url),
        path.join(cwd, image),
        constants.COPYFILE_EXCL,
      ).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    }
    input = {
      operation: "generate",
      mode: p.mode,
      request_id: p.jobId,
      prompt:
        "A quiet mountain lake at sunrise, with soft light and gentle ripples.",
      ...(p.mode === "image_to_video"
        ? { image_path: image }
        : ["image_to_image", "reference_to_video"].includes(p.mode)
          ? { reference_images: [image] }
          : {}),
    };
  }
  const r = await tool.execute(input);
  return {
    status: r.status,
    error: r.error,
    file: (r.images ?? r.videos)?.[0]?.path ?? null,
    jobId: r.job_id,
  };
}
function validateModels(type, list) {
  if (!Array.isArray(list) || !list.length || list.length > 200)
    throw Error("请选择可用模型");
  const models = list.map((m) => {
    const preset = mediaCatalog[type].models.find((x) => x.id === m?.id);
    if (preset) return preset;
    if (["ark", "bailian"].includes(type)) {
      const allowed = compatibleModes(type, m?.id);
      if (!Array.isArray(m?.modes) || !m.modes.length || !m.modes.every(x => allowed.includes(x)))
        throw Error("此模型或任务类型不属于当前生成服务");
      return model(m.id, m.id, ...new Set(m.modes));
    }
    if (
      !["openai", "comfy"].includes(type) ||
      typeof m?.id !== "string" ||
      !m.id.trim() ||
      m.id.length > 300 ||
      !Array.isArray(m.modes) ||
      !m.modes.length ||
      m.modes.some((x) => !modes.includes(x))
    )
      throw Error("模型或任务能力无效");
    if (type === "openai" && m.modes.some((x) => !x.endsWith("_image")))
      throw Error("OpenAI Images 仅支持图片");
    if (
      type === "comfy" &&
      (!m.id.startsWith("saved:") || m.modes.length !== 1)
    )
      throw Error("请选择服务中已保存的工作流");
    return model(
      m.id.trim(),
      type === "comfy" ? m.id.slice(6).replace(/\.json$/, "") : m.id.trim(),
      ...new Set(m.modes),
    );
  });
  if (new Set(models.map((m) => m.id)).size !== models.length)
    throw Error("模型重复");
  return models;
}
export async function mediaSettings(store, op, p = {}) {
  if (op === "read") return publicState(registry(store.read(roots)));
  await store.update(async (state) => {
    const r = registry(state);
    if (p.revision !== r.revision)
      throw Error("生成服务已在其他窗口更改，请刷新后重试");
    if (op === "save") {
      const old = r.services.find((s) => s.id === p.id);
      if (p.id && !old) throw Error("服务不存在");
      if (
        !Object.hasOwn(mediaCatalog, p.type) ||
        typeof p.name !== "string" ||
        !p.name.trim() ||
        p.name.length > 80 ||
        typeof p.url !== "string" ||
        !p.url.trim()
      )
        throw Error("请填写服务名称和地址");
      const url = comfyuiUrl(p.url.trim()),
        models = validateModels(p.type, p.models);
      const workspaceId = p.type === "bailian" ? (p.workspaceId ?? old?.workspaceId)?.trim() : undefined;
      if (workspaceId) workspaceOrigin(url, workspaceId);
      if (
        !["openai", "comfy"].includes(p.type) &&
        !mediaCatalog[p.type].urls.includes(url)
      )
        throw Error("请选择厂商官方地址");
      if (
        p.apiKey != null &&
        (typeof p.apiKey !== "string" || p.apiKey.length > 8192)
      )
        throw Error("API Key 无效");
      const secret = p.apiKey?.trim()
        ? await protectSecret(p.apiKey.trim())
        : old?.url === url && old.type === p.type
          ? old.secret
          : null;
      if (!["openai", "comfy"].includes(p.type) && !secret)
        throw Error("请填写该服务的 API Key");
      const identity =
        old && secret === old.secret && url === old.url && p.type === old.type
          ? old.identity
          : randomUUID();
      const s = {
        id: old?.id ?? randomUUID(),
        name: p.name.trim(),
        type: p.type,
        url,
        models,
        ...(workspaceId ? { workspaceId } : {}),
        secret,
        identity,
        custom: p.custom === true,
      };
      if (old) r.services[r.services.indexOf(old)] = s;
      else r.services.push(s);
    } else if (op === "remove") {
      r.services = r.services.filter((s) => s.id !== p.id);
    } else if (op === "default") {
      const m = r.services
        .find((s) => s.id === p.service)
        ?.models.find((m) => m.id === p.model);
      if (!m || kindOf(m) !== p.kind) throw Error("所选模型不支持此媒体类型");
      r.defaults[p.kind] = { service: p.service, model: m.id };
    } else throw Error("未知生成服务操作");
    for (const kind of ["image", "video"]) {
      const choices = r.services.flatMap((s) =>
        s.models
          .filter((m) => kindOf(m) === kind)
          .map((m) => ({ service: s.id, model: m.id })),
      );
      if (
        !choices.some(
          (x) =>
            x.service === r.defaults[kind]?.service &&
            x.model === r.defaults[kind]?.model,
        )
      )
        r.defaults[kind] = choices[0] ?? null;
    }
    r.revision++;
    state.mediaServices = r;
  }, roots);
  return publicState(registry(store.read(roots)));
}
