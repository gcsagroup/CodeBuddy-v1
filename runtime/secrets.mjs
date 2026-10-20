import { spawn } from "node:child_process";
import { userInfo } from 'node:os';
import { builtinArtifacts, verifiedBinary } from './builtin-artifacts.mjs';

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
async function macCredential(action, value) {
  const binary = await verifiedBinary((await builtinArtifacts()).credentials);
  return new Promise((resolve, reject) => {
    // Tool/test profiles can redirect HOME. Keychain belongs to the logged-in
    // OS account, so only this helper receives the account's real home.
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, HOME: userInfo().homedir } });
    const chunks = [];
    let bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof result !== 'string') throw Error();
        resolve(result);
      } catch { reject(Error('Mac credential protection returned an invalid response')); }
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('Mac credential protection timed out')); }, 30000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill(); finish(Error('Mac credential response exceeds its limit')); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => finish(Error('Mac credential protection could not start')));
    child.stdin.on('error', () => finish(Error('Mac credential protection input failed')));
    child.on('close', code => finish(code === 0 ? null : Error('Mac credential protection failed; check Keychain access')));
    child.stdin.end(JSON.stringify({ action, value }));
  });
}
const platformKind = () => process.platform === 'darwin' ? 'macos-keychain-aesgcm-v1' : 'windows-dpapi';
const transform = (action, value) => process.platform === 'darwin' ? macCredential(action, value) : dpapi(action, value);
export async function protectSecret(value) {
  return value
    ? {
        kind: platformKind(),
        ciphertext: await transform("protect", String(value)),
      }
    : null;
}
export async function revealSecret(value) {
  if (!value) return "";
  if (!['windows-dpapi', 'macos-keychain-aesgcm-v1'].includes(value.kind)) throw Error("Unknown credential format");
  if (value.kind !== platformKind()) throw Error('Credential belongs to another platform');
  if (typeof value.ciphertext !== 'string' || !value.ciphertext) throw Error('Invalid credential ciphertext');
  const key = `${value.kind}:${value.ciphertext}`;
  if (!revealing.has(key)) {
    const pending = transform("unprotect", value.ciphertext).finally(() => revealing.delete(key));
    revealing.set(key, pending);
  }
  return revealing.get(key);
}
