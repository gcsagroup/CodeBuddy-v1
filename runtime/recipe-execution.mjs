import { createRequire } from "node:module";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  zRecipeParamsResponse_unstable,
  zGooseExtension,
} from "../ui/sdk/dist/generated/zod.gen.js";

const require = createRequire(import.meta.url);
const nunjucks = require("nunjucks");
const invalid = (reason, message = reason) =>
  Object.assign(new Error(message), { code: -32602, data: { reason } });
const unsupported = (feature) =>
  Object.assign(new Error(`Recipe feature is not connected: ${feature}`), {
    code: -32601,
    data: { reason: "recipe_feature_not_connected", feature },
  });
const MAX_TEXT = 1_048_576;
const MAX_PARAMETER = 65_536;
const reserved = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "range",
  "cycler",
  "joiner",
  "lipsum",
  "self",
  "super",
  "loop",
  "global",
  "process",
  "require",
]);
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const allowedNodes = new Set([
  "Root",
  "NodeList",
  "Output",
  "TemplateData",
  "Literal",
  "Symbol",
  "Array",
  "Group",
  "If",
  "InlineIf",
  "For",
  "Filter",
  "Compare",
  "CompareOperand",
  "In",
  "Or",
  "And",
  "Not",
  "Add",
  "Concat",
  "Sub",
  "Mul",
  "Div",
  "FloorDiv",
  "Mod",
  "Neg",
  "Pos",
]);
const allowedFilters = new Map([
  ["lower", 1],
  ["upper", 1],
  ["trim", 1],
  ["capitalize", 1],
  ["title", 1],
  ["length", 1],
  ["first", 1],
  ["last", 1],
  ["reverse", 1],
  ["default", 3],
  ["join", 2],
  ["escape", 1],
  ["e", 1],
  ["urlencode", 1],
  ["int", 3],
  ["float", 2],
]);

function text(value, label, limit = MAX_TEXT) {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit)
    throw invalid(
      "invalid_recipe_value",
      `${label} must be text within ${limit} bytes`,
    );
  return value;
}

function validName(name) {
  return (
    typeof name === "string" && namePattern.test(name) && !reserved.has(name)
  );
}

