"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function locationFile(
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
) {
  const base =
    platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "CodeBuddy", "data-root.txt");
}

function managedRoot(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\r\n\0]/.test(value)
  )
    throw new Error("数据目录必须是完整的文件夹路径");
  const root = path.resolve(value);
  if (root === path.parse(root).root || root === os.homedir())
    throw new Error("请选择独立的数据文件夹，不要使用磁盘根目录或用户主目录");
  return root;
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readDataRoot(file, fallback) {
  const value = readOptional(file);
  return managedRoot(
    value === undefined ? fallback : value.replace(/^\uFEFF/, "").trim(),
  );
}

const jobFileFor = (file) =>
  path.join(path.dirname(file), "data-migration.json");
function readMigration(file) {
  const text = readOptional(jobFileFor(file));
  if (text === undefined) return null;
  const job = JSON.parse(text);
  if (
    job.version !== 1 ||
    !["pending", "copying", "completed", "failed"].includes(job.status)
  )
    throw new Error("迁移记录无效，请保留记录并检查数据目录");
  if (
    ["pending", "copying"].includes(job.status) &&
    !alive(job.workerPid) &&
    !alive(job.parentPid)
  ) {
    // A committed locator is written only after copy verification. Otherwise use the retained source.
    const committed =
      readDataRoot(file, job.source) === path.resolve(job.target);
    return {
      ...job,
      status: committed ? "completed" : "failed",
      error: committed
        ? undefined
        : "上次迁移被中断，原数据保留，未自动删除目标中的部分副本。",
    };
  }
  return job;
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function assertNoMigration(file) {
  const job = readMigration(file);
  if (
    job &&
    ["pending", "copying"].includes(job.status) &&
    (alive(job.workerPid) || alive(job.parentPid))
  )
    throw new Error("CodeBuddy 正在迁移数据，请等待迁移完成后再启动");
}

module.exports = { locationFile, managedRoot, readDataRoot, readMigration, assertNoMigration, jobFileFor };
