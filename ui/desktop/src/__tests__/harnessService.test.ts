import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn, default: { spawn: mock.spawn } }));
import { startHarnessService } from '../harnessService';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('packaged Harness service', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-service-')); roots.push(root);
    const stage = path.join(root, 'harness-distribution'); fs.mkdirSync(stage);
    fs.mkdirSync(path.join(stage, 'node'));
    fs.writeFileSync(path.join(stage, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture-node');
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ engine: 'deepseek-harness', schemaVersion: 1, sourceDigest: 'fixture' }));
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      connected: true,
      send: vi.fn(() => void Promise.resolve().then(() => child.emit('exit', 0))), kill: vi.fn(),
    });
    mock.spawn.mockImplementation(() => { void Promise.resolve().then(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:4567', pid: 123, engine: 'deepseek-harness' })); return child; });
    return { root, stage, child, options: { resourcesPath: root, home: path.join(root, 'data'), workspace: path.join(root, 'workspace'), onUnexpectedExit: vi.fn() } };
  }
  it('launches packaged entry with isolated profile, reports no credential, and awaits owned shutdown', async () => {
    const f = fixture(); const service = await startHarnessService(f.options);
    expect(mock.spawn.mock.calls[0][0]).toBe(path.join(f.stage, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
    expect(mock.spawn.mock.calls[0][1]).toEqual([path.join(f.stage, 'runtime/desktop-entry.mjs')]);
    expect(mock.spawn.mock.calls[0][2].env.CODEBUDDY_HOME).toBe(f.options.home);
    expect(mock.spawn.mock.calls[0][2].windowsHide).toBe(true);
    expect(service.secret).toHaveLength(64);
    expect(fs.readFileSync(path.join(f.options.home, 'logs/harness/launch.json'), 'utf8')).not.toContain(service.secret);
    await Promise.all([service.close(), service.close()]);
    expect(f.child.send).toHaveBeenCalledTimes(1);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.options.onUnexpectedExit).not.toHaveBeenCalled();
  });
  it('fails closed on absent runtime and reports unexpected service exit', async () => {
    const f = fixture(); const service = await startHarnessService(f.options);
    f.child.emit('exit', 1); expect(f.options.onUnexpectedExit).toHaveBeenCalledTimes(1);
    await service.close();
    fs.unlinkSync(path.join(f.stage, 'manifest.json'));
    await expect(startHarnessService(f.options)).rejects.toThrow();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
  });
  it('anchors merged Windows app-container directories to the physical manifest file', async () => {
    const f = fixture();
    const alias = path.join(f.root, 'logical-resources');
    const native = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((value, options) => {
      if (String(value) === path.join(alias, 'harness-distribution')) return String(value);
      if (String(value) === path.join(alias, 'harness-distribution/manifest.json')) return path.join(f.stage, 'manifest.json');
      return native(value, options);
    });
    const service = await startHarnessService({ ...f.options, resourcesPath: alias });
    expect(mock.spawn.mock.calls[0][0]).toBe(path.join(f.stage, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
    expect(mock.spawn.mock.calls[0][1]).toEqual([path.join(f.stage, 'runtime/desktop-entry.mjs')]);
    await service.close();
  });
});
