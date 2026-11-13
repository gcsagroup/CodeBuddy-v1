import { autoUpdater, app } from 'electron';
import { createServer, type Server } from 'node:http';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { compareVersions, validateStrict } from 'compare-versions';
import type { UpdateCandidate } from './githubRelease';

// Data is read from JSON, never interpolated into executable PowerShell text.
const windowsHelper = String.raw`
param([string]$ConfigFile)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$receipt = Join-Path (Split-Path -Parent $ConfigFile) 'result.json'
function Save-Result($status, $detail) {
  @{ status=$status; version=$config.version; detail=$detail } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
  Copy-Item -LiteralPath $receipt -Destination $config.lastResult -Force
}
function Assert-Installer {
  $hash = (Get-FileHash -LiteralPath $config.installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $config.sha256) { throw 'Installer checksum mismatch' }
}
try {
  if (Test-Path -LiteralPath $config.cancel) { exit 0 }
  Assert-Installer
  @{ pid=$PID; version=$config.version } | ConvertTo-Json | Set-Content -LiteralPath $config.helperReady -Encoding UTF8
  $deadline = (Get-Date).AddMinutes(2)
  while (!(Test-Path -LiteralPath $config.ready)) {
    if (Test-Path -LiteralPath $config.cancel) { exit 0 }
    if ((Get-Date) -gt $deadline) { throw 'Update was not confirmed; installation cancelled' }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $config.cancel) { exit 0 }
  @{ pid=$PID; version=$config.version } | ConvertTo-Json | Set-Content -LiteralPath $config.armed -Encoding UTF8
  $parent = Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue
  if ($parent -and !$parent.WaitForExit(60000)) { throw 'Application did not exit; installation cancelled' }
  Assert-Installer
  $machineKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{57246561-8F37-48B1-9DE6-2878918A3EBA}_is1'
  $machineDirectory = Get-ItemPropertyValue -LiteralPath $machineKey -Name 'Inno Setup: App Path' -ErrorAction SilentlyContinue
  $scope = if ($machineDirectory -and ([IO.Path]::GetFullPath($machineDirectory).TrimEnd('\') -eq $config.directory)) { '/ALLUSERS' } else { '/CURRENTUSER' }
  $arguments = @('/SP-', '/SILENT', '/NORESTART', '/NOCLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', $scope, '/CODEBUDDYUPDATE=1', ('/DIR="' + $config.directory + '"'), ('/LOG="' + $config.log + '"'))
  $installer = Start-Process -FilePath $config.installer -ArgumentList $arguments -PassThru -Wait
  if ($installer.ExitCode -ne 0) { throw ('Installer exit code: ' + $installer.ExitCode) }
  $version = (Get-Item -LiteralPath $config.executable).VersionInfo.ProductVersion
  if ($version -ne $config.version) { throw 'Installed version does not match the requested update' }
  Save-Result 'installed' ''
  Start-Process -FilePath $config.executable -WorkingDirectory $config.directory
} catch {
  Save-Result 'failed' $_.Exception.Message
  if ((Test-Path -LiteralPath $config.ready) -and !(Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $config.executable)) {
    Start-Process -FilePath $config.executable -WorkingDirectory $config.directory
  }
}
`;

// Detached Windows PowerShell can exit successfully without executing its script.
// Start-Process creates an independent hidden process with a usable Windows console.
const windowsLauncher = String.raw`
param([string]$ConfigFile)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $config.helper + '"'), '-ConfigFile', ('"' + $ConfigFile + '"'))
$helper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
[Console]::Out.WriteLine($helper.Id)
`;

async function waitForWindowsHelper(file: string, pid: number, version: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      if (receipt.pid === pid && receipt.version === version) return;
    } catch {
      // A receipt may still be in flight; only a complete matching receipt authorizes exit.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('更新助手未就绪，已保留当前版本。请稍后重试。');
}

export function previousInstallError(directory: string, currentVersion: string) {
  try {
    const result = JSON.parse(
      readFileSync(path.join(directory, 'last-install-result.json'), 'utf8').replace(/^\uFEFF/, '')
    );
    if (
      result.status === 'failed' &&
      validateStrict(result.version) &&
      compareVersions(result.version, currentVersion) > 0
    )
      return '上次更新安装未完成，当前仍为旧版本。请重新检查更新；若重复失败，可重新运行安装包，聊天和配置会保留。';
  } catch {
    /* No previous attempt, or a truncated receipt after system shutdown. */
  }
  return undefined;
}

