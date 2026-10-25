import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, validateStrict } from 'compare-versions';
import { z } from 'zod';
import type { UpdateArtifact, UpdateChannel } from './types';

export const UPDATE_REPOSITORY = 'erjinyi-bool/CodeBuddy-v1';
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const assetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  state: z.string(),
  digest: z.string().nullable().optional(),
});
const releaseSchema = z.object({
  id: z.number().int().positive(),
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable(),
  assets: z.array(assetSchema),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().refine(validateStrict),
  artifacts: z
    .array(
      z.object({
        platform: z.enum(['win32', 'darwin']),
        arch: z.enum(['x64', 'arm64']),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/),
        size: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 ** 3),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
    )
    .min(1)
    .max(4),
});
type Release = z.infer<typeof releaseSchema>;
export type UpdateCandidate = {
  releaseId: number;
  tag: string;
  version: string;
  notes: string;
  artifact: UpdateArtifact;
  assetId: number;
  login: string;
};
export type GitHubCredential = { login: string; token: string };

// Credentials only accompany fixed GitHub API requests. Redirected asset URLs
// receive no Authorization header and are never persisted or sent to the UI.
export async function githubRequest(
  url: string,
  token: string,
  signal: AbortSignal,
  binary = false
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.github.com') throw new Error('Invalid update API');
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    },
    redirect: 'manual',
    signal,
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && binary) {
    const destination = new URL(response.headers.get('location') || '');
    if (
      destination.protocol !== 'https:' ||
      destination.username ||
      destination.password ||
      !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
        destination.hostname
      )
    )
      throw new Error('Invalid update download destination');
    return fetch(destination, { signal, redirect: 'error' });
  }
  return response;
}

function assertResponse(response: Response) {
  if (response.status === 401) throw new Error('GitHub 登录已过期，请在“账号与凭据”重新连接。');
  if (response.status === 403 || response.status === 404)
    throw new Error('当前 GitHub 账号没有更新仓库的读取权限，或请求受到限制。');
  if (!response.ok) throw new Error(`更新服务器请求失败（HTTP ${response.status}），请稍后重试。`);
}
async function limitedJson(response: Response) {
  assertResponse(response);
  if (!response.body) throw new Error('更新响应为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 ** 2) throw new Error('更新信息超过允许的大小。');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

export function selectArtifact(input: unknown, release: Release, platform: string, arch: string) {
  const manifest = manifestSchema.parse(input);
  if (
    release.tag_name !== `codebuddy-${manifest.version}` &&
    !release.tag_name.startsWith(`codebuddy-${manifest.version}-`)
  )
    throw new Error('更新版本与发布标签不一致。');
  const matches = manifest.artifacts.filter((a) => a.platform === platform && a.arch === arch);
  if (matches.length !== 1) throw new Error('该版本没有匹配当前系统与芯片的更新包。');
  const artifact = matches[0];
  if (!artifact.name.endsWith(platform === 'win32' ? '.exe' : '.zip'))
    throw new Error('更新包格式错误。');
  const assets = release.assets.filter((a) => a.name === artifact.name);
  if (
    assets.length !== 1 ||
    assets[0].state !== 'uploaded' ||
    assets[0].size !== artifact.size ||
    (assets[0].digest && assets[0].digest !== `sha256:${artifact.sha256}`)
  )
    throw new Error('更新文件与发布清单不一致。');
  return { version: manifest.version, artifact, assetId: assets[0].id };
}

export class GitHubReleaseSource {
  constructor(
    private credential: () => Promise<GitHubCredential>,
    private request = githubRequest
  ) {}
  private async account(signal: AbortSignal, expected?: string) {
    const credential = await this.credential();
    const user = await limitedJson(
      await this.request('https://api.github.com/user', credential.token, signal)
    );
    if (user.login !== credential.login || (expected && credential.login !== expected))
      throw new Error('GitHub 账号已改变，请重新检查更新。');
    return credential;
  }
  async check(
    current: string,
    channel: UpdateChannel,
    platform: string,
    arch: string,
    signal: AbortSignal
  ): Promise<UpdateCandidate | undefined> {
    if (!validateStrict(current)) throw new Error('当前应用版本不支持自动更新。');
    const { login, token } = await this.account(signal);
    const candidates: UpdateCandidate[] = [];
    for (let page = 1; page <= 10; page++) {
      const releases = z
        .array(releaseSchema)
        .parse(
          await limitedJson(
            await this.request(`${API}/releases?per_page=100&page=${page}`, token, signal)
          )
        );
      for (const release of releases) {
        if (
          release.draft ||
          (channel === 'stable' && release.prerelease) ||
          !release.tag_name.startsWith('codebuddy-')
        )
          continue;
        const manifests = release.assets.filter((a) => a.name === 'codebuddy-update.json');
        if (!manifests.length) continue; // Legacy releases require a one-time manual installation.
        if (
          manifests.length !== 1 ||
          manifests[0].state !== 'uploaded' ||
          manifests[0].size > 64 * 1024
        )
          throw new Error('更新清单无效。');
        const manifest = await limitedJson(
          await this.request(`${API}/releases/assets/${manifests[0].id}`, token, signal, true)
        );
        const version = manifestSchema.parse(manifest).version;
        if (
          compareVersions(version, current) <= 0 ||
          (channel === 'stable' && version.includes('-'))
        )
          continue;
        const selected = selectArtifact(manifest, release, platform, arch);
        candidates.push({
          ...selected,
          releaseId: release.id,
          tag: release.tag_name,
          notes: release.body || '',
          login,
        });
      }
      if (releases.length < 100) break;
      if (page === 10) throw new Error('发布记录过多，请联系发布者整理更新频道。');
    }
    return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
  }
  async download(
    candidate: UpdateCandidate,
    directory: string,
    signal: AbortSignal,
    progress: (percent: number) => void
  ) {
    const { token } = await this.account(signal, candidate.login);
    const release = releaseSchema.parse(
      await limitedJson(await this.request(`${API}/releases/${candidate.releaseId}`, token, signal))
    );
    const published = release.assets.find((a) => a.id === candidate.assetId);
    if (
      release.draft ||
      release.tag_name !== candidate.tag ||
      !published ||
      published.state !== 'uploaded' ||
      published.name !== candidate.artifact.name ||
      published.size !== candidate.artifact.size
    )
      throw new Error('该更新已被撤回或替换，请重新检查更新。');
    const response = await this.request(
      `${API}/releases/assets/${candidate.assetId}`,
      token,
      signal,
      true
    );
    assertResponse(response);
    if (!response.body) throw new Error('更新文件为空。');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, candidate.artifact.name);
    const temporary = `${file}.partial`;
    let received = 0;
    const hash = createHash('sha256');
    try {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > candidate.artifact.size) return callback(new Error('更新文件大小不符。'));
          hash.update(chunk);
          progress(Math.floor((received / candidate.artifact.size) * 100));
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(temporary, { mode: 0o600 }),
        { signal }
      );
      if (received !== candidate.artifact.size || hash.digest('hex') !== candidate.artifact.sha256)
        throw new Error('更新文件校验失败，请重新下载。');
      await rename(temporary, file);
      return file;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function verifyUpdateFile(file: string, artifact: UpdateArtifact) {
  if ((await stat(file)).size !== artifact.size) throw new Error('更新缓存已改变，请重新下载。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== artifact.sha256) throw new Error('更新缓存校验失败，请重新下载。');
}
