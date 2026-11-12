const MiB = 1024 * 1024;
export async function boundedMediaBody(response, limit) {
  if (Number(response.headers.get("content-length")) > limit)
    throw Error("媒体响应过大");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error("媒体响应过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function taskId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,180}$/.test(value))
    throw Error("服务未返回有效任务 ID，请在厂商控制台核对提交状态");
  return value;
}
const cdns = {
  bailian: ["aliyuncs.com", "aliyuncs.com.cn"],
  ark: ["volces.com", "volces.cn", "volccdn.com", "byteimg.com"],
  fal: ["fal.media", "fal.ai"],
  openai: ["blob.core.windows.net", "openai.com", "oaiusercontent.com"],
};
export function mediaCloud(
  route,
  { fetchImpl = fetch, key = "", signal } = {},
) {
  const { type, model } = route;
  const url = route.apiBase ?? route.url;
  const base = new URL(url);
  async function http(target, options = {}) {
    const timeout = AbortSignal.timeout(300_000);
    const response = await fetchImpl(target, {
      ...options,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const error = new Error(`生成服务 ${type} 返回 HTTP ${response.status}`);
      error.status = response.status;
      // Only retain the provider's error code. Messages may echo the input, key or signed URLs.
      try {
        const body = JSON.parse(
          (await boundedMediaBody(response, 16384)).toString(),
        );
        const code = body.error?.code ?? body.code;
        if (typeof code === "string" && /^[\w.-]{1,100}$/.test(code))
          error.message += ` (${code})`;
      } catch {}
      throw error;
    }
    return response;
  }
  async function api(
    path,
    body,
    extra = {},
    method = body === undefined ? "GET" : "POST",
  ) {
    const headers = {
      ...(key
        ? { Authorization: `${type === "fal" ? "Key" : "Bearer"} ${key}` }
        : {}),
      ...extra,
    };
    const form = body instanceof FormData;
    if (body !== undefined && !form)
      headers["Content-Type"] = "application/json";
    const res = await http(url + path, {
      method,
      headers,
      body: form ? body : JSON.stringify(body),
    });
    return JSON.parse((await boundedMediaBody(res, 48 * MiB)).toString());
  }
  async function download(value, limit) {
    const output = new URL(value);
    if (
      output.username ||
      output.password ||
      !["http:", "https:"].includes(output.protocol) ||
      (output.origin !== base.origin &&
        !(
          output.protocol === "https:" &&
          cdns[type].some(
            (domain) =>
              output.hostname === domain ||
              output.hostname.endsWith("." + domain),
          )
        ))
    )
      throw Error(
        "服务返回了未经配置的下载域名；兼容网关可返回 b64_json 或同源文件",
      );
    return boundedMediaBody(await http(output.href), limit);
  }
  function imageResult(data) {
    if (typeof data?.b64_json === "string" && data.b64_json.length <= 44 * MiB)
      return { bytes: Buffer.from(data.b64_json, "base64") };
    if (typeof data?.url === "string") return { url: data.url };
    throw Error("服务未返回图片文件");
  }
  async function submit(kind, input, bytes) {
    const refs = bytes.map(
      (b) => "data:image/png;base64," + b.toString("base64"),
    );
    const prompt = input.prompt;
    if (kind === "image") {
      const size =
        input.width || input.height
          ? `${input.width ?? 1024}x${input.height ?? 1024}`
          : undefined;
      if (type === "bailian") {
        const data = await api(
          "/api/v1/services/aigc/multimodal-generation/generation",
          {
            model: model.id,
            input: {
              messages: [
                {
                  role: "user",
                  content: [
                    ...refs.map((image) => ({ image })),
                    { text: prompt },
                  ],
                },
              ],
            },
            parameters: {
              n: 1,
              ...(size ? { size: size.replace("x", "*") } : {}),
            },
          },
        );
        return imageResult({
          url: data.output?.choices?.[0]?.message?.content?.find((c) => c.image)
            ?.image,
        });
      }
      const body = { model: model.id, prompt, ...(size ? { size } : {}) };
      if (type === "ark") {
        const data = await api("/images/generations", {
          ...body,
          response_format: "b64_json",
          output_format: "png",
          ...(refs.length ? { image: refs } : {}),
          ...(input.transparent_background
            ? { background: "transparent" }
            : {}),
        });
        return imageResult(data.data?.[0]);
      }
      if (type !== "openai") throw Error("该服务不支持图片");
      if (bytes.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.append(k, v);
        bytes.forEach((b, i) =>
          form.append(
            bytes.length === 1 ? "image" : "image[]",
            new Blob([b], { type: "image/png" }),
            `reference-${i}.png`,
          ),
        );
        if (input.transparent_background)
          form.append("background", "transparent");
        return imageResult((await api("/images/edits", form)).data?.[0]);
      }
      return imageResult(
        (
          await api("/images/generations", {
            ...body,
            n: 1,
            ...(input.transparent_background
              ? { background: "transparent" }
              : {}),
          })
        ).data?.[0],
      );
    }
    const duration = input.duration_seconds;
    if (type === "bailian") {
      const firstFrame = !refs.length ? {} : /^wan2\.7-i2v(?:-|$)/.test(model.id)
        ? { media: [{ type: "first_frame", url: refs[0] }] }
        : { img_url: refs[0] };
      const data = await api(
        "/api/v1/services/aigc/video-generation/video-synthesis",
        {
          model: model.id,
          input: { prompt, ...firstFrame },
          parameters: {
            ...(duration ? { duration } : {}),
            ...(refs.length ? { resolution: "720P" } : { size: "1280*720" }),
          },
        },
        { "X-DashScope-Async": "enable" },
      );
      return { remoteId: taskId(data.output?.task_id) };
    }
    if (type === "ark") {
      const data = await api("/contents/generations/tasks", {
        model: model.id,
        content: [
          { type: "text", text: prompt },
          ...refs.map((url) => ({
            type: "image_url",
            image_url: { url },
            role: "first_frame",
          })),
        ],
        resolution: "720p",
        ...(duration ? { duration } : {}),
      });
      return { remoteId: taskId(data.id) };
    }
    if (type === "fal") {
      const data = await api("/" + model.id, {
        prompt,
        ...(refs.length ? { image_url: refs[0] } : {}),
        ...(duration
          ? { num_frames: Math.round(duration * 16) + 1, frames_per_second: 16 }
          : {}),
      });
      return { remoteId: taskId(data.request_id) };
    }
    throw Error("该接口不支持视频");
  }
  async function query(id) {
    id = taskId(id);
    let status, output, message;
    if (type === "bailian") {
      const { output: task } = await api("/api/v1/tasks/" + id);
      status = task?.task_status;
      output = task?.video_url;
      message = task?.code;
    } else if (type === "ark") {
      const task = await api("/contents/generations/tasks/" + id);
      status = task.status;
      output = task.content?.video_url;
      message = task.error?.code;
    } else if (type === "fal") {
      const path = "/fal-ai/wan/requests/" + id;
      const task = await api(path + "/status");
      status = task.status;
      if (status === "COMPLETED") {
        try {
          output = (await api(path)).video?.url;
        } catch (e) {
          if (e.status === 422) return { status: "failed", error: e.message };
          throw e;
        }
      }
    }
    if (["SUCCEEDED", "succeeded", "COMPLETED"].includes(status)) {
      if (typeof output !== "string")
        throw Error("任务已结束，但结果文件暂不可用");
      return { url: output };
    }
    if (["FAILED", "failed", "expired"].includes(status))
      return {
        status: "failed",
        error: `厂商任务失败 (${typeof message === "string" && /^[\w.-]{1,100}$/.test(message) ? message : status})`,
      };
    if (["CANCELED", "cancelled", "canceled"].includes(status))
      return { status: "cancelled" };
    if (["RUNNING", "running", "IN_PROGRESS"].includes(status))
      return { status: "running" };
    if (["PENDING", "queued", "IN_QUEUE"].includes(status))
      return { status: "queued" };
    return { status: "unavailable" };
  }
  return { submit, query, download };
}
