import { GitHubReleaseSource, verifyUpdateFile, type UpdateCandidate } from './githubRelease';
import type { UpdateChannel, UpdateState } from './types';

export class UpdateController {
  state: UpdateState;
  private candidate?: UpdateCandidate;
  private file?: string;
  private operation?: AbortController;
  constructor(
    private options: {
      version: string;
      platform: string;
      arch: string;
      directory: string;
      initialError?: string;
      source: GitHubReleaseSource;
      emit: (state: UpdateState) => void;
      install: (candidate: UpdateCandidate, file: string) => Promise<void>;
    }
  ) {
    this.state = {
      phase: options.initialError ? 'error' : 'idle',
      currentVersion: options.version,
      channel: 'preview',
      error: options.initialError,
    };
  }
  private publish(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.options.emit(this.state);
  }
  async check(channel: UpdateChannel) {
    if (this.operation || this.state.phase === 'installing') return;
    if (channel !== 'stable' && channel !== 'preview') throw new Error('Invalid update channel');
    this.candidate = undefined;
    this.file = undefined;
    const operation = new AbortController();
    this.operation = operation;
    this.publish({
      phase: 'checking',
      channel,
      error: undefined,
      version: undefined,
      notes: undefined,
      percent: undefined,
    });
    try {
      this.candidate = await this.options.source.check(
        this.options.version,
        channel,
        this.options.platform,
        this.options.arch,
        globalThis.AbortSignal.any([operation.signal, globalThis.AbortSignal.timeout(90000)])
      );
      this.publish({
        phase: this.candidate ? 'available' : 'idle',
        version: this.candidate?.version,
        notes: this.candidate?.notes,
      });
    } catch (error) {
      this.failed(error);
    } finally {
      this.operation = undefined;
    }
  }
  async download() {
    if (this.operation || !this.candidate || this.state.phase === 'installing') return;
    const operation = new AbortController();
    this.operation = operation;
    this.publish({ phase: 'downloading', percent: 0, error: undefined });
    try {
      const file = await this.options.source.download(
        this.candidate,
        this.options.directory,
        globalThis.AbortSignal.any([
          operation.signal,
          globalThis.AbortSignal.timeout(60 * 60 * 1000),
        ]),
        (percent) => this.publish({ percent })
      );
      await verifyUpdateFile(file, this.candidate.artifact);
      operation.signal.throwIfAborted();
      this.file = file;
      this.publish({ phase: 'ready', percent: 100 });
    } catch (error) {
      this.file = undefined;
      this.failed(error);
    } finally {
      this.operation = undefined;
    }
  }
  cancel() {
    this.operation?.abort();
  }
  async install() {
    if (this.operation || this.state.phase !== 'ready' || !this.candidate || !this.file) return;
    this.publish({ phase: 'installing', error: undefined });
    try {
      await verifyUpdateFile(this.file, this.candidate.artifact);
      await this.options.install(this.candidate, this.file);
    } catch (error) {
      // A busy task or a declined dialog does not discard an already verified download.
      this.publish({
        phase: 'ready',
        error: error instanceof Error ? error.message : '更新安装失败。',
      });
    }
  }
  private failed(error: unknown) {
    this.publish({
      phase: 'error',
      error: this.operation?.signal.aborted
        ? '已取消更新。'
        : error instanceof Error && !(error.name === 'ZodError' || error.name === 'TypeError')
          ? error.message
          : '更新请求失败，请检查网络和发布文件后重试。',
    });
  }
}
