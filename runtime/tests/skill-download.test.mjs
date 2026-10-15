import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SkillDownloader,
  publicSkillAddress,
  skillDownloadUrl,
} from "../skill-download.mjs";
import { LibraryService } from "../library.mjs";
import { openStore } from "../store.mjs";
import * as schemas from "../../ui/sdk/dist/generated/zod.gen.js";

const publicAddresses = [{ address: "1.1.1.1", family: 4 }];
const lookup = async () => publicAddresses;
const raw = (name) =>
  Buffer.from(
    `---\nname: ${name}\ndescription: Run the project workflow\nlicense: See LICENSE\n---\n\nRead references/example.md before invoking scripts/run.sh.\n`,
  );
const reply = (body) => ({
  status: 200,
  headers: {},
  body: Buffer.isBuffer(body)
    ? Buffer.from(body)
    : Buffer.from(JSON.stringify(body)),
});
const reason = (value) => (error) => {
  assert.equal(error.data?.reason, value);
  return true;
};
const githubUrl = "https://github.com/example/skills/tree/main/skills/deploy";
const commit = "a".repeat(40);
const rootTree = "b".repeat(40);
const skillsTree = "c".repeat(40);
const deployTree = "d".repeat(40);
const api = "https://api.github.com/repos/example/skills";
const blobSha = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

function githubFixture(options = {}) {
  const documents = new Map([
    ["SKILL.md", raw("deploy")],
    ["LICENSE", Buffer.from("MIT License\nCopyright fixture author\n")],
    ["references/example.md", Buffer.from("Use isolated test data.\n")],
    [
      "scripts/run.sh",
      Buffer.from("#!/bin/sh\nprintf executed > SHOULD_NOT_EXIST\n"),
    ],
  ]);
  let entries = [...documents].map(([name, body]) => ({
    path: name,
    type: "blob",
    mode: name.endsWith(".sh") ? "100755" : "100644",
    sha: blobSha(body),
    size: body.length,
  }));
  entries = options.entries?.(structuredClone(entries)) ?? entries;
  const metadata = new Map([
    [
      `${api}/commits/main`,
      options.commit ?? { sha: commit, commit: { tree: { sha: rootTree } } },
    ],
    [
      `${api}/git/trees/${rootTree}`,
      {
        tree: [
          { path: "skills", type: "tree", mode: "040000", sha: skillsTree },
        ],
      },
    ],
    [
      `${api}/git/trees/${skillsTree}`,
      {
        tree: [
          { path: "deploy", type: "tree", mode: "040000", sha: deployTree },
        ],
      },
    ],
    [
      `${api}/git/trees/${deployTree}?recursive=1`,
      { tree: entries, truncated: options.truncated ?? false },
    ],
  ]);
  const calls = [];
  const transport = async (url, config) => {
    calls.push({ url: url.href, config });
    if (metadata.has(url.href)) return reply(metadata.get(url.href));
    const prefix = `https://raw.githubusercontent.com/example/skills/${commit}/skills/deploy/`;
    assert.ok(url.href.startsWith(prefix), url.href);
    const name = decodeURIComponent(url.href.slice(prefix.length));
    const bytes = documents.get(name);
    assert.ok(bytes, name);
    return reply(
      options.corrupt === name ? Buffer.from("corrupted source") : bytes,
    );
  };
  return {
    downloader: new SkillDownloader({
      lookup,
      transport,
      limits: options.limits,
    }),
    calls,
    metadata,
    documents,
  };
}

async function libraryFixture(t, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-skill-download-")),
  );
  const store = await openStore(path.join(root, "data"));
  const refreshed = [];
  const library = new LibraryService(store, {
    driver: { refreshSkills: async (target) => refreshed.push(target) },
    ...options,
  });
  const connection = {
    ask() {
      throw new Error("Import uses the original UI apply action");
    },
  };
  const call = (name, params = {}, owner = connection) =>
    library.request(`_goose/unstable/skills/manage/${name}`, params, owner);
  const list = schemas.zSkillManagementListResponse_unstable.parse(
    await call("list"),
  );
  const destination = {
    ...list.destinationRoots.find((row) => row.rootKind === "global"),
    name: "imported-skill",
  };
  t.after(async () => {
    await library.close();
    await store.flush();
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codebuddy-skill-download-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, library, connection, destination, call, refreshed };
}