// Nunjucks explicitly does not sandbox arbitrary templates. Only this positive
// syntax subset reaches its compiler: scalar values, bounded loops and pure
// filters. No member access, calls, loaders, globals, imports or extensions.
function validateTemplate(source, values) {
  const root = nunjucks.parser.parse(text(source, "Recipe template"));
  let count = 0;
  let loopCount = 0;
  function walk(node, names, depth = 0, inLoop = false) {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, names, depth, inLoop);
      return;
    }
    if (
      !(node instanceof nunjucks.nodes.Node) ||
      !allowedNodes.has(node.typename)
    )
      throw invalid(
        "unsupported_recipe_template",
        `Recipe template syntax is not supported: ${node?.typename ?? "value"}`,
      );
    if (++count > 4096 || depth > 64)
      throw invalid(
        "recipe_template_limit",
        "Recipe template complexity exceeds the limit",
      );
    if (node.typename === "Symbol") {
      if (!validName(node.value) || !names.has(node.value))
        throw invalid(
          "unknown_recipe_parameter",
          `Recipe template references an unknown parameter: ${node.value}`,
        );
      return;
    }
    if (node.typename === "Literal" || node.typename === "TemplateData") {
      if (
        node.value !== null &&
        !["string", "number", "boolean"].includes(typeof node.value)
      )
        throw invalid("unsupported_recipe_template");
      if (typeof node.value === "number" && !Number.isFinite(node.value))
        throw invalid("invalid_recipe_value");
      return;
    }
    if (node.typename === "Filter") {
      const maximum = allowedFilters.get(node.name?.value);
      if (
        node.name?.typename !== "Symbol" ||
        !maximum ||
        node.args.children.length > maximum
      )
        throw invalid(
          "unsupported_recipe_filter",
          `Recipe filter is not supported: ${node.name?.value}`,
        );
      walk(node.args, names, depth + 1, inLoop);
      return;
    }
    if (node.typename === "For") {
      if (
        inLoop ||
        ++loopCount > 16 ||
        node.name?.typename !== "Symbol" ||
        !validName(node.name.value)
      )
        throw invalid(
          "recipe_template_limit",
          "Recipe loops must be single-level with one scalar variable",
        );
      let iterations;
      if (node.arr?.typename === "Array") iterations = node.arr.children.length;
      else if (
        node.arr?.typename === "Symbol" &&
        Object.hasOwn(values, node.arr.value)
      )
        iterations = values[node.arr.value].length;
      if (!Number.isSafeInteger(iterations) || iterations > 128)
        throw invalid(
          "recipe_template_limit",
          "Recipe loop sources must be explicit arrays or parameters of at most 128 characters",
        );
      walk(node.arr, names, depth + 1, false);
      const localNames = new Set([...names, node.name.value]);
      walk(node.body, localNames, depth + 1, true);
      walk(node.else_, names, depth + 1, false);
      return;
    }
    if (node.typename === "Array" && node.children.length > 128)
      throw invalid("recipe_template_limit");
    for (const field of node.fields) {
      // Comparison operators are parser-owned tokens, not variable references.
      if (node.typename === "CompareOperand" && field === "type") continue;
      walk(node[field], names, depth + 1, inLoop);
    }
  }
  walk(root, new Set(Object.keys(values)));
  // Bound expansion before invoking the compiler: repeated parameters or loop
  // output must not allocate an arbitrarily large intermediate string.
  const cap = (size) => Math.min(MAX_TEXT + 1, size);
  const sum = (sizes) => sizes.reduce((total, size) => cap(total + size), 0);
  function size(node, locals = new Map()) {
    if (!node) return 0;
    if (Array.isArray(node))
      return sum(node.map((child) => size(child, locals)));
    switch (node.typename) {
      case "Literal":
      case "TemplateData":
        return Buffer.byteLength(String(node.value ?? ""));
      case "Symbol":
        return locals.get(node.value) ?? Buffer.byteLength(values[node.value]);
      case "Root":
      case "NodeList":
      case "Output":
      case "Group":
        return size(node.children, locals);
      case "Array":
        return cap(size(node.children, locals) + node.children.length);
      case "If":
      case "InlineIf":
        return Math.max(size(node.body, locals), size(node.else_, locals));
      case "For": {
        const iterations =
          node.arr.typename === "Array"
            ? node.arr.children.length
            : values[node.arr.value].length;
        const elementSize =
          node.arr.typename === "Array"
            ? Math.max(
                0,
                ...node.arr.children.map((child) => size(child, locals)),
              )
            : 4;
        return Math.max(
          cap(
            size(
              node.body,
              new Map([...locals, [node.name.value, elementSize]]),
            ) * iterations,
          ),
          size(node.else_, locals),
        );
      }
      case "Filter": {
        const args = node.args.children;
        const inputSize = size(args[0], locals);
        const name = node.name.value;
        if (["length", "int", "float"].includes(name)) return 64;
        if (name === "default")
          return Math.max(inputSize, size(args[1], locals));
        if (name === "join")
          return cap(inputSize + 128 * size(args[1], locals));
        if (["escape", "e", "urlencode"].includes(name))
          return cap(inputSize * 9);
        return cap(inputSize * 3);
      }
      case "Add":
      case "Concat":
        return cap(size(node.left, locals) + size(node.right, locals));
      default:
        return 64;
    }
  }
  if (size(root) > MAX_TEXT)
    throw invalid(
      "recipe_template_limit",
      "The potential rendered recipe exceeds 1 MiB",
    );
}

export function renderRecipeTemplate(source, values) {
  if (source == null) return source;
  const input = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (!validName(key))
      throw invalid(
        "invalid_recipe_parameter",
        `Invalid recipe parameter name: ${key}`,
      );
    input[key] = text(value, `Parameter ${key}`);
  }
  try {
    validateTemplate(source, input);
    const environment = new nunjucks.Environment([], {
      autoescape: false,
      throwOnUndefined: true,
    });
    environment.globals = Object.create(null);
    const pureFilters = Object.create(null);
    for (const name of allowedFilters.keys())
      pureFilters[name] = environment.getFilter(name);
    environment.filters = pureFilters;
    return text(environment.renderString(source, input), "Rendered recipe");
  } catch (error) {
    if (error.code) throw error;
    throw invalid("invalid_recipe_template", error.message);
  }
}

