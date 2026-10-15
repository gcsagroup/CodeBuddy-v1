import { DatabaseSync } from "node:sqlite";
import { mkdir, lstat, chmod, realpath } from "node:fs/promises";
import path from "node:path";

/** SQLite owns the cross-process lease and releases it even after a crash. */
export async function acquireProfileLock(dataDir) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir))
    throw new TypeError("Profile directory must be absolute");
  await mkdir(dataDir, { recursive: true });
  const directory = await realpath(dataDir);
  const file = path.join(directory, ".profile-lock.sqlite");
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new Error("Profile lock path must not be linked");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let database;
  try {
    database = new DatabaseSync(file, { timeout: 0 });
    database.exec(
      "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER); DELETE FROM owner;",
    );
    database.prepare("INSERT INTO owner (pid) VALUES (?)").run(process.pid);
    await chmod(file, 0o600);
  } catch (error) {
    database?.close();
    if (
      error.errcode === 5 ||
      error.errcode === 6 ||
      error.code === "ERR_SQLITE_BUSY"
    )
      throw Object.assign(
        new Error(
          "Target profile is running or another migration owns it; close it before migration",
        ),
        { code: "PROFILE_IN_USE" },
      );
    throw error;
  }
  let closed = false;
  return {
    directory,
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
