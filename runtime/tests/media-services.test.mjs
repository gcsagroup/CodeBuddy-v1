import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import {
  mediaSettings,
  mediaOptions,
  mediaCatalog,
  refreshMediaModels,
  testMediaService,
} from "../media-services.mjs";
import { mediaCloud } from "../media-cloud.mjs";
import { openStore } from "../store.mjs";
import { comfyuiTool } from "../comfyui-tool.mjs";
import { comfyuiVideoTool } from "../comfyui-video-tool.mjs";

const png = await readFile(
  new URL("../assets/media-test.png", import.meta.url),
);
const mp4 = await readFile(
  new URL("./fixtures/media-lake.mp4", import.meta.url),
);
async function fixture(t) {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "codebuddy-media-services-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cwd = path.join(dataDir, "workspace");
  await mkdir(cwd);
  return { dataDir, cwd, sessionId: "case-1" };
}
const route = (type, kind) => ({
  type,
  url: mediaCatalog[type].urls[0],
  serviceId: "test-" + type,
  model: mediaCatalog[type].models.find((m) => m.modes.includes(kind)),
});

test("official discovery reads only the regional catalog and keeps existing defaults", async (t) => {
  const store = await openStore((await fixture(t)).dataDir);
  const before = await mediaSettings(store, "read");
  const ark = { type: "ark", url: mediaCatalog.ark.urls[0], apiKey: "fixture" };
  const arkModel = { id: "doubao-seedance-2-5-pro-260901", status: "Retiring",
    modalities: { input_modalities: ["text", "image"], output_modalities: ["video"] } };
  const { models } = await refreshMediaModels(store, ark, async (url, options) => {
    assert.equal(url.href, ark.url + "/models");
    assert.equal(options.headers.Authorization, "Bearer fixture");
    assert.equal(options.redirect, "error");
    return Response.json({ data: [arkModel, { ...arkModel, id: "doubao-seed-chat" }, arkModel] });
  });
  assert.deepEqual(models, [{ id: arkModel.id, label: arkModel.id, retiring: true, modes: ["text_to_video", "image_to_video"] }]);
  const aliyun = { type: "bailian", url: mediaCatalog.bailian.urls[1], workspaceId: "workspace-example", apiKey: "fixture" };
  const pages = [];
  const catalog = await refreshMediaModels(store, aliyun, async (url) => {
    assert.equal(url.origin, "https://workspace-example.ap-southeast-1.maas.aliyuncs.com");
    pages.push(url.searchParams.get("page_no"));
    const row = pages.length === 1 ? { model: "qwen3", inference_metadata: { response_modality: ["Text"] } } :
      { model: "qwen-image-3.0-pro", inference_metadata: { request_modality: ["Text"], response_modality: ["Image"] } };
    return Response.json({ success: true, output: { models: [row], total: 2 } });
  });
  assert.deepEqual(pages, ["1", "2"]);
  assert.deepEqual(catalog.models[0].modes, ["text_to_image"]);
  await assert.rejects(refreshMediaModels(store, { ...aliyun, workspaceId: "invalid.example" }, assert.fail), /业务空间/);
  await assert.rejects(refreshMediaModels(store, { ...ark, url: "https://other.test" }, assert.fail), /官方/);
  await assert.rejects(refreshMediaModels(store, ark, async () => new Response(null, {status: 401})), /401/);
  assert.deepEqual(await mediaSettings(store, "read"), before);
  if (["win32", "darwin"].includes(process.platform)) {
    const saved = await mediaSettings(store, "save", { ...aliyun, revision: before.revision, name: "QA", models: catalog.models });
    assert.deepEqual(saved.defaults, before.defaults);
    const service = saved.services.at(-1);
    const selected = mediaOptions(store, "image", { service: service.id, model: catalog.models[0].id });
    assert.equal(selected.mediaRoute.apiBase, "https://workspace-example.ap-southeast-1.maas.aliyuncs.com");
  }
});

