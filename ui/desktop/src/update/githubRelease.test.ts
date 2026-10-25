import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GitHubReleaseSource, githubRequest, selectArtifact } from './githubRelease';

const bytes = Buffer.from('verified installer fixture');
const artifact = {
  platform: 'win32' as const,
  arch: 'x64' as const,
  name: 'CodeBuddy-1.44.0.exe',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const manifest = { schemaVersion: 1, version: '1.44.0', artifacts: [artifact] };
const release = {
  id: 4,
  tag_name: 'codebuddy-1.44.0',
  draft: false,
  prerelease: false,
  body: 'Release notes',
  assets: [
    { id: 5, name: 'codebuddy-update.json', size: 300, state: 'uploaded' },
    {
      id: 6,
      name: artifact.name,
      size: bytes.length,
      state: 'uploaded',
      digest: `sha256:${artifact.sha256}`,
    },
  ],
};
const signal = () => new AbortController().signal;
const json = (value: unknown) => new Response(JSON.stringify(value));
const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), 'codebuddy-update-test-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function source(
  options: { bytes?: Buffer; releases?: unknown[]; revoked?: boolean; login?: string } = {}
) {
  return new GitHubReleaseSource(
    async () => ({ login: options.login || 'colleague', token: 'private-fixture-token' }),
    async (url) => {
      if (url.endsWith('/user')) return json({ login: 'colleague' });
      if (url.includes('/releases?')) return json(options.releases || [release]);
      if (url.endsWith('/assets/5')) return json(manifest);
      if (url.endsWith('/releases/4'))
        return options.revoked ? new Response('', { status: 404 }) : json(release);
      if (url.endsWith('/assets/6')) return new Response(new Uint8Array(options.bytes || bytes));
      throw Error('Unexpected request');
    }
  );
}
describe('private GitHub update release contract', () => {
  it('selects a newer compatible release, ignores older versions, draft and preview channels', async () => {
    expect((await source().check('1.43.9', 'stable', 'win32', 'x64', signal()))?.version).toBe(
      '1.44.0'
    );
    expect(await source().check('1.44.0', 'stable', 'win32', 'x64', signal())).toBeUndefined();
    expect(
      await source({ releases: [{ ...release, draft: true }] }).check(
        '1.43.9',
        'preview',
        'win32',
        'x64',
        signal()
      )
    ).toBeUndefined();
    const preview = source({ releases: [{ ...release, prerelease: true }] });
    expect(await preview.check('1.43.9', 'stable', 'win32', 'x64', signal())).toBeUndefined();
    expect((await preview.check('1.43.9', 'preview', 'win32', 'x64', signal()))?.version).toBe(
      '1.44.0'
    );
  });
  it('rejects wrong platform, duplicate artifacts, traversal, digest and version mismatch', () => {
    expect(() => selectArtifact(manifest, release, 'darwin', 'arm64')).toThrow();
    expect(() =>
      selectArtifact({ ...manifest, artifacts: [artifact, artifact] }, release, 'win32', 'x64')
    ).toThrow();
    expect(() =>
      selectArtifact(
        { ...manifest, artifacts: [{ ...artifact, name: '../escape.exe' }] },
        release,
        'win32',
        'x64'
      )
    ).toThrow();
    expect(() =>
      selectArtifact(
        { ...manifest, artifacts: [{ ...artifact, sha256: 'a'.repeat(64) }] },
        release,
        'win32',
        'x64'
      )
    ).toThrow();
    expect(() =>
      selectArtifact(manifest, { ...release, tag_name: 'codebuddy-9.0.0' }, 'win32', 'x64')
    ).toThrow();
  });
  it('verifies actual downloaded bytes and removes partial files on corruption', async () => {
    const good = source();
    const selected = (await good.check('1.43.9', 'stable', 'win32', 'x64', signal()))!;
    const root = await directory();
    const progress = vi.fn();
    const file = await good.download(selected, root, signal(), progress);
    expect(await readFile(file)).toEqual(bytes);
    expect(progress).toHaveBeenLastCalledWith(100);
    await expect(
      source({ bytes: Buffer.from('broken') }).download(selected, root, signal(), progress)
    ).rejects.toThrow('校验失败');
    expect(await readdir(root)).toEqual([artifact.name]);
    expect(await readFile(file)).toEqual(bytes);
  });
  it('rechecks account and release authorization before downloading', async () => {
    const selected = (await source().check('1.43.9', 'stable', 'win32', 'x64', signal()))!;
    await expect(
      source({ login: 'other' }).download(selected, await directory(), signal(), vi.fn())
    ).rejects.toThrow('账号已改变');
    await expect(
      source({ revoked: true }).download(selected, await directory(), signal(), vi.fn())
    ).rejects.toThrow('读取权限');
  });
  it('strips credentials on CDN redirects and rejects untrusted hosts', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/file?signature=fixture',
          },
        })
      )
      .mockResolvedValueOnce(new Response('file'));
    vi.stubGlobal('fetch', request);
    await githubRequest(
      'https://api.github.com/repos/erjinyi-bool/CodeBuddy-v1/releases/assets/1',
      'secret',
      signal(),
      true
    );
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    expect(request.mock.calls[1][1].headers).toBeUndefined();
    request.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } })
    );
    await expect(
      githubRequest('https://api.github.com/test', 'secret', signal(), true)
    ).rejects.toThrow('destination');
    expect(request).toHaveBeenCalledTimes(3);
  });
});