test("remote URLs and public address checks reject local, reserved and mapped private destinations", async () => {
  assert.equal(
    skillDownloadUrl("https://example.com/SKILL.md").protocol,
    "https:",
  );
  for (const url of [
    "http://example.com/SKILL.md",
    "file:///tmp/SKILL.md",
    "https://user:token@example.com/SKILL.md",
    "https://example.com:444/SKILL.md",
    "https://example.com/SKILL.md#fragment",
  ]) {
    assert.throws(() => skillDownloadUrl(url), reason("unsafe_download_url"));
  }
  assert.throws(
    () => skillDownloadUrl("invalid"),
    reason("invalid_download_url"),
  );
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicSkillAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(publicSkillAddress(address), true, address);
  const downloader = new SkillDownloader({
    lookup,
    transport() {
      assert.fail("Unsupported input reached network");
    },
  });
  for (const url of [
    "https://example.com/archive.zip",
    "https://github.com/example/skills/blob/main/SKILL.md",
    "https://github.com/example/skills/tree/main",
  ])
    await assert.rejects(
      downloader.download(url),
      reason("unsupported_download_url"),
    );
});

test("DNS is validated for every redirect and exact addresses are passed to the transport", async () => {
  const calls = [];
  const downloader = new SkillDownloader({
    lookup: async (hostname) =>
      hostname === "private.example"
        ? [{ address: "10.0.0.1", family: 4 }]
        : publicAddresses,
    transport: async (url, options) => {
      calls.push(url.hostname);
      assert.deepEqual(options.addresses, publicAddresses);
      return {
        status: 302,
        headers: { location: "https://private.example/SKILL.md" },
      };
    },
  });
  await assert.rejects(
    downloader.download("https://public.example/SKILL.md"),
    reason("private_network_rejected"),
  );
  assert.deepEqual(calls, ["public.example"]);
  const mixed = new SkillDownloader({
    lookup: async () => [...publicAddresses, { address: "::1", family: 6 }],
    transport() {
      assert.fail("Mixed DNS results were used");
    },
  });
  await assert.rejects(
    mixed.download("https://example.com/SKILL.md"),
    reason("private_network_rejected"),
  );
  const restricted = new SkillDownloader({
    lookup,
    transport: async () => ({
      status: 302,
      headers: { location: "https://elsewhere.example/SKILL.md" },
    }),
  });
  await assert.rejects(
    restricted.download(githubUrl),
    reason("unexpected_download_host"),
  );
  const loop = new SkillDownloader({
    lookup,
    limits: { redirects: 1 },
    transport: async (url) => ({
      status: 302,
      headers: { location: url.href },
    }),
  });
  await assert.rejects(
    loop.download("https://example.com/SKILL.md"),
    reason("redirect_limit"),
  );
});

test("timeouts, HTTP errors, malformed responses and byte limits return bounded reasons", async () => {
  const keepAlive = setInterval(() => {}, 100);
  try {
    for (const stalled of ["lookup", "transport"]) {
      const downloader = new SkillDownloader({
        lookup,
        transport: async () => reply(raw("demo")),
        [stalled]: async () => new Promise(() => {}),
        limits: { timeoutMs: 10 },
      });
      await assert.rejects(
        downloader.download("https://example.com/SKILL.md"),
        reason("download_timeout"),
      );
    }
  } finally {
    clearInterval(keepAlive);
  }
  for (const [response, expected] of [
    [
      {
        status: 401,
        headers: {},
        body: Buffer.from("TOKEN should never appear"),
      },
      "download_http_error",
    ],
    [{ status: 302, headers: {} }, "invalid_redirect"],
    [{ status: 302, headers: { location: "https://[" } }, "invalid_redirect"],
    [reply(Buffer.alloc(20)), "download_size_limit"],
  ]) {
    const downloader = new SkillDownloader({
      lookup,
      transport: async () => response,
      limits: { fileBytes: 10 },
    });
    await assert.rejects(
      downloader.download("https://example.com/SKILL.md"),
      (error) => {
        reason(expected)(error);
        assert.ok(!JSON.stringify(error).includes("TOKEN"));
        return true;
      },
    );
  }
  const dnsFailure = new SkillDownloader({
    lookup: async () => {
      throw new Error("DNS internal credential");
    },
  });
  await assert.rejects(
    dnsFailure.download("https://example.com/SKILL.md"),
    reason("download_dns_failed"),
  );
});

