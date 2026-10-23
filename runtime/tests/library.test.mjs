import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../store.mjs";
import { LibraryService } from "../library.mjs";
import * as schemas from "../../ui/sdk/dist/generated/zod.gen.js";

const method = (name) => `_goose/unstable/${name}`;
const raw = (
  name = "demo-skill",
  body = "Read the project and run its tests.",
) => `---\nname: ${name}\ndescription: Project test workflow\n---\n\n${body}`;
const recipe = {
  version: "1.0.0",
  title: "Build a project",
  description: "Implement and test a project",
  prompt: "Build the requested project.",
  parameters: [
    {
      key: "name",
      description: "Project name",
      input_type: "string",
      requirement: "optional",
      default: "demo",
    },
  ],
};

async function fixture(t, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-library-")),
  );
  const store = await openStore(path.join(root, "data"));
  const refreshed = [];
  const library = new LibraryService(store, {
    driver: {
      async refreshSkills(target) {
        refreshed.push(target);
      },
    },
    ...options,
  });
  const confirmations = [];
  const connection = {
    async ask(name, input) {
      confirmations.push({ name, input });
      return { decision: "confirm", nonce: input.nonce };
    },
  };
  const call = (name, input = {}) =>
    library.request(method(name), input, connection);
  t.after(async () => {
    await library.close();
    await store.flush();
    assert.ok(path.basename(root).startsWith("codebuddy-library-"));
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, library, connection, confirmations, refreshed, call };
}

async function createSkill(context, name = "demo-skill", projectDir) {
  const listed = schemas.zSkillManagementListResponse_unstable.parse(
    await context.call("skills/manage/list", { projectDir }),
  );
  const destination = listed.destinationRoots.find(
    (root) => root.rootKind === (projectDir ? "project_agents" : "global"),
  );
  const preview = schemas.zSkillManagementPreviewResponse_unstable.parse(
    await context.call("skills/manage/preview", {
      projectDir,
      change: {
        operation: "create",
        destination: { ...destination, name },
        rawDocument: raw(name),
      },
    }),
  );
  assert.equal(preview.hasConflict, false);
  return schemas.zSkillManagementApplyResponse_unstable.parse(
    await context.call("skills/manage/apply", {
      previewToken: preview.previewToken,
    }),
  ).skill;
}

test("built-in skill sources project Harness definitions as read-only entries", async t => {
  let requestedCwd;
  const { call, root } = await fixture(t, { driver: { async listBuiltinSkills(cwd) {
    requestedCwd = cwd;
    return [{ name: 'office-docx', description: 'Upstream Word workflow', content: 'Use the packaged interpreter.', provider: 'dsh-office' }];
  } } });
  const result = schemas.zListSourcesResponse_unstable.parse(await call('sources/list', { type: 'builtinSkill', projectDir: root }));
  assert.equal(requestedCwd, root);
  assert.equal(result.sources[0].writable, false);
  assert.equal(result.sources[0].content, 'Use the packaged interpreter.');
  assert.equal(result.sources[0].properties.provider, 'dsh-office');
  const managed = schemas.zSkillManagementListResponse_unstable.parse(await call('skills/manage/list', { projectDir: root }));
  const office = managed.skills.find(skill => skill.name === 'office-docx');
  assert.equal(office.readOnly, true);
  assert.equal(office.source.rootKind, 'builtin');
  assert.ok(!managed.destinationRoots.some(root => root.rootKind === 'builtin'));
  const read = schemas.zSkillManagementReadResponse_unstable.parse(await call('skills/manage/read', { projectDir: root, source: office.source }));
  assert.equal(read.skill.rawDocument, office.rawDocument);
  await assert.rejects(call('skills/manage/preview', { projectDir: root, change: {
    operation: 'set_enabled', source: office.source, expectedVersion: office.version, enabled: false,
  } }), /read_only/);
});