export async function prepareWindowsInstall(
  candidate: UpdateCandidate,
  file: string,
  directory: string
) {
  const executable = app.getPath('exe');
  const installDirectory = path.dirname(executable);
  // An unpacked/portable build has no Inno uninstall registration in its folder.
  const { access } = await import('node:fs/promises');
  await access(path.join(installDirectory, 'unins000.exe')).catch(() => {
    throw new Error('请先使用 CodeBuddy 安装包安装应用，再使用自动更新。');
  });
  if (/["\r\n]/.test(installDirectory)) throw new Error('安装目录格式不受支持。');
  const attempt = path.join(directory, randomBytes(12).toString('hex'));
  await mkdir(attempt, { recursive: true });
  const configFile = path.join(attempt, 'install.json');
  const ready = path.join(attempt, 'ready');
  const helper = path.join(attempt, 'install.ps1');
  const launcher = path.join(attempt, 'launch.ps1');
  const helperReady = path.join(attempt, 'helper-ready.json');
  const armed = path.join(attempt, 'armed.json');
  const cancel = path.join(attempt, 'cancel');
  await writeFile(helper, '\ufeff' + windowsHelper, 'utf8');
  await writeFile(launcher, '\ufeff' + windowsLauncher, 'utf8');
  await writeFile(
    configFile,
    JSON.stringify({
      version: candidate.version,
      installer: file,
      sha256: candidate.artifact.sha256,
      executable,
      directory: installDirectory,
      ready,
      helper,
      helperReady,
      armed,
      cancel,
      parentPid: process.pid,
      log: path.join(attempt, 'installer.log'),
      lastResult: path.join(directory, 'last-install-result.json'),
    })
  );
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  try {
    const { stdout } = await promisify(execFile)(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcher,
        '-ConfigFile',
        configFile,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4096,
        // PowerShell 7 module paths inherited through Electron break Windows PowerShell 5.1.
        // Limit this private helper to the modules shipped with its actual interpreter.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')
          ),
          PSModulePath: path.join(path.dirname(powershell), 'Modules'),
        },
      }
    );
    const pid = Number(stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('更新助手启动失败。');
    await waitForWindowsHelper(helperReady, pid, candidate.version);
    return {
      commit: async () => {
        await writeFile(ready, candidate.version);
        await waitForWindowsHelper(armed, pid, candidate.version);
      },
      cancel: () => writeFileSync(cancel, 'cancel'),
    };
  } catch {
    await writeFile(cancel, 'cancel');
    throw new Error('更新助手未就绪，已保留当前版本。请稍后重试。');
  }
}

export class MacUpdateInstaller {
  private server?: Server;
  private ready = false;
  async stage(candidate: UpdateCandidate, file: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.close();
    this.ready = false;
    const key = randomBytes(32).toString('hex');
    const server = createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.url === `/${key}/feed`) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            url: `${origin}/${key}/update.zip`,
            name: candidate.version,
            notes: candidate.notes,
          })
        );
      } else if (req.url === `/${key}/update.zip`) {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', candidate.artifact.size);
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本机更新服务启动失败。');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
          autoUpdater.off('error', failed);
          autoUpdater.off('update-downloaded', downloaded);
          autoUpdater.off('update-not-available', unavailable);
          if (error) reject(error);
          else resolve();
        };
        const failed = () => finish(new Error('Mac 更新准备失败，请检查应用签名及安装目录权限。'));
        const aborted = () => finish(new Error('已取消更新。'));
        const downloaded = () => {
          this.ready = true;
          finish();
        };
        const unavailable = () => finish(new Error('Mac 系统未接受该更新包。'));
        const timer = setTimeout(
          () => finish(new Error('Mac 更新准备超时，请重试。')),
          5 * 60 * 1000
        );
        autoUpdater.once('error', failed);
        autoUpdater.once('update-downloaded', downloaded);
        autoUpdater.once('update-not-available', unavailable);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) {
          aborted();
          return;
        }
        try {
          autoUpdater.setFeedURL({ url: `${origin}/${key}/feed` });
          autoUpdater.checkForUpdates();
        } catch {
          failed();
        }
      });
    } finally {
      this.close();
    }
  }
  async install() {
    if (!this.ready) throw new Error('Mac 更新尚未准备完成。');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        autoUpdater.off('error', failed);
        app.off('before-quit', quitting);
        if (error) reject(error);
        else resolve();
      };
      const failed = () => finish(new Error('Mac 更新启动失败，请重新打开应用后重试。'));
      const quitting = () => finish();
      const timer = setTimeout(
        () => finish(new Error('Mac 更新未启动，请重新打开应用后重试。')),
        30000
      );
      autoUpdater.once('error', failed);
      app.once('before-quit', quitting);
      try {
        autoUpdater.quitAndInstall();
      } catch {
        failed();
      }
    });
  }
  close() {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
  }
}
