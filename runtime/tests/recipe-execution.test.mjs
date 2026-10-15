import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../store.mjs";
import { LibraryService } from "../library.mjs";
import { ScheduleService } from "../schedules.mjs";
import {
  prepareRecipe,
  recipeExtensions,
  renderRecipeTemplate,
} from "../recipe-execution.mjs";
import * as schemas from "../../ui/sdk/dist/generated/zod.gen.js";

const recipe = {
  title: "Build {{ name }}",
  description: "Verify a project",
  instructions:
    'Work on {{name | upper}}. {% if mode == "tests" %}Run tests.{% else %}Implement.{% endif %}',
  prompt: "Build {{ name }}.",
  parameters: [
    {
      key: "name",
      input_type: "string",
      requirement: "required",
      description: "Name",
    },
    {
      key: "mode",
      input_type: "select",
      requirement: "optional",
      description: "Mode",
      default: "tests",
      options: ["tests", "code"],
    },
  ],
};

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-recipe-execution-")),
  );
  const store = await openStore(path.join(root, "data"));
  const library = new LibraryService(store);
  t.after(async () => {
    await library.close();
    await store.flush();
    assert.ok(path.basename(root).startsWith("codebuddy-recipe-execution-"));
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, library };
}

test("original parameter request prepares rendered recipe, model settings and typed extensions without running a model", async (t) => {
  const { library } = await fixture(t);
  const saved = await library.request("_goose/unstable/recipes/save", {
    recipe: {
      ...recipe,
      settings: {
        goose_provider: "fixture-provider",
        goose_model: "model-{{mode}}",
        temperature: 0.3,
        max_turns: 25,
      },
      extensions: [
        {
          type: "stdio",
          name: "fixture",
          cmd: "node",
          args: ["tool.mjs", "{{name}}"],
          envs: { MODE: "{{mode}}" },
          env_keys: ["API_TOKEN"],
          cwd: "C:/work/{{name}}",
          available_tools: ["read_file"],
        },
      ],
    },
  });
  const calls = [];
  const prepared = await prepareRecipe(
    library,
    { recipeId: saved.id },
    "session-fixture",
    {
      async ask(method, input) {
        calls.push({ method, input });
        schemas.zRequestRecipeParams_unstable.parse(input);
        return { action: "submit", values: { name: "多模块项目" } };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].method,
    "_goose/unstable/session/recipe/request-params",
  );
  assert.equal(prepared.recipe.prompt, "Build 多模块项目.");
  assert.equal(prepared.recipe.instructions, "Work on 多模块项目. Run tests.");
  assert.equal(prepared.providerId, "fixture-provider");
  assert.equal(prepared.modelId, "model-tests");
  assert.equal(prepared.temperature, 0.3);
  assert.equal(prepared.maxTurns, 25);
  assert.equal(prepared.recipe.settings.max_turns, 25);
  assert.equal(prepared.userRecipeValues.mode, "tests");
  assert.equal(Object.getPrototypeOf(prepared.userRecipeValues), null);
  const extension = schemas.zGooseExtension.parse(
    prepared.enabledExtensions[0],
  );
  assert.equal(extension.server.args[1], "多模块项目");
  assert.equal(extension.server._meta.cwd, "C:/work/多模块项目");
  assert.deepEqual(extension.server.env, [{ name: "MODE", value: "tests" }]);
  assert.deepEqual(extension.envKeys, ["API_TOKEN"]);
  assert.equal((await library.getRecipe(saved.id)).prompt, recipe.prompt);
});

test("cancel and malformed parameter values stop recipe creation using the original cancellation reason", async (t) => {
  const { library } = await fixture(t);
  const meta = { recipe };
  await assert.rejects(
    prepareRecipe(library, meta, "session-fixture", {
      ask: async () => ({ action: "cancel" }),
    }),
    (error) => error.data.reason === "recipe_params_cancelled",
  );
  await assert.rejects(
    prepareRecipe(library, meta, "session-fixture", {
      ask: async () => ({ values: { name: "" } }),
    }),
    /required/u,
  );
  await assert.rejects(
    prepareRecipe(library, meta, "session-fixture", {
      ask: async () => ({ values: { name: "x", mode: "unexpected" } }),
    }),
    /listed option/u,
  );
  await assert.rejects(
    prepareRecipe(
      library,
      {
        recipe: {
          ...recipe,
          parameters: [...recipe.parameters, recipe.parameters[0]],
        },
      },
      "s",
    ),
    /unique identifiers/u,
  );
  await assert.rejects(
    prepareRecipe(
      library,
      {
        ...meta,
        recipeInteractive: false,
        userRecipeValues: { name: "x", extra: "value" },
      },
      "s",
    ),
    /Unexpected/u,
  );
  await assert.rejects(
    prepareRecipe(
      library,
      {
        recipe: {
          ...recipe,
          parameters: [{ ...recipe.parameters[0], key: "__proto__" }],
        },
      },
      "s",
    ),
    /unique identifiers/u,
  );
});

test("scheduled snapshots render defaults without a dialog and recipe schedules project from one registry", async (t) => {
  const { library, store } = await fixture(t);
  const saved = await library.request("_goose/unstable/recipes/save", {
    recipe: {
      ...recipe,
      parameters: recipe.parameters.map((parameter) => ({
        ...parameter,
        default: parameter.default ?? "Scheduled project",
      })),
    },
  });
  const scheduler = new ScheduleService(store, {
    timers: false,
    getRecipe: (id) => library.getRecipe(id),
    timeZone: "Asia/Shanghai",
  });
  await scheduler.start();
  await scheduler.request("_goose/unstable/recipes/schedule", {
    id: saved.id,
    cron_schedule: "0 0 14 * * *",
  });
  assert.equal((await library.listRecipes())[0].schedule_cron, "0 0 14 * * *");
  const prepared = await prepareRecipe(
    library,
    { recipe: store.read().schedules[0].recipe, recipeInteractive: false },
    "s",
    {
      ask: async () => {
        throw new Error("Background task must not open a parameter dialog");
      },
    },
  );
  assert.equal(prepared.recipe.prompt, "Build Scheduled project.");
  await scheduler.request("_goose/unstable/recipes/schedule", {
    id: saved.id,
    cron_schedule: null,
  });
  assert.equal((await library.listRecipes())[0].schedule_cron, null);
  await scheduler.close();
});

test("recipe links use the same rendering path and single-pass values preserve text literally", async (t) => {
  const { library } = await fixture(t);
  const { deeplink } = await library.request("_goose/unstable/recipes/encode", {
    recipe,
  });
  const prepared = await prepareRecipe(
    library,
    {
      recipeDeeplink: deeplink,
      recipeInteractive: false,
      userRecipeValues: { name: "{{process.exit()}}" },
    },
    "s",
  );
  assert.equal(prepared.recipe.prompt, "Build {{process.exit()}}.");
  assert.equal(
    renderRecipeTemplate(
      '{% for item in [name, "two"] %}{{item | upper}} {% endfor %}',
      { name: "one" },
    ),
    "ONE TWO ",
  );
  assert.equal(renderRecipeTemplate("{{ name }}", { name: "a<&b" }), "a<&b");
  assert.deepEqual(await prepareRecipe(library, {}, "s"), {
    recipe: null,
    userRecipeValues: null,
    enabledExtensions: [],
  });
});

test("template AST rejects property/call/import escapes, unsafe filters, undefined symbols and unbounded loops", () => {
  const rejected = [
    "{{ name.constructor }}",
    '{{ name["constructor"] }}',
    "{{ name.toString() }}",
    "{{ range(1, 100) }}",
    '{{ "x" | attr("constructor") }}',
    '{{ ["x"] | join(" ", "constructor") }}',
    '{% include "private.txt" %}',
    '{% import "private.txt" as secrets %}',
    "{% macro run() %}x{% endmacro %}{{run()}}",
    '{% set name = "x" %}{{ name }}',
    "{{ process }}",
    "{{ missing }}",
    "{{ r/x/ }}",
    "{% for a in [1] %}{% for b in [2] %}{{b}}{% endfor %}{% endfor %}",
    "{% for a in name %}{{a}}{% endfor %}",
  ];
  for (const source of rejected)
    assert.throws(
      () => renderRecipeTemplate(source, { name: "x".repeat(129) }),
      undefined,
      source,
    );
  assert.throws(
    () => renderRecipeTemplate("{{name}}", JSON.parse('{"__proto__":"x"}')),
    /Invalid recipe parameter/u,
  );
  assert.throws(
    () =>
      renderRecipeTemplate("{{file}}{{file}}", { file: "x".repeat(600_000) }),
    /potential rendered recipe/u,
  );
  assert.throws(
    () =>
      renderRecipeTemplate("{% for a in [1, 2, 3] %}{{file}}{% endfor %}", {
        file: "x".repeat(400_000),
      }),
    /potential rendered recipe/u,
  );
});

test("explicit file parameters read bounded UTF-8 data and defaults never cause hidden file access", async (t) => {
  const { library, root } = await fixture(t);
  const filename = path.join(root, "requirements.txt");
  await writeFile(filename, "跨模块实现与测试\n");
  const fileRecipe = {
    title: "File task",
    description: "Read selected input",
    prompt: "Input:\n{{input}}",
    parameters: [
      {
        key: "input",
        input_type: "file",
        requirement: "required",
        description: "Input file",
      },
    ],
  };
  const prepared = await prepareRecipe(
    library,
    {
      recipe: fileRecipe,
      recipeInteractive: false,
      userRecipeValues: { input: filename },
    },
    "s",
  );
  assert.equal(prepared.recipe.prompt, "Input:\n跨模块实现与测试\n");
  assert.equal(prepared.userRecipeValues.input, filename);
  await assert.rejects(
    prepareRecipe(
      library,
      {
        recipe: {
          ...fileRecipe,
          parameters: [{ ...fileRecipe.parameters[0], default: filename }],
        },
        recipeInteractive: false,
      },
      "s",
    ),
    /explicit user selection/u,
  );
  await assert.rejects(
    prepareRecipe(
      library,
      {
        recipe: fileRecipe,
        recipeInteractive: false,
        userRecipeValues: { input: "relative.txt" },
      },
      "s",
    ),
    /absolute/u,
  );
  await writeFile(filename, Buffer.from([0xff, 0xfe]));
  await assert.rejects(
    prepareRecipe(
      library,
      {
        recipe: fileRecipe,
        recipeInteractive: false,
        userRecipeValues: { input: filename },
      },
      "s",
    ),
  );
});

test("parameter types, extension conversion and unsupported execution controls are explicit", async (t) => {
  const { library } = await fixture(t);
  for (const [type, value] of [
    ["number", "NaN"],
    ["boolean", "yes"],
    ["date", "2026-02-30"],
  ]) {
    await assert.rejects(
      prepareRecipe(
        library,
        {
          recipe: {
            title: "Types",
            description: "Check",
            prompt: "{{value}}",
            parameters: [
              {
                key: "value",
                input_type: type,
                requirement: "required",
                description: "Value",
              },
            ],
          },
          recipeInteractive: false,
          userRecipeValues: { value },
        },
        "s",
      ),
      /needs/u,
    );
  }
  for (const fields of [
    { retry: { max_retries: 1 } },
    { sub_recipes: [{ name: "child", path: "child.yaml" }] },
    { response: { json_schema: { type: "object" } } },
  ]) {
    await assert.rejects(
      prepareRecipe(library, { recipe: { ...recipe, ...fields } }, "s"),
      (error) => error.data.reason === "recipe_feature_not_connected",
    );
  }
  const extensions = recipeExtensions([
    { type: "builtin", name: "developer" },
    {
      type: "streamable_http",
      name: "api",
      uri: "http://localhost:9876/mcp",
      headers: { Authorization: "${API_TOKEN}" },
      env_keys: ["API_TOKEN"],
    },
  ]);
  assert.equal(extensions[0].type, "builtin");
  assert.equal(extensions[1].server.type, "http");
  assert.deepEqual(extensions[1].server.headers, [
    { name: "Authorization", value: "${API_TOKEN}" },
  ]);
  const inlineHttp = recipeExtensions([
    {
      type: "streamable_http",
      name: "api",
      uri: "http://localhost:9876/mcp",
      envs: { API_TOKEN: "literal-value" },
    },
  ]);
  assert.deepEqual(inlineHttp[0].server._meta.codebuddyRecipeEnvs, [
    { name: "API_TOKEN", value: "literal-value" },
  ]);
  for (const max_turns of [0, -1, 1.5, 100001]) {
    await assert.rejects(
      prepareRecipe(
        library,
        { recipe: { ...recipe, settings: { max_turns } } },
        "s",
      ),
      /maximum turns|max_turns/,
    );
  }
});