test("discovered Wan 2.7 submits the saved image as the first frame to its workspace", async () => {
  const apiBase = "https://test-workspace.cn-beijing.maas.aliyuncs.com";
  const client = mediaCloud({ type: "bailian", url: mediaCatalog.bailian.urls[0], apiBase,
    model: { id: "wan2.7-i2v-2026-04-25" } }, { fetchImpl: async (url, options) => {
    assert.equal(url, apiBase + "/api/v1/services/aigc/video-generation/video-synthesis");
    const { input } = JSON.parse(options.body);
    assert.deepEqual(input, {prompt: "a lake", media: [{type: "first_frame", url: "data:image/png;base64," + png.toString("base64")}]});
    return Response.json({ output: { task_id: "wan-fixture" } });
  } });
  assert.deepEqual(await client.submit("video", {prompt: "a lake"}, [png]), {remoteId: "wan-fixture"});
});

test("legacy defaults survive upgrade; registry edits are atomic and keys stay bound to their endpoint", async (t) => {
  const { dataDir } = await fixture(t),
    store = await openStore(dataDir);
  await store.update((s) => {
    s.preferences.comfyuiBaseUrl = "http://legacy.test:8188";
  });
  const first = await mediaSettings(store, "read");
  assert.equal(first.services[0].url, "http://legacy.test:8188");
  assert.equal(mediaOptions(store, "video").baseUrl, first.services[0].url);
  const svc = {
    name: "Gateway",
    type: "openai",
    url: "https://one.test/v1",
    models: [{ id: "project", modes: ["text_to_image"] }],
  };
  const key = ["win32", "darwin"].includes(process.platform)
    ? "isolated-media-test-key"
    : "";
  const saved = await mediaSettings(store, "save", {
    ...svc,
    apiKey: key,
    revision: 0,
  });
  assert.equal(saved.services.length, 2);
  assert.equal(saved.services[1].hasKey, !!key);
  assert.equal(saved.services[1].secret, undefined);
  assert.ok(
    !key ||
      !(await readFile(path.join(dataDir, "state.json"), "utf8")).includes(key),
  );
  const id = saved.services[1].id;
  await assert.rejects(
    mediaSettings(store, "remove", { id, revision: 0 }),
    /刷新/,
  );
  await assert.rejects(
    mediaSettings(store, "default", {
      revision: 1,
      kind: "video",
      service: id,
      model: "project",
    }),
    /不支持/,
  );
  await mediaSettings(store, "default", {
    revision: 1,
    kind: "image",
    service: id,
    model: "project",
  });
  const options = mediaOptions(store, "image");
  assert.equal(await options.authorize(options.mediaRoute), key);
  await mediaSettings(store, "save", {
    ...svc,
    id,
    url: "https://two.test/v1",
    revision: 2,
  });
  await assert.rejects(options.authorize(options.mediaRoute), /更改/);
  assert.equal((await mediaSettings(store, "read")).services[1].hasKey, false);
  await assert.rejects(
    testMediaService(store, "test", {
      jobId: randomUUID(),
      service: id,
      kind: "image",
      model: "project",
      mode: "text_to_image",
    }),
    /费用/,
  );
});