test("direct SKILL.md bytes traverse a real isolated HTTP fixture and source queries are redacted", async (t) => {
  const document = raw("downloaded");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.end(document);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const downloader = new SkillDownloader({
    lookup,
    transport: async (url, options) => {
      assert.deepEqual(options.addresses, publicAddresses);
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,
        { signal: options.signal },
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  });
  const result = await downloader.download(
    "https://fixture.example/SKILL.md?token=fixture-only",
  );
  assert.deepEqual(
    result.files.find((row) => row.relativePath === "SKILL.md").buffer,
    document,
  );
  assert.deepEqual(requests, ["/SKILL.md?token=fixture-only"]);
  assert.equal(result.provenance.queryRedacted, true);
  assert.ok(!JSON.stringify(result.provenance).includes("fixture-only"));
  assert.equal(
    result.provenance.files[0].sha256,
    createHash("sha256").update(document).digest("hex"),
  );
});

test("GitHub import pins the commit and verifies Git object hashes for the entire selected directory", async () => {
  const fixture = githubFixture();
  const result = await fixture.downloader.download(githubUrl);
  assert.equal(result.provenance.commit, commit);
  assert.equal(result.provenance.directory, "skills/deploy");
  assert.deepEqual(
    result.files.map((file) => file.relativePath),
    [...fixture.documents.keys(), ".codebuddy-source.json"],
  );
  for (const [name, bytes] of fixture.documents)
    assert.deepEqual(
      result.files.find((file) => file.relativePath === name).buffer,
      bytes,
    );
  assert.equal(
    result.files.find((file) => file.relativePath === "scripts/run.sh")
      .executable,
    true,
  );
  assert.equal(fixture.calls.length, 8);
  assert.ok(
    fixture.calls
      .slice(4)
      .every((row) => row.url.includes(`/${commit}/skills/deploy/`)),
  );
});

test("GitHub metadata rejects links, submodules, path escapes, truncation, oversized bundles and altered bytes", async () => {
  const cases = [
    [{ commit: { sha: "not-a-commit" } }, "invalid_github_commit"],
    [{ truncated: true }, "invalid_download_response"],
    [
      {
        entries: (rows) =>
          rows.map((row, index) => (index ? row : { ...row, mode: "120000" })),
      },
      "linked_download_entry",
    ],
    [
      {
        entries: (rows) => [
          ...rows,
          { path: "submodule", type: "commit", mode: "160000" },
        ],
      },
      "linked_download_entry",
    ],
    [
      { entries: (rows) => [...rows, { ...rows[0], path: "../outside" }] },
      "download_path_escape",
    ],
    [
      { entries: (rows) => [...rows, { ...rows[0], path: "scripts/NUL.txt" }] },
      "download_path_escape",
    ],
    [
      { entries: (rows) => [...rows, { ...rows[0], path: "skill.md" }] },
      "download_path_escape",
    ],
    [
      { entries: (rows) => rows.filter((row) => row.path !== "SKILL.md") },
      "missing_skill_document",
    ],
    [
      {
        entries: (rows) =>
          rows.map((row, index) =>
            index ? row : { ...row, size: 1024 * 1024 + 1 },
          ),
      },
      "download_size_limit",
    ],
    [{ limits: { files: 2 } }, "download_file_limit"],
    [
      {
        limits: { totalBytes: 1200, fileBytes: 1024 },
        entries: (rows) => rows.map((row) => ({ ...row, size: 500 })),
      },
      "download_size_limit",
    ],
    [{ corrupt: "LICENSE" }, "invalid_download_response"],
  ];
  for (const [options, expected] of cases)
    await assert.rejects(
      githubFixture(options).downloader.download(githubUrl),
      reason(expected),
    );
});

test("original preview/apply RPC installs a reviewed snapshot, license and references without executing scripts", async (t) => {
  const remote = githubFixture();
  const context = await libraryFixture(t, { downloader: remote.downloader });
  const input = schemas.zSkillManagementDownloadPreviewRequest_unstable.parse({
    destination: context.destination,
    url: githubUrl,
  });
  const preview = schemas.zSkillManagementPreviewResponse_unstable.parse(
    await context.call("download-preview", input),
  );
  assert.equal(preview.operation, "download");
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.hasConflict, false);
  assert.ok(preview.files.includes("LICENSE"));
  assert.ok(preview.diff.includes(commit));
  await assert.rejects(stat(preview.target), { code: "ENOENT" });
  const beforeApply = remote.calls.length;
  remote.documents.set("LICENSE", Buffer.from("Upstream moved after preview"));
  const applied = schemas.zSkillManagementApplyResponse_unstable.parse(
    await context.call("apply", { previewToken: preview.previewToken }),
  );
  assert.equal(remote.calls.length, beforeApply);
  assert.equal(applied.skill.name, "imported-skill");
  assert.match(applied.skill.rawDocument, /license: See LICENSE/u);
  assert.match(
    await readFile(path.join(preview.target, "LICENSE"), "utf8"),
    /MIT License/u,
  );
  assert.match(
    await readFile(path.join(preview.target, "references/example.md"), "utf8"),
    /isolated test data/u,
  );
  await assert.rejects(stat(path.join(preview.target, "SHOULD_NOT_EXIST")), {
    code: "ENOENT",
  });
  const provenance = JSON.parse(
    await readFile(path.join(preview.target, ".codebuddy-source.json"), "utf8"),
  );
  assert.deepEqual(provenance.installedSkill, {
    sourceName: "deploy",
    name: "imported-skill",
    documentSha256: createHash("sha256")
      .update(applied.skill.rawDocument)
      .digest("hex"),
  });
  assert.equal(provenance.commit, commit);
  assert.deepEqual(context.refreshed, [preview.target]);
  const list = schemas.zSkillManagementListResponse_unstable.parse(
    await context.call("list"),
  );
  assert.ok(list.skills.some((skill) => skill.name === "imported-skill"));
  const staging = path.join(
    path.dirname(path.dirname(preview.target)),
    ".codebuddy-skill-staging",
  );
  assert.deepEqual(await readdir(staging), []);
  await assert.rejects(
    context.call("apply", { previewToken: preview.previewToken }),
    reason("invalid_preview"),
  );
});

