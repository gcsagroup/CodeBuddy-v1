// Main-process only. Opening stays dormant until storage and window services are ready.
export class FileOpenQueue {
  private pending: string[] = [];
  private started = false;
  private tail: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private opened = false;

  constructor(
    private readonly openFile: (filePath: string) => Promise<boolean>,
    private readonly onError: (error: unknown) => void
  ) {}

  get hasPending(): boolean {
    return this.pending.length > 0 || this.inFlight > 0;
  }

  enqueue(filePath: string): void {
    if (!this.started) {
      this.pending.push(filePath);
      return;
    }
    this.inFlight += 1;
    this.tail = this.tail.then(async () => {
      try {
        this.opened = (await this.openFile(filePath)) || this.opened;
      } catch (error) {
        this.onError(error);
      } finally {
        this.inFlight -= 1;
      }
    });
  }

  async start(): Promise<boolean> {
    this.started = true;
    for (const filePath of this.pending.splice(0)) this.enqueue(filePath);
    // Include events delivered while an earlier startup window is still opening.
    let observed;
    do {
      observed = this.tail;
      await observed;
    } while (observed !== this.tail);
    return this.opened;
  }
}