for (const [imageType, videoType] of [
  ["bailian", "ark"],
  ["ark", "bailian"],
  ["openai", "fal"],
]) {
  test(`${imageType} PNG becomes ${videoType} first frame; recreated tools query exactly one remote job`, async (t) => {
    const f = await fixture(t),
      calls = [];
    const imageRoute =
      imageType === "openai"
        ? {
            type: "openai",
            model: {
              id: "test-model",
              modes: ["text_to_image"],
              label: "Gateway",
            },
            url: "http://gateway.test/v1",
            serviceId: "g",
          }
        : route(imageType, "text_to_image");
    const videoRoute = route(videoType, "image_to_video");
    const imageUrl = imageRoute.url + "/sample.png",
      videoUrl = videoRoute.url + "/sample.mp4";
    const fetchImpl = async (url, options) => {
      calls.push([url, options.method]);
      if (url === imageUrl || url === videoUrl) {
        assert.equal(options.headers, undefined);
        return new Response(url === imageUrl ? png : mp4);
      }
      assert.equal(
        options.headers.Authorization,
        videoType === "fal" && url.startsWith(videoRoute.url)
          ? "Key fixture"
          : "Bearer fixture",
      );
      if (url.startsWith(imageRoute.url)) {
        const b = JSON.parse(options.body);
        assert.equal(b.model, imageRoute.model.id);
        if (imageType === "bailian") {
          assert.equal(b.input.messages[0].content[0].text, "a lake");
          return Response.json({
            output: {
              choices: [{ message: { content: [{ image: imageUrl }] } }],
            },
          });
        }
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      }
      if (options.method === "POST") {
        const b = JSON.parse(options.body);
        const ref =
          videoType === "ark"
            ? b.content[1].image_url.url
            : videoType === "bailian"
              ? b.input.img_url
              : b.image_url;
        assert.equal(ref, "data:image/png;base64," + png.toString("base64"));
        return Response.json({
          id: "vendor-1",
          request_id: "vendor-1",
          output: { task_id: "vendor-1" },
        });
      }
      assert.match(url, /vendor-1/);
      if (videoType === "fal")
        return Response.json(
          url.endsWith("/status")
            ? { status: "COMPLETED" }
            : { video: { url: videoUrl } },
        );
      return Response.json({
        status: "succeeded",
        content: { video_url: videoUrl },
        output: { task_status: "SUCCEEDED", video_url: videoUrl },
      });
    };
    const options = (r) => ({
      ...f,
      fetchImpl,
      baseUrl: r.url,
      mediaRoute: r,
      authorize: async () => "fixture",
    });
    const image = await comfyuiTool(options(imageRoute)).execute({
      operation: "generate",
      prompt: "a lake",
    });
    assert.equal(image.status, "completed");
    assert.deepEqual(image, JSON.parse(JSON.stringify(image)));
    assert.deepEqual(await readFile(image.images[0].path), png);
    const generate = {
      operation: "generate",
      prompt: "gentle movement",
      mode: "image_to_video",
      image_path: image.images[0].path,
      request_id: randomUUID(),
    };
    const video = comfyuiVideoTool(options(videoRoute));
    await assert.rejects(
      video.execute({ ...generate, mode: "text_to_video" }),
      /Reference/,
    );
    const submitted = await video.execute(generate);
    assert.deepEqual(submitted, JSON.parse(JSON.stringify(submitted)));
    assert.equal(submitted.prompt_id, "vendor-1");
    assert.equal((await video.execute(generate)).job_id, submitted.job_id);
    const reopened = comfyuiVideoTool(
      options({
        ...videoRoute,
        serviceId: "another-default",
        url: "https://different.test",
      }),
    );
    const result = await reopened.execute({
      operation: "status",
      job_id: submitted.job_id,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(await readFile(result.videos[0].path), mp4);
    assert.equal(
      calls.filter(([u, m]) => u.startsWith(videoRoute.url) && m === "POST")
        .length,
      1,
    );
    assert.equal((await reopened.jobs())[0].status, "completed");
  });
}

test("lost acknowledgement remains unknown across retry; reference escapes are refused before submission", async (t) => {
  const f = await fixture(t),
    r = route("ark", "text_to_video");
  let submits = 0;
  const options = {
    ...f,
    mediaRoute: r,
    baseUrl: r.url,
    fetchImpl: async () => {
      submits++;
      throw Error("timeout");
    },
  };
  const input = {
    operation: "generate",
    prompt: "lake",
    mode: "text_to_video",
    request_id: randomUUID(),
  };
  const first = await comfyuiVideoTool(options).execute(input);
  assert.equal(first.status, "submission_unknown");
  assert.equal(
    (await comfyuiVideoTool(options).execute(input)).status,
    "submission_unknown",
  );
  assert.equal(
    (
      await comfyuiVideoTool(options).execute({
        operation: "status",
        job_id: first.job_id,
      })
    ).status,
    "submission_unknown",
  );
  await assert.rejects(
    comfyuiVideoTool(options).execute({
      ...input,
      request_id: randomUUID(),
      mode: "image_to_video",
      image_path: import.meta.filename,
    }),
    /workspace/,
  );
  assert.equal(submits, 1);
});
test("custom image edits use multipart and downloads never forward the account key", async () => {
  const client = mediaCloud(
    { type: "openai", url: "https://gateway.test/v1", model: { id: "custom" } },
    {
      key: "fake",
      fetchImpl: async (url, req) => {
        assert.equal(url, "https://gateway.test/v1/images/edits");
        assert.equal(req.body.get("prompt"), "edit");
        assert.deepEqual(
          Buffer.from(await req.body.get("image").arrayBuffer()),
          png,
        );
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      },
    },
  );
  assert.deepEqual(
    (await client.submit("image", { prompt: "edit" }, [png])).bytes,
    png,
  );
  await assert.rejects(
    client.download("https://other.test/file", 1024),
    /下载域名/,
  );
});
