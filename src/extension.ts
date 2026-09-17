import * as vscode from 'vscode';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Git, Change, Comparison, Branch, MAX_FILE_BYTES, identity, inside, safeFile } from './git';
import { ReviewSaves } from './saving';
import type { API, GitExtension, Repository } from './vscode-git';

type Item = { label: string; command?: string; description?: string; children?: Item[]; change?: Change; icon?: string };
type Snapshot = { git: Git; id?: string; file: string; text?: string };
const SCHEME = 'generated-diffs';
const shortRef = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '');
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isBinary = (data: Buffer): boolean => data.subarray(0, 8192).includes(0)
  && !(data[0] === 0xff && data[1] === 0xfe || data[0] === 0xfe && data[1] === 0xff);

export class Review implements vscode.TreeDataProvider<Item>, vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly tree: vscode.TreeView<Item>;
  readonly status: vscode.StatusBarItem;
  readonly saves: ReviewSaves<vscode.TextDocument>;
  repository?: Repository;
  git?: Git;
  comparison?: Comparison;
  message = 'Choose a project to review its branch.';
  includeLocal = true;
  private session = 0;
  private generation = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private knownIdentity?: string;
  private snapshots = new Map<string, Snapshot>();
  private reviewTabs = new Set<vscode.Tab>();
  private reviewDocs = new Map<string, vscode.TextDocument>();
  private subscriptions: vscode.Disposable[] = [];
  private repositorySubscription?: vscode.Disposable;
  private busy = false;
  private savingState = 'Auto-save on';
  private lastSaveError?: string;

  constructor(readonly api: API, private readonly context: vscode.ExtensionContext) {
    this.tree = vscode.window.createTreeView('generatedDiffs', { treeDataProvider: this, showCollapseAll: true });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'generatedDiffs.retrySave';
    this.saves = new ReviewSaves(
      async () => {
        if (!this.git) { throw new Error('No repository is selected.'); }
        return `${this.session}:${this.git.root}:${identity(await this.git.head())}`;
      },
      async doc => {
        if (!this.git || !vscode.workspace.isTrusted) { throw new Error('A trusted project is required to save.'); }
        await safeFile(this.git.root, path.relative(this.git.root, doc.uri.fsPath));
        if (doc.isClosed) { throw new Error('The document was closed before saving.'); }
      },
      (message, error) => {
        this.savingState = message;
        this.updateStatus();
        if (error && error.message !== this.lastSaveError) {
          this.lastSaveError = error.message;
          void vscode.window.showErrorMessage(`Generated Diffs: ${error.message}`, 'Retry').then(choice => {
            if (choice) { void this.retrySave(); }
          });
        }
      },
    );
    this.saves.enabled = context.workspaceState.get('generatedDiffs.autoSave', true);
    this.includeLocal = context.workspaceState.get('generatedDiffs.includeLocal', true);
    this.subscriptions.push(this.tree, this.status, this.changed, this.saves,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.workspace.onDidChangeTextDocument(event => {
        // VS Code may mark the buffer dirty in a separate event with no contentChanges.
        if (this.belongs(event.document)) {
          if (this.reviewDocs.has(event.document.uri.toString())) {
            this.reviewDocs.set(event.document.uri.toString(), event.document);
            this.saves.track(event.document, this.token());
          }
          this.saves.changed(event.document);
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(doc => { if (this.belongs(doc)) { this.saves.changed(doc); this.scheduleRefresh(); } }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        // Multi-file editors can unload a document and reopen it on scroll. Keep its session membership.
        this.saves.untrack(doc);
      }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.scheduleRefresh(); } }),
      this.tree.onDidChangeVisibility(event => { if (event.visible) { this.scheduleRefresh(); } }),
      vscode.window.tabGroups.onDidChangeTabs(event => {
        const closedReview = event.closed.some(tab => this.reviewTabs.has(tab));
        for (const tab of event.closed) { this.reviewTabs.delete(tab); }
        this.rememberTabs();
        if (closedReview && !this.reviewTabs.size) { this.saves.clear(); this.reviewDocs.clear(); }
      }),
      api.onDidOpenRepository(() => {
        if (!this.repository) { void this.selectRepository(api.repositories[0]); }
        this.changed.fire(undefined);
      }),
      api.onDidCloseRepository(repo => {
        if (repo === this.repository) { void this.selectRepository(api.repositories[0]); }
      }),
    );
  }

  private belongs(doc: vscode.TextDocument): boolean {
    return !!this.git && doc.uri.scheme === 'file' && inside(this.git.root, doc.uri.fsPath)
      && this.api.getRepository(doc.uri)?.rootUri.toString() === this.repository?.rootUri.toString();
  }
  private baseKey(): string { return `generatedDiffs.base:${this.git?.root}:${this.knownIdentity}`; }
  private token(): string { return `${this.session}:${this.git?.root}:${this.knownIdentity}`; }

  private updateStatus(): void {
    this.status.text = `$(diff) ${!this.includeLocal ? 'Committed only' : !this.saves.enabled ? 'Auto-save off' : this.savingState}`;
    this.status.tooltip = 'Generated Diffs: saves apply only to files opened in this review. Click to retry pending saves.';
    if (this.repository) { this.status.show(); } else { this.status.hide(); }
    this.changed.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.label, item.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    treeItem.description = item.description;
    if (item.change) {
      treeItem.resourceUri = vscode.Uri.file(path.join(this.git!.root, item.change.path));
      treeItem.tooltip = `${item.change.kind}: ${item.change.oldPath === item.change.path ? item.change.path : `${item.change.oldPath} → ${item.change.path}`}`;
      treeItem.command = { command: 'generatedDiffs.openFile', title: 'Open Diff', arguments: [item.change] };
      treeItem.iconPath = new vscode.ThemeIcon(item.change.kind === 'Conflict' ? 'warning' : 'file');
    } else if (item.command) {
      treeItem.command = { command: item.command, title: item.label };
      treeItem.iconPath = new vscode.ThemeIcon(item.icon ?? 'chevron-down');
    } else if (item.children) { treeItem.iconPath = new vscode.ThemeIcon('folder'); }
    return treeItem;
  }

  getChildren(item?: Item): Item[] {
    if (item) { return item.children ?? []; }
    const controls: Item[] = [
      { label: `Project: ${this.git ? path.basename(this.git.root) : 'Choose project'} ▾`, description: this.git?.root, command: 'generatedDiffs.chooseProject', icon: 'repo' },
      { label: `Branch: ${this.comparison?.head.name ?? this.knownIdentity ?? 'Choose branch'} ▾`, command: 'generatedDiffs.chooseBranch', icon: 'git-branch' },
      { label: `Base: ${this.comparison ? shortRef(this.comparison.baseRef) : 'main'} (branch point) ▾`, description: this.comparison?.ancestor.slice(0, 8), command: 'generatedDiffs.chooseBase' },
      { label: this.includeLocal ? 'Committed + local edits' : 'Committed only · read-only', command: 'generatedDiffs.toggleLocal', icon: 'diff' },
      { label: `Auto-save: ${this.saves.enabled ? 'on' : 'off'}`, description: this.includeLocal ? this.savingState : 'Inactive in committed-only view', command: 'generatedDiffs.toggleAutoSave', icon: 'save' },
    ];
    if (this.message) { return [...controls, { label: this.message }]; }
    const files: Item[] = [];
    const folders = new Map<string, Item>();
    for (const change of this.comparison?.changes ?? []) {
      const parts = change.path.split('/');
      let siblings = files;
      let prefix = '';
      for (const part of parts.slice(0, -1)) {
        prefix += `${part}/`;
        let folder = folders.get(prefix);
        if (!folder) { folder = { label: part, children: [] }; folders.set(prefix, folder); siblings.push(folder); }
        siblings = folder.children!;
      }
      siblings.push({ label: parts.at(-1)!, description: change.kind, change });
    }
    return [...controls, ...(files.length ? files : [{ label: 'No changes against this branch point.' }])];
  }

  async selectRepository(repository?: Repository): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    try {
      if (!await this.closeReview(false)) { return; }
      this.repositorySubscription?.dispose();
      this.repository = repository;
      this.git = repository ? new Git(repository.rootUri.fsPath, this.api.git.path) : undefined;
      this.knownIdentity = undefined;
      if (repository) {
        this.repositorySubscription = repository.state.onDidChange(() => this.scheduleRefresh());
        await this.context.workspaceState.update('generatedDiffs.project', repository.rootUri.toString());
      }
    } finally { this.busy = false; }
    await this.refresh();
  }

  async chooseProject(): Promise<void> {
    const options = this.api.repositories.filter(repo => !repo.isUsingVirtualFileSystem).map(repository => ({
      label: path.basename(repository.rootUri.fsPath), description: repository.rootUri.fsPath, repository,
    }));
    if (!options.length) { void vscode.window.showInformationMessage('Open a folder containing a Git repository first.'); return; }
    const selected = await vscode.window.showQuickPick(options, { title: 'Generated Diffs — choose project', matchOnDescription: true });
    if (selected) { await this.selectRepository(selected.repository); }
  }

  async chooseBranch(): Promise<void> {
    if (!this.git) { await this.chooseProject(); }
    if (!this.git || this.busy) { return; }
    const git = this.git;
    const [branches, worktrees] = await Promise.all([git.branches(), git.worktrees()]);
    const selected = await vscode.window.showQuickPick(branches.map(branch => ({
      label: branch.name,
      description: branch.remote ? 'Remote branch' : branch.name === this.knownIdentity ? 'Checked out' : 'Local branch',
      detail: worktrees.find(tree => tree.branch === branch.name && tree.path !== git.root)?.path,
      branch,
    })), { title: `Check out a branch in ${path.basename(git.root)}`, matchOnDescription: true });
    if (selected && this.git === git) { await this.checkout(selected.branch); }
  }

  async checkout(branch: Branch): Promise<void> {
    if (!this.repository || !this.git || this.busy) { return; }
    this.busy = true;
    const git = this.git;
    const repo = this.repository;
    this.saves.paused = true;
    try {
      const available = await git.branches();
      if (!available.some(candidate => candidate.ref === branch.ref)) { throw new Error('This branch no longer exists.'); }
      const target = branch.remote ? branch.name.slice(branch.remote.length + 1) : branch.name;
      const existing = available.find(candidate => !candidate.remote && candidate.name === target);
      if (branch.remote && existing) {
        const upstream = (await repo.getBranch(target)).upstream;
        if (!upstream || `${upstream.remote}/${upstream.name}` !== branch.name) {
          throw new Error(`Local branch ${target} already exists with a different upstream. Select it explicitly from the dropdown.`);
        }
      }
      const actualRoot = await realpath(git.root);
      const other = (await git.worktrees()).find(tree => tree.branch === target && path.resolve(tree.path) !== actualRoot);
      if (other) {
        const choice = await vscode.window.showInformationMessage(`${target} is already checked out in ${other.path}.`, 'Open Worktree');
        if (choice) { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(other.path), { forceNewWindow: true }); }
        return;
      }
      if ((await git.head()).name === target) { return; }
      await this.saves.flush();
      if (vscode.workspace.textDocuments.some(doc => this.belongs(doc) && doc.isDirty) || !await git.isClean()) {
        void vscode.window.showWarningMessage('Commit or stash the current project’s changes before switching branches. Your current branch and edits have been kept.', 'Open Source Control').then(choice => {
          if (choice) { void vscode.commands.executeCommand('workbench.view.scm'); }
        });
        return;
      }
      if (!await this.closeReview(false)) { return; }
      await this.saves.exclusive(async () => {
        // Recheck after closing editors, immediately before checkout.
        if (vscode.workspace.textDocuments.some(doc => this.belongs(doc) && doc.isDirty) || !await git.isClean()) {
          throw new Error('The project changed before checkout. Save and commit or stash those changes first.');
        }
        if (branch.remote && !existing) {
          await repo.createBranch(target, true, branch.ref);
          await repo.setBranchUpstream(target, branch.name);
        } else { await repo.checkout(target); }
        const after = await git.head();
        if (after.name !== target) { throw new Error('Checkout did not select the expected branch. Refresh before editing.'); }
      });
      await repo.status();
    } finally {
      this.saves.paused = false;
      this.saves.setEnabled(this.saves.enabled);
      this.busy = false;
      await this.refresh();
    }
  }

  async chooseBase(): Promise<void> {
    if (!this.git || this.busy) { return; }
    const git = this.git;
    const options = (await git.branches()).map(branch => ({ label: branch.name, branch }));
    const selected = await vscode.window.showQuickPick(options, { title: 'Choose the comparison base (its common ancestor with your branch)' });
    if (selected && this.git === git && await this.closeReview(false)) {
      await this.context.workspaceState.update(this.baseKey(), selected.branch.ref);
      await this.refresh();
    }
  }

  async toggleLocal(): Promise<void> {
    if (this.busy || !await this.closeReview(false)) { return; }
    this.includeLocal = !this.includeLocal;
    await this.context.workspaceState.update('generatedDiffs.includeLocal', this.includeLocal);
    await this.refresh();
  }
  async toggleAutoSave(): Promise<void> {
    this.saves.setEnabled(!this.saves.enabled);
    this.savingState = this.saves.enabled ? 'Auto-save on' : 'Auto-save off';
    await this.context.workspaceState.update('generatedDiffs.autoSave', this.saves.enabled);
    this.updateStatus();
  }
  async retrySave(): Promise<void> {
    this.lastSaveError = undefined;
    try { await this.saves.flush(); } catch { /* The save coordinator already reports and retains the error. */ }
  }

  private scheduleRefresh(): void {
    this.generation++;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.refresh(); }, 250);
  }
  async refresh(): Promise<void> {
    if (this.busy) { return; }
    clearTimeout(this.refreshTimer);
    const version = ++this.generation;
    const git = this.git;
    if (!git) { this.message = 'Choose a project to review its branch.'; this.updateStatus(); return; }
    try {
      const head = await git.head();
      if (version !== this.generation) { return; }
      const next = identity(head);
      if (this.knownIdentity && next !== this.knownIdentity) {
        const hadDirty = [...this.reviewDocs.values()].some(doc => doc.isDirty);
        await this.closeReview(true);
        if (hadDirty) { void vscode.window.showWarningMessage('The checked-out branch changed outside Generated Diffs. Review auto-save stopped; your unsaved buffers are preserved. Reopen the review before editing further.'); }
      }
      this.knownIdentity = next;
      const base = await git.resolveBase(this.context.workspaceState.get<string>(this.baseKey()));
      const dirty = new Map(vscode.workspace.textDocuments.filter(doc => this.belongs(doc) && doc.isDirty).map(doc => [path.relative(git.root, doc.uri.fsPath).split(path.sep).join('/'), doc.getText()]));
      const comparison = await git.compare(base, this.includeLocal, dirty, (bytes, file) => Promise.resolve(vscode.workspace.decode(bytes, { uri: vscode.Uri.file(path.join(git.root, file)) })));
      if (version !== this.generation || git !== this.git) { return; }
      this.comparison = comparison;
      this.message = '';
      this.tree.description = `${comparison.head.name ?? `Detached ${comparison.head.commit.slice(0, 8)}`} · ${comparison.changes.length} files`;
      this.tree.title = 'Generated Diffs';
    } catch (error) {
      if (version !== this.generation || git !== this.git) { return; }
      this.comparison = undefined;
      this.message = errorText(error).includes('HEAD^{commit}') ? 'This repository has no commits yet.' : errorText(error);
      this.tree.description = 'Review unavailable';
    }
    this.updateStatus();
  }

  private snapshot(snapshot: Snapshot): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${snapshot.file}`, query: `session=${this.session}&id=${snapshot.id ?? 'empty'}&n=${this.snapshots.size}` });
    this.snapshots.set(uri.toString(), snapshot);
    return uri;
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const source = this.snapshots.get(uri.toString());
    if (!source) { throw new Error('This review expired. Reopen the file from Generated Diffs.'); }
    if (source.text !== undefined) { return source.text; }
    if (!source.id) { return ''; }
    const bytes = await source.git.blob(source.id);
    if (isBinary(bytes)) { return 'Binary file changed. Text editing is unavailable for this file.'; }
    return vscode.workspace.decode(bytes, { uri: vscode.Uri.file(path.join(source.git.root, source.file)) });
  }

  private async resources(change: Change): Promise<[vscode.Uri, vscode.Uri, vscode.Uri]> {
    const git = this.git!;
    const comparison = this.comparison!;
    const file = vscode.Uri.file(path.join(git.root, change.path));
    const old = { git, id: change.oldId, file: change.oldPath };
    const next = { git, id: change.newId, file: change.path };
    const summary = (reason: string): [vscode.Uri, vscode.Uri, vscode.Uri] => [file,
      this.snapshot({ ...old, text: `${reason}\n\nBaseline object: ${change.oldId ?? '(absent)'}\n` }),
      this.snapshot({ ...next, text: `${reason}\n\nCurrent object: ${change.newId ?? '(working file or absent)'}\n` }),
    ];
    if (change.kind === 'Conflict') { return summary('Merge conflict: resolve it through VS Code Source Control before reviewing.'); }
    if ([change.oldMode, change.newMode].includes('160000')) { return summary('Submodule pointer changed.'); }
    if ([change.oldMode, change.newMode].includes('120000')) { return summary('Symbolic link changed. Open the link itself outside this review if needed.'); }
    try {
      if (change.oldId && isBinary(await git.blob(change.oldId))) { return summary('Binary file changed.'); }
      if (!comparison.local && change.newId && isBinary(await git.blob(change.newId))) { return summary('Binary file changed.'); }
      let right: vscode.Uri;
      if (!comparison.local) { right = this.snapshot(next); }
      else if (change.kind === 'Deleted') { right = this.snapshot({ ...next, text: '' }); }
      else {
        const full = await safeFile(git.root, change.path);
        const stat = await lstat(full);
        if (!stat.isFile()) { return summary('This path is not a regular text file.'); }
        if (stat.size > MAX_FILE_BYTES) { return summary('This file exceeds the 2 MB review limit. Open it in the regular editor.'); }
        if (isBinary(await readFile(full))) { return summary('Binary file changed.'); }
        const doc = await vscode.workspace.openTextDocument(file);
        this.reviewDocs.set(file.toString(), doc);
        this.saves.track(doc, this.token());
        this.saves.changed(doc);
        right = file;
      }
      return [file, this.snapshot(old), right];
    } catch (error) {
      return summary(errorText(error));
    }
  }

  private async ensureCurrent(): Promise<void> {
    if (!this.git || !this.comparison || this.busy) { throw new Error('Choose a project and wait for its comparison to load.'); }
    if (identity(await this.git.head()) !== this.knownIdentity) {
      await this.refresh();
      throw new Error('The checked-out branch changed. Select the file again from the refreshed view.');
    }
  }
  async openFile(change: Change): Promise<void> {
    await this.ensureCurrent();
    const current = this.comparison!.changes.find(item => item.path === change.path);
    if (!current) { throw new Error('This file is no longer changed. Refresh the review.'); }
    const session = this.session;
    const [, left, right] = await this.resources(current);
    if (session !== this.session) { return; }
    await this.ensureCurrent();
    await vscode.commands.executeCommand('vscode.diff', left, right, `${change.path} · ${shortRef(this.comparison!.baseRef)} (branch point) ↔ ${this.knownIdentity}${this.includeLocal ? ' + local edits' : ' (committed)'}`, { preview: false });
    this.rememberTabs();
  }
  async openAll(): Promise<void> {
    await this.ensureCurrent();
    if (!this.comparison!.changes.length) { void vscode.window.showInformationMessage('No changed files to open.'); return; }
    const session = this.session;
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    for (const change of this.comparison!.changes) {
      resources.push(await this.resources(change));
      if (session !== this.session) { return; }
    }
    await this.ensureCurrent();
    const title = `Generated Diffs · ${path.basename(this.git!.root)} · ${this.knownIdentity} · ${this.session}${this.includeLocal ? ' + local edits' : ' (committed)'}`;
    await vscode.commands.executeCommand('vscode.changes', title, resources);
    this.rememberTabs(title);
  }
  private rememberTabs(title?: string): void {
    for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === SCHEME || tab.label.startsWith('Generated Diffs · ') || title && tab.label === title) { this.reviewTabs.add(tab); }
    }
  }
  private async closeReview(external: boolean): Promise<boolean> {
    const tabs = [...this.reviewTabs];
    if (external) {
      this.saves.clear();
      this.session++;
      await vscode.window.tabGroups.close(tabs.filter(tab => !tab.isDirty), true);
    } else {
      if (this.saves.enabled) { await this.saves.flush(); }
      if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) { return false; }
      this.saves.clear();
      this.session++;
    }
    this.reviewTabs.clear();
    this.reviewDocs.clear();
    this.comparison = undefined;
    this.lastSaveError = undefined;
    this.savingState = this.saves.enabled ? 'Auto-save on' : 'Auto-save off';
    return true;
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.repositorySubscription?.dispose();
    for (const disposable of this.subscriptions) { disposable.dispose(); }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<{ review: Review }> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) { throw new Error('Enable VS Code’s built-in Git extension to use Generated Diffs.'); }
  const exported = await extension.activate();
  if (!exported.enabled) { throw new Error('Enable Git in VS Code’s settings to use Generated Diffs.'); }
  const api = exported.getAPI(1);
  const review = new Review(api, context);
  context.subscriptions.push(review);
  const commands: Record<string, (...args: any[]) => Promise<unknown>> = {
    chooseProject: () => review.chooseProject(), chooseBranch: () => review.chooseBranch(),
    chooseBase: () => review.chooseBase(), refresh: () => review.refresh(),
    openFile: (change: Change) => review.openFile(change), openAll: () => review.openAll(),
    toggleLocal: () => review.toggleLocal(), toggleAutoSave: () => review.toggleAutoSave(), retrySave: () => review.retrySave(),
  };
  for (const [name, run] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`generatedDiffs.${name}`, async (...args: unknown[]) => {
      try { return await run(...args); }
      catch (error) { void vscode.window.showErrorMessage(`Generated Diffs: ${errorText(error)}`); }
    }));
  }
  const last = context.workspaceState.get<string>('generatedDiffs.project');
  await review.selectRepository(api.repositories.find(repo => repo.rootUri.toString() === last) ?? api.repositories[0]);
  return { review };
}