test("recipe YAML CRUD, legacy links, slash commands and persistence follow the original schemas", async (t) => {
  const { store, call } = await fixture(t);
  const yaml = schemas.zRecipeToYamlResponse_unstable.parse(
    await call("recipes/to-yaml", { recipe }),
  ).yaml;
  assert.deepEqual(
    (await call("recipes/parse", { content: yaml })).recipe,
    recipe,
  );
  const link = schemas.zEncodeRecipeResponse_unstable.parse(
    await call("recipes/encode", { recipe }),
  ).deeplink;
  assert.deepEqual(
    (await call("recipes/decode", { deeplink: link })).recipe,
    recipe,
  );
  const legacy = encodeURIComponent(
    Buffer.from(JSON.stringify(recipe)).toString("base64"),
  );
  assert.deepEqual(
    (await call("recipes/decode", { deeplink: legacy })).recipe,
    recipe,
  );
  const saved = schemas.zSaveRecipeResponse_unstable.parse(
    await call("recipes/save", { recipe }),
  );
  assert.ok((await stat(saved.file_path)).isFile());
  await call("recipes/slash-command", {
    id: saved.id,
    slash_command: "/build-demo",
  });
  const restarted = new LibraryService(await openStore(store.directory));
  const listed = schemas.zListRecipesResponse_unstable.parse(
    await restarted.request(method("recipes/list")),
  );
  assert.equal(listed.recipes[0].slash_command, "build-demo");
  const commands = schemas.zListSlashCommandsResponse_unstable.parse(
    await call("slash-commands/list"),
  );
  assert.equal(commands.availableCommands[0].name, "build-demo");
  assert.equal(commands.availableCommands[0]._meta.commandType, "Recipe");
  const changed = { ...recipe, prompt: "Build then verify." };
  await call("recipes/save", { id: saved.id, recipe: changed });
  assert.equal(
    (await call("recipes/list")).recipes[0].recipe.prompt,
    changed.prompt,
  );
  await call("recipes/delete", { id: saved.id });
  assert.deepEqual((await call("recipes/list")).recipes, []);
  assert.equal(store.read().recipeSlashCommands[saved.id], undefined);
  await restarted.close();
});

test("unsupported advanced UI fields remain readable but never report a successful executable save", async (t) => {
  const { call } = await fixture(t);
  const saved = await call("recipes/save", { recipe });
  const before = await readFile(saved.file_path, "utf8");
  for (const [feature, extra] of [
    ["retry", { retry: { max_retries: 2 } }],
    ["sub_recipes", { sub_recipes: [{ name: "child", path: "child.yaml" }] }],
    ["response.json_schema", { response: { json_schema: { type: "object" } } }],
  ]) {
    const advanced = { ...recipe, ...extra };
    const exported = (await call("recipes/to-yaml", { recipe: advanced })).yaml;
    assert.deepEqual(
      (await call("recipes/parse", { content: exported })).recipe,
      schemas.zRecipeDto.parse(advanced),
    );
    for (const id of [undefined, saved.id]) {
      await assert.rejects(
        call("recipes/save", { id, recipe: advanced }),
        (error) => error.data?.feature === feature,
      );
      assert.equal(await readFile(saved.file_path, "utf8"), before);
      assert.equal((await call("recipes/list")).recipes.length, 1);
    }
  }
  await call("recipes/save", {
    id: saved.id,
    recipe: { ...recipe, settings: { max_turns: 11 } },
  });
  assert.equal(
    (await call("recipes/list")).recipes[0].recipe.settings.max_turns,
    11,
  );
});