async function fileContents(filename) {
  if (!path.isAbsolute(filename))
    throw invalid(
      "invalid_recipe_file",
      "A file parameter must be an absolute path selected by the user",
    );
  let current = path.normalize(filename);
  const selected = await lstat(current, { bigint: true });
  while (true) {
    if ((await lstat(current)).isSymbolicLink())
      throw invalid(
        "invalid_recipe_file",
        "File parameter links are not supported",
      );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (
      info.dev !== selected.dev ||
      info.ino !== selected.ino ||
      info.birthtimeNs !== selected.birthtimeNs
    )
      throw invalid(
        "invalid_recipe_file",
        "The selected file changed before it was opened",
      );
    if (!info.isFile() || info.size > BigInt(MAX_TEXT))
      throw invalid(
        "invalid_recipe_file",
        "A file parameter must be a regular UTF-8 file within 1 MiB",
      );
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_TEXT)
      throw invalid("invalid_recipe_file", "The file parameter exceeds 1 MiB");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
    if (content.includes("\0"))
      throw invalid(
        "invalid_recipe_file",
        "A file parameter must contain text",
      );
    return content;
  } finally {
    await handle.close();
  }
}

function validateValue(parameter, value) {
  text(value, `Parameter ${parameter.key}`, MAX_PARAMETER);
  const trimmed = value.trim();
  if (parameter.requirement !== "optional" && !trimmed)
    throw invalid(
      "missing_recipe_parameter",
      `Recipe parameter is required: ${parameter.key}`,
    );
  if (!trimmed && parameter.requirement === "optional") return;
  if (
    parameter.input_type === "number" &&
    (!trimmed || !Number.isFinite(Number(trimmed)))
  )
    throw invalid(
      "invalid_recipe_parameter",
      `Recipe parameter needs a number: ${parameter.key}`,
    );
  if (parameter.input_type === "boolean" && !["true", "false"].includes(value))
    throw invalid(
      "invalid_recipe_parameter",
      `Recipe parameter needs true or false: ${parameter.key}`,
    );
  if (parameter.input_type === "select" && !parameter.options?.includes(value))
    throw invalid(
      "invalid_recipe_parameter",
      `Recipe parameter must use a listed option: ${parameter.key}`,
    );
  if (
    parameter.input_type === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    throw invalid(
      "invalid_recipe_parameter",
      `Recipe parameter needs a real YYYY-MM-DD date: ${parameter.key}`,
    );
}

export function recipeExtensions(extensions = [], render = (value) => value) {
  return extensions.map((extension) => {
    if (["builtin", "platform"].includes(extension.type))
      return zGooseExtension.parse(extension);
    const common = {
      type: "mcp",
      description: extension.description,
      timeout: extension.timeout,
      socket: extension.socket,
      bundled: extension.bundled,
      available_tools: extension.available_tools,
      read_only_tools: extension.read_only_tools,
      envKeys: extension.env_keys ?? [],
    };
    const entries = (values = {}) =>
      Object.entries(values).map(([name, value]) => ({
        name,
        value: render(value),
      }));
    if (extension.type === "stdio")
      return zGooseExtension.parse({
        ...common,
        server: {
          name: extension.name,
          command: render(extension.cmd),
          args: (extension.args ?? []).map(render),
          env: entries(extension.envs),
          ...(extension.cwd ? { _meta: { cwd: render(extension.cwd) } } : {}),
        },
      });
    if (extension.type === "streamable_http") {
      return zGooseExtension.parse({
        ...common,
        server: {
          type: "http",
          name: extension.name,
          url: render(extension.uri),
          headers: entries(extension.headers),
          ...(Object.keys(extension.envs ?? {}).length
            ? {
                _meta: { codebuddyRecipeEnvs: entries(extension.envs) },
              }
            : {}),
        },
      });
    }
    throw unsupported(`extension type ${extension.type}`);
  });
}

// Authoring can still parse/export old documents. Saving an executable recipe
// and starting it share this boundary so an unsupported field is never ignored.
export function assertRecipeExecutable(recipe) {
  if (recipe.retry != null) throw unsupported("retry");
  if (recipe.sub_recipes?.length) throw unsupported("sub_recipes");
  if (recipe.response?.json_schema != null)
    throw unsupported("response.json_schema");
  const maxTurns = recipe.settings?.max_turns ?? undefined;
  if (
    maxTurns !== undefined &&
    (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100000)
  ) {
    throw invalid(
      "invalid_recipe_max_turns",
      "Recipe maximum turns must be an integer between 1 and 100000",
    );
  }
  return maxTurns;
}

export async function prepareRecipe(
  library,
  meta = {},
  sessionId,
  connection,
  beforeParameters,
) {
  const selections = [meta.recipeId, meta.recipeDeeplink, meta.recipe].filter(
    (value) => value != null,
  );
  if (!selections.length)
    return { recipe: null, userRecipeValues: null, enabledExtensions: [] };
  if (selections.length !== 1)
    throw invalid(
      "invalid_recipe_selection",
      "Choose one recipe id, link, or scheduled recipe snapshot",
    );
  const original = meta.recipeId
    ? await library.getRecipe(meta.recipeId)
    : meta.recipeDeeplink
      ? library.decodeRecipe(meta.recipeDeeplink)
      : library.recipe(meta.recipe);
  const maxTurns = assertRecipeExecutable(original);
  const parameters = original.parameters ?? [];
  if (parameters.length > 128) throw invalid("recipe_parameter_limit");
  const keys = new Set();
  for (const parameter of parameters) {
    if (!validName(parameter.key) || keys.has(parameter.key))
      throw invalid(
        "invalid_recipe_parameter",
        `Recipe parameter names must be unique identifiers: ${parameter.key}`,
      );
    keys.add(parameter.key);
    if (parameter.input_type === "file" && parameter.default != null)
      throw invalid(
        "invalid_recipe_file",
        "File parameters require an explicit user selection and cannot have defaults",
      );
  }
  let supplied = meta.userRecipeValues ?? {};
  if (
    parameters.length &&
    meta.recipeInteractive !== false &&
    connection?.ask
  ) {
    if (typeof sessionId !== "string" || !sessionId)
      throw invalid("invalid_recipe_session");
    await beforeParameters?.();
    const response = zRecipeParamsResponse_unstable.parse(
      await connection.ask("_goose/unstable/session/recipe/request-params", {
        sessionId,
        parameters,
      }),
    );
    if (response.action === "cancel")
      throw invalid("recipe_params_cancelled", "Recipe setup was cancelled");
    supplied = response.values;
  }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw invalid("invalid_recipe_parameter");
  for (const key of Object.keys(supplied))
    if (!keys.has(key))
      throw invalid(
        "unknown_recipe_parameter",
        `Unexpected recipe parameter: ${key}`,
      );
  const userRecipeValues = Object.create(null);
  const renderValues = Object.create(null);
  for (const parameter of parameters) {
    const value = Object.hasOwn(supplied, parameter.key)
      ? supplied[parameter.key]
      : (parameter.default ??
        (parameter.requirement === "optional" ? "" : undefined));
    if (value === undefined)
      throw invalid(
        "missing_recipe_parameter",
        `Recipe parameter is required: ${parameter.key}`,
      );
    validateValue(parameter, value);
    userRecipeValues[parameter.key] = value;
    renderValues[parameter.key] =
      parameter.input_type === "file" && value
        ? await fileContents(value)
        : value;
  }
  if (typeof library.recipeRoot === "string")
    renderValues.recipe_dir = library.recipeRoot;
  const render = (source) => renderRecipeTemplate(source, renderValues);
  const recipe = {
    ...original,
    instructions: render(original.instructions),
    prompt: render(original.prompt),
    title: render(original.title),
    description: render(original.description),
    activities: original.activities?.map(render) ?? original.activities,
  };
  const settings = original.settings ?? {};
  const temperature = settings.temperature ?? undefined;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0)
  )
    throw invalid("invalid_recipe_temperature");
  const providerId =
    settings.goose_provider == null
      ? undefined
      : render(settings.goose_provider).trim();
  const modelId =
    settings.goose_model == null
      ? undefined
      : render(settings.goose_model).trim();
  if (providerId === "" || modelId === "")
    throw invalid("invalid_recipe_model");
  return {
    recipe,
    userRecipeValues: parameters.length ? userRecipeValues : null,
    providerId,
    modelId,
    temperature,
    maxTurns,
    enabledExtensions: recipeExtensions(original.extensions ?? [], render),
  };
}
