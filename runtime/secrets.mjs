import { spawn } from "node:child_process";

// Concurrent UI and session preparation reads can request the same ciphertext.
// Share only the in-flight OS operation; retain no decrypted value after it settles.
const revealing = new Map();

// Pass secret material on stdin, never in arguments, logs, or the public config.
const script =
  "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $result=if($v.action -eq 'protect'){ $b=[Text.Encoding]::UTF8.GetBytes($v.value); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) } else { [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v.value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) }; ConvertTo-Json -InputObject $result -Compress";
async function dpapi(action, value) {
  if (process.platform !== "win32")
    throw Error(
      "This Windows preview requires platform credential storage before saving API keys on another OS",
    );
  return new Promise((resolve, reject) => {
    const p = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      // JSON framing preserves whitespace in credentials; console defaults do
      // not reliably decode UTF-8 MCP descriptions on Windows PowerShell 5.
      try { resolve(JSON.parse(out)); }
      catch { reject(Error("Windows credential protection returned an invalid response")); }
    };
    const timer = setTimeout(() => {
      p.kill();
      finish(Error("Windows credential protection timed out"));
    }, 30000);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => (out += chunk));
    p.stderr.resume();
    p.on("error", () =>
      finish(Error("Windows credential protection could not start")),
    );
    p.stdin.on("error", () =>
      finish(Error("Windows credential protection input failed")),
    );
    p.on("close", (code) =>
      finish(code === 0 ? null : Error("Windows credential protection failed")),
    );
    p.stdin.end(JSON.stringify({ action, value }));
  });
}
export async function protectSecret(value) {
  return value
    ? {
        kind: "windows-dpapi",
        ciphertext: await dpapi("protect", String(value)),
      }
    : null;
}
export async function revealSecret(value) {
  if (!value) return "";
  if (value.kind !== "windows-dpapi") throw Error("Unknown credential format");
  const key = value.ciphertext;
  if (!revealing.has(key)) {
    const pending = dpapi("unprotect", key).finally(() => revealing.delete(key));
    revealing.set(key, pending);
  }
  return revealing.get(key);
}
