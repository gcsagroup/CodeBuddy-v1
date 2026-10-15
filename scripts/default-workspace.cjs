"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function defaultWorkspaceRoot({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const configured = env.CODEBUDDY_WORKSPACE_ROOT;
  const root =
    configured ||
    (platform === "win32" && exists("D:\\")
      ? "D:\\CodeBuddy-Workspace"
      : paths.join(home, "Documents", "CodeBuddy Workspace"));
  if (
    typeof root !== "string" ||
    !paths.isAbsolute(root) ||
    paths.normalize(root) === paths.parse(root).root
  ) {
    throw new Error(
      "The default workspace root must be an absolute non-root directory",
    );
  }
  return paths.normalize(root);
}

function prepareDefaultWorkspace(root) {
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error("The default workspace root must be a regular directory");
  }
  return fs.realpathSync(root);
}

module.exports = { defaultWorkspaceRoot, prepareDefaultWorkspace };