test("recipe validation rejects malformed documents, arbitrary paths and conflicting commands", async (t) => {
  const { call } = await fixture(t);
  await assert.rejects(
    call("recipes/parse", { content: "title: one\ntitle: two" }),
    /unique/u,
  );
  await assert.rejects(
    call("recipes/save", {
      recipe: { title: "Missing prompt", description: "invalid" },
    }),
    /instructions or prompt/u,
  );
  await assert.rejects(
    call("recipes/delete", { id: "../outside" }),
    /recipe_not_found/u,
  );
  await assert.rejects(
    call("recipes/decode", { deeplink: "not a recipe" }),
    /Invalid recipe link/u,
  );
  const a = await call("recipes/save", { recipe });
  const b = await call("recipes/save", {
    recipe: { ...recipe, title: "Second" },
  });
  await call("recipes/slash-command", { id: a.id, slash_command: "same" });
  await assert.rejects(
    call("recipes/slash-command", { id: b.id, slash_command: "same" }),
    /slash_command_conflict/u,
  );
  assert.equal(
    (
      await call("recipes/scan", {
        recipe: {
          ...recipe,
          extensions: [{ type: "stdio", name: "custom", cmd: "node" }],
        },
      })
    ).has_security_warnings,
    true,
  );
  assert.equal(
    await call("recipes/schedule", { id: a.id, cron_schedule: "* * * * *" }),
    undefined,
  );
});

test("skills use Harness discovery and editing updates the live skill files", async (t) => {
  const context = await fixture(t);
  let skill = await createSkill(context);
  assert.ok(
    skill.displayPath.startsWith(
      path.join(context.store.directory, "harness", "agents", "skills"),
    ),
  );
  assert.equal(context.refreshed.length, 1);
  const listed = schemas.zSkillManagementListResponse_unstable.parse(
    await context.call("skills/manage/list"),
  );
  assert.equal(listed.skills[0].name, "demo-skill");
  const preview = await context.call("skills/manage/preview", {
    change: {
      operation: "update_raw",
      source: skill.source,
      expectedVersion: skill.version,
      rawDocument: raw("demo-skill", "Updated instructions."),
    },
  });
  skill = (
    await context.call("skills/manage/apply", {
      previewToken: preview.previewToken,
    })
  ).skill;
  assert.match(
    await readFile(path.join(skill.displayPath, "SKILL.md"), "utf8"),
    /Updated instructions/u,
  );
  const disabled = await context.call("skills/manage/preview", {
    change: {
      operation: "set_enabled",
      source: skill.source,
      expectedVersion: skill.version,
      enabled: false,
    },
  });
  skill = (
    await context.call("skills/manage/apply", {
      previewToken: disabled.previewToken,
    })
  ).skill;
  assert.equal(skill.enabled, false);
  assert.equal(
    (await context.call("slash-commands/list")).availableCommands.some(
      (command) => command.name === "demo-skill",
    ),
    false,
  );
  assert.equal(
    (await context.call("skills/manage/list")).skills[0].enabled,
    false,
  );
});

test("skill previews are connection-bound, expire and reject stale companion edits", async (t) => {
  let now = Date.now();
  const context = await fixture(t, { now: () => now, previewLifetimeMs: 1000 });
  const skill = await createSkill(context);
  const preview = await context.call("skills/manage/preview", {
    change: {
      operation: "update_raw",
      source: skill.source,
      expectedVersion: skill.version,
      rawDocument: raw(),
    },
  });
  await assert.rejects(
    context.library.request(
      method("skills/manage/apply"),
      { previewToken: preview.previewToken },
      {},
    ),
    /invalid_preview/u,
  );
  await writeFile(
    path.join(skill.displayPath, "notes.txt"),
    "changed externally",
  );
  await assert.rejects(
    context.call("skills/manage/apply", { previewToken: preview.previewToken }),
    /stale_source/u,
  );
  const updated = (
    await context.call("skills/manage/read", { source: skill.source })
  ).skill;
  const expiring = await context.call("skills/manage/preview", {
    change: {
      operation: "delete",
      source: updated.source,
      expectedVersion: updated.version,
    },
  });
  now += 1001;
  await assert.rejects(
    context.call("skills/manage/apply", {
      previewToken: expiring.previewToken,
    }),
    /expired_preview/u,
  );
  assert.ok((await stat(skill.displayPath)).isDirectory());
});

