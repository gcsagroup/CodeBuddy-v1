import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectLegacyProfile,
  migrateLegacyProfile,
} from "../runtime/legacy-migration.mjs";

const input = process.argv.slice(2);
const options = {};
for (let index = 0; index < input.length; index++) {
  const key = input[index];
  if (["--apply", "--offline"].includes(key)) options[key.slice(2)] = true;
  else if (
    ["--source", "--target", "--project-map"].includes(key) &&
    input[index + 1]
  )
    options[key.slice(2)] = input[++index];
  else
    throw new Error(
      "Usage: node scripts/migrate-legacy-profile.mjs --source <old-profile> --target <new-backend> [--project-map <json-file>] [--apply --offline]",
    );
}
try {
  if (!options.source || !options.target)
    throw new Error("Explicit source and target directories are required");
  const projectMap = options["project-map"]
    ? JSON.parse(await readFile(path.resolve(options["project-map"]), "utf8"))
    : {};
  const parameters = {
    sourceDir: path.resolve(options.source),
    targetDir: path.resolve(options.target),
    projectMap,
    offline: options.offline === true,
  };
  console.log(
    JSON.stringify(
      await (options.apply
        ? migrateLegacyProfile(parameters)
        : inspectLegacyProfile(parameters)),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error: error.reason ?? error.code ?? "migration_failed",
      message:
        error.reason ??
        (error.code === "PROFILE_IN_USE"
          ? error.message
          : "Migration stopped; inspect the source schema and target availability"),
    }),
  );
  process.exitCode = 1;
}