test("remote preview validates destinations and UTF-8 frontmatter before creating any installed skill", async (t) => {
  let requests = 0;
  let bytes = Buffer.from([0xff]);
  const downloader = new SkillDownloader({
    lookup,
    transport: async () => {
      requests++;
      return reply(bytes);
    },
  });
  const context = await libraryFixture(t, { downloader });
  const download = (overrides) =>
    context.call("download-preview", {
      destination: context.destination,
      url: "https://fixture.example/SKILL.md",
      ...overrides,
    });
  await assert.rejects(
    download({ destination: { ...context.destination, name: "../outside" } }),
    reason("missing_name"),
  );
  await assert.rejects(
    download({ destination: { ...context.destination, name: "a".repeat(65) } }),
    reason("missing_name"),
  );
  assert.equal(requests, 0);
  await assert.rejects(download(), reason("invalid_skill_document"));
  bytes = Buffer.from(
    "---\nname: deploy\ndescription: test\nlicense: [MIT]\n---\nBody",
  );
  await assert.rejects(download(), reason("invalid_skill_document"));
  assert.equal((await context.call("list")).skills.length, 0);
});

test("download previews retain original connection, expiry and destination conflict boundaries", async (t) => {
  let now = Date.now();
  const context = await libraryFixture(t, {
    downloader: githubFixture().downloader,
    now: () => now,
    previewLifetimeMs: 100,
  });
  const preview = () =>
    context.call("download-preview", {
      url: githubUrl,
      destination: context.destination,
    });
  const first = await preview();
  await assert.rejects(
    context.call("apply", { previewToken: first.previewToken }, {}),
    reason("invalid_preview"),
  );
  now += 101;
  await assert.rejects(
    context.call("apply", { previewToken: first.previewToken }),
    reason("expired_preview"),
  );
  const second = await preview();
  context.library.disconnect(context.connection);
  await assert.rejects(
    context.call("apply", { previewToken: second.previewToken }),
    reason("invalid_preview"),
  );
  const third = await preview();
  await mkdir(third.target, { recursive: true });
  await writeFile(path.join(third.target, "owner.txt"), "existing user file");
  await assert.rejects(
    context.call("apply", { previewToken: third.previewToken }),
    reason("filesystem_identity_changed"),
  );
  assert.equal(
    await readFile(path.join(third.target, "owner.txt"), "utf8"),
    "existing user file",
  );
  const conflict = await preview();
  assert.equal(conflict.hasConflict, true);
  await assert.rejects(
    context.call("apply", { previewToken: conflict.previewToken }),
    reason("destination_conflict"),
  );
});

test("disconnect and shutdown cancel only owned downloads and publish no partial preview", async (t) => {
  const signals = [];
  let started;
  let nextStarted = () =>
    new Promise((resolve) => {
      started = resolve;
    });
  const downloader = new SkillDownloader({
    lookup,
    transport: async (_url, { signal }) => {
      signals.push(signal);
      started();
      return new Promise(() => {});
    },
  });
  const context = await libraryFixture(t, { downloader });
  const begin = () =>
    context.call("download-preview", {
      url: "https://fixture.example/SKILL.md",
      destination: context.destination,
    });
  let ready = nextStarted();
  let pending = assert.rejects(begin(), reason("download_failed"));
  await ready;
  context.library.disconnect({});
  assert.equal(signals[0].aborted, false);
  context.library.disconnect(context.connection);
  await pending;
  assert.equal(signals[0].aborted, true);
  ready = nextStarted();
  pending = assert.rejects(begin(), reason("download_failed"));
  await ready;
  await context.library.close();
  await pending;
  assert.equal(signals[1].aborted, true);
  assert.equal(context.library.previews.size, 0);
  await assert.rejects(begin(), reason("download_failed"));
});