test("skill delete requires exact original UI confirmation and can be restored after restart", async (t) => {
  const context = await fixture(t);
  const skill = await createSkill(context);
  await writeFile(
    path.join(skill.displayPath, "asset.bin"),
    Buffer.from([0, 1, 255]),
  );
  const current = (
    await context.call("skills/manage/read", { source: skill.source })
  ).skill;
  const preview = await context.call("skills/manage/preview", {
    change: {
      operation: "delete",
      source: current.source,
      expectedVersion: current.version,
    },
  });
  assert.equal(preview.requiresConfirmation, true);
  const result = schemas.zSkillManagementApplyResponse_unstable.parse(
    await context.call("skills/manage/apply", {
      previewToken: preview.previewToken,
    }),
  );
  assert.equal(
    context.confirmations[0].name,
    method("skills/manage/request-confirmation"),
  );
  assert.equal(
    context.confirmations[0].input.previewToken,
    preview.previewToken,
  );
  await assert.rejects(stat(skill.displayPath), { code: "ENOENT" });
  const restarted = new LibraryService(context.store);
  const entries = schemas.zSkillManagementRecoveryListResponse_unstable.parse(
    await restarted.request(method("skills/manage/recovery/list")),
  ).entries;
  assert.equal(entries[0].recoveryRef, result.recoveryRef);
  const restore = await restarted.request(
    method("skills/manage/preview"),
    { change: { operation: "restore", recoveryRef: result.recoveryRef } },
    context.connection,
  );
  const restored = await restarted.request(
    method("skills/manage/apply"),
    { previewToken: restore.previewToken },
    context.connection,
  );
  assert.equal(restored.skill.name, skill.name);
  assert.deepEqual(
    await readFile(path.join(skill.displayPath, "asset.bin")),
    Buffer.from([0, 1, 255]),
  );
  await restarted.close();
});

test("cancelled or forged skill confirmation preserves the original directory", async (t) => {
  const context = await fixture(t);
  const skill = await createSkill(context);
  for (const reply of [
    { decision: "cancel" },
    { decision: "confirm", nonce: "wrong" },
  ]) {
    const connection = {
      async ask() {
        return reply;
      },
    };
    const preview = await context.library.request(
      method("skills/manage/preview"),
      {
        change: {
          operation: "delete",
          source: skill.source,
          expectedVersion: skill.version,
        },
      },
      connection,
    );
    await assert.rejects(
      context.library.request(
        method("skills/manage/apply"),
        { previewToken: preview.previewToken },
        connection,
      ),
      /confirmation/u,
    );
    assert.ok((await stat(skill.displayPath)).isDirectory());
  }
});

test("project skills, local import, copy and source export use explicit roots", async (t) => {
  const context = await fixture(t);
  const project = path.join(context.root, "project");
  await mkdir(project);
  const skill = await createSkill(context, "project-skill", project);
  assert.ok(
    skill.displayPath.startsWith(path.join(project, ".agents", "skills")),
  );
  const root = (await context.call("skills/manage/list")).destinationRoots[0];
  const copy = await context.call("skills/manage/preview", {
    projectDir: project,
    change: {
      operation: "copy",
      source: skill.source,
      expectedVersion: skill.version,
      destination: { ...root, name: "copied-skill" },
    },
  });
  const copied = (
    await context.call("skills/manage/apply", {
      previewToken: copy.previewToken,
    })
  ).skill;
  assert.equal(copied.name, "copied-skill");
  const exported = await context.call("sources/export", {
    type: "skill",
    path: copied.displayPath,
  });
  const imported = schemas.zImportSourcesResponse_unstable.parse(
    await context.call("sources/import", {
      data: exported.json,
      target: { scope: "global" },
    }),
  );
  assert.equal(imported.sources[0].name, "copied-skill-imported");
  const local = path.join(context.root, "import-skill");
  await mkdir(local);
  await writeFile(path.join(local, "SKILL.md"), raw("import-skill"));
  await writeFile(path.join(local, "asset.txt"), "asset");
  const preview = await context.call("skills/manage/preview", {
    change: {
      operation: "import_local",
      sourcePath: local,
      destination: { ...root, name: "local-skill" },
    },
  });
  const installed = (
    await context.call("skills/manage/apply", {
      previewToken: preview.previewToken,
    })
  ).skill;
  assert.equal(
    await readFile(path.join(installed.displayPath, "asset.txt"), "utf8"),
    "asset",
  );
});

