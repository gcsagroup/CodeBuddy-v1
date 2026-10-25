import { expect, it, vi } from 'vitest';
import { UpdateController } from './controller';
import { GitHubReleaseSource, type UpdateCandidate } from './githubRelease';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

it('serializes checks/downloads, blocks installation on tampering and retains a download for busy-task retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-controller-'));
  const file = path.join(root, 'fixture.exe');
  const data = Buffer.from('installer');
  const candidate: UpdateCandidate = {
    version: '1.43.11',
    tag: 'codebuddy-1.43.11',
    releaseId: 1,
    assetId: 2,
    login: 'tester',
    notes: 'Fix',
    artifact: {
      name: 'fixture.exe',
      platform: 'win32',
      arch: 'x64',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
  };
  let resolveCheck!: (value: UpdateCandidate) => void;
  const checkPromise = new Promise<UpdateCandidate>((resolve) => {
    resolveCheck = resolve;
  });
  const source = new GitHubReleaseSource(async () => ({ login: 'tester', token: 'fixture' }));
  vi.spyOn(source, 'check').mockReturnValue(checkPromise);
  vi.spyOn(source, 'download').mockImplementation(async () => {
    await writeFile(file, data);
    return file;
  });
  const install = vi
    .fn()
    .mockRejectedValueOnce(new Error('task active'))
    .mockResolvedValue(undefined);
  const controller = new UpdateController({
    version: '1.43.10',
    platform: 'win32',
    arch: 'x64',
    directory: root,
    source,
    emit: vi.fn(),
    install,
  });
  try {
    expect(controller.state.channel).toBe('preview');
    const pending = controller.check(controller.state.channel);
    await controller.check('stable');
    expect(source.check).toHaveBeenCalledOnce();
    expect(source.check).toHaveBeenCalledWith('1.43.10', 'preview', 'win32', 'x64', expect.anything());
    resolveCheck(candidate);
    await pending;
    expect(controller.state.phase).toBe('available');
    expect(source.download).not.toHaveBeenCalled();
    await controller.download();
    expect(controller.state.phase).toBe('ready');
    await controller.install();
    expect(controller.state).toMatchObject({ phase: 'ready', error: 'task active' });
    await writeFile(file, Buffer.from('tampered!'));
    await controller.install();
    expect(install).toHaveBeenCalledOnce();
    await writeFile(file, data);
    await controller.install();
    expect(install).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
