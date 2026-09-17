export interface SaveDocument {
  readonly isDirty: boolean;
  readonly isClosed: boolean;
  save(): PromiseLike<boolean>;
}

/** Scoped to review documents. All saves and branch checkout share one queue. */
export class ReviewSaves<T extends SaveDocument> {
  private documents = new Map<T, string>();
  private timers = new Map<T, ReturnType<typeof setTimeout>>();
  private tail: Promise<unknown> = Promise.resolve();
  private failed = new Set<T>();
  enabled = true;
  paused = false;
  constructor(
    private readonly current: () => Promise<string>,
    private readonly allowed: (doc: T) => Promise<void>,
    private readonly state: (message: string, error?: Error) => void,
    private readonly delay = 1000,
  ) {}

  track(doc: T, session: string): void { this.documents.set(doc, session); }
  untrack(doc: T): void {
    this.cancel(doc);
    this.documents.delete(doc);
    this.failed.delete(doc);
  }
  private cancel(doc: T): void { clearTimeout(this.timers.get(doc)); this.timers.delete(doc); }
  exclusive<R>(action: () => Promise<R>): Promise<R> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  changed(doc: T): void {
    if (!this.documents.has(doc)) { return; }
    if (!doc.isDirty) {
      this.cancel(doc); this.failed.delete(doc);
      this.state(this.failed.size ? 'Save failed — click to retry' : [...this.documents.keys()].some(item => item.isDirty) ? 'Unsaved changes' : 'Saved');
      return;
    }
    if (!this.enabled || this.paused) { return; }
    this.cancel(doc);
    this.state(this.failed.size ? 'Save failed — click to retry' : 'Unsaved changes');
    this.timers.set(doc, setTimeout(() => {
      this.timers.delete(doc);
      void this.exclusive(async () => {
        if (this.enabled && !this.paused) { await this.save(doc); }
      }).catch(() => undefined);
    }, this.delay));
  }
  private async save(doc: T): Promise<void> {
    const expected = this.documents.get(doc);
    if (!expected || doc.isClosed) { return; }
    if (!doc.isDirty) { this.changed(doc); return; }
    try {
      if (expected !== await this.current() || this.documents.get(doc) !== expected) {
        throw new Error('The branch changed. Your unsaved text was preserved; reopen the review before saving.');
      }
      await this.allowed(doc);
      if (this.documents.get(doc) !== expected) { return; }
      this.state('Saving…');
      if (!await doc.save()) { throw new Error('VS Code could not save the file. Your edits are still in the editor.'); }
      this.failed.delete(doc);
      this.state(this.failed.size ? 'Save failed — click to retry' : [...this.documents.keys()].some(item => item.isDirty && !item.isClosed) ? 'Unsaved changes' : 'Saved');
      if (doc.isDirty) { this.changed(doc); }
    } catch (cause) {
      this.failed.add(doc);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.state('Save failed — click to retry', error);
      throw error;
    }
  }
  async flush(): Promise<void> {
    for (const doc of this.documents.keys()) { this.cancel(doc); }
    await this.exclusive(async () => {
      for (const doc of this.documents.keys()) { await this.save(doc); }
    });
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const doc of this.documents.keys()) {
      this.cancel(doc);
      if (enabled) { this.changed(doc); }
    }
  }
  clear(): void {
    for (const doc of this.documents.keys()) { this.cancel(doc); }
    this.documents.clear();
    this.failed.clear();
  }
  dispose(): void { this.clear(); }
}