test("skills reject traversal, linked imports, conflicts and malformed frontmatter", async (t) => {
  const context = await fixture(t);
  const skill = await createSkill(context);
  const root = (await context.call("skills/manage/list")).destinationRoots[0];
  await assert.rejects(
    context.call("skills/manage/read", {
      source: { ...skill.source, relativePath: "../outside" },
    }),
    /source_scope_mismatch/u,
  );
  await assert.rejects(
    context.call("skills/manage/preview", {
      change: {
        operation: "create",
        destination: { ...root, name: "bad" },
        rawDocument: "not frontmatter",
      },
    }),
    /missing_frontmatter/u,
  );
  const conflict = await context.call("skills/manage/preview", {
    change: {
      operation: "create",
      destination: { ...root, name: "demo-skill" },
      rawDocument: raw(),
    },
  });
  assert.equal(conflict.hasConflict, true);
  await assert.rejects(
    context.call("skills/manage/apply", {
      previewToken: conflict.previewToken,
    }),
    /destination_conflict/u,
  );
  const linked = path.join(context.root, "linked");
  await symlink(
    skill.displayPath,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    context.call("skills/manage/preview", {
      change: {
        operation: "import_local",
        destination: { ...root, name: "linked-skill" },
        sourcePath: linked,
      },
    }),
    /linked_path_rejected/u,
  );
  await assert.rejects(
    context.call("skills/manage/download-preview", {
      url: "https://example.com/SKILL.md",
    }),
    /missing_name/u,
  );
});

test("agent sources persist real editable files, resolve project scope, and export/import without touching other files", async (t) => {
  const context = await fixture(t);
  const projectDir = path.join(context.root, "agent-project");
  await mkdir(projectDir);
  const global = schemas.zCreateSourceResponse_unstable.parse(
    await context.call("sources/create", {
      type: "agent",
      name: "Code Reviewer",
      description: "Review changes",
      content: "Read diffs and tests.",
      target: { scope: "global" },
    }),
  ).source;
  const local = (
    await context.call("sources/create", {
      type: "agent",
      name: "Code Reviewer",
      description: "Project review",
      content: "Use project conventions.",
      target: { scope: "projectDir", projectDir },
    })
  ).source;
  assert.equal(
    (await context.library.getAgent("Code Reviewer", projectDir)).path,
    local.path,
  );
  const exported = await context.call("sources/export", {
    type: "agent",
    path: global.path,
  });
  const imported = schemas.zImportSourcesResponse_unstable.parse(
    await context.call("sources/import", {
      data: exported.json,
      target: { scope: "global" },
    }),
  );
  assert.equal(imported.sources[0].name, "Code Reviewer imported");
  await context.call("sources/update", {
    type: "agent",
    path: global.path,
    name: global.name,
    description: "Updated",
    content: "Updated instructions.",
  });
  assert.match(await readFile(global.path, "utf8"), /Updated instructions/u);
  await assert.rejects(
    context.call("sources/delete", {
      type: "agent",
      path: path.join(projectDir, "other.txt"),
    }),
    /source_not_found/u,
  );
  await context.call("sources/delete", { type: "agent", path: global.path });
  assert.ok((await stat(local.path)).isFile());
});
