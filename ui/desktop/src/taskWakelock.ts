import type { PowerSaveBlocker } from 'electron';

export class TaskWakelock {
  private enabled = false;
  private working = false;
  private id?: number;

  constructor(private readonly blocker: Pick<PowerSaveBlocker, 'start' | 'stop'>) {}

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.sync();
  }

  setWorking(working: boolean) {
    this.working = working;
    this.sync();
  }

  private sync() {
    if (this.enabled && this.working) {
      this.id ??= this.blocker.start('prevent-app-suspension');
    } else if (this.id !== undefined) {
      this.blocker.stop(this.id);
      this.id = undefined;
    }
  }
}
