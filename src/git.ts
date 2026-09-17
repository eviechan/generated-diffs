import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export type ChangeKind = 'Added' | 'Modified' | 'Deleted' | 'Renamed' | 'Type changed' | 'Conflict';
export interface Change {
  path: string;
  oldPath: string;
  oldId?: string;
  newId?: string;
  oldMode: string;
  newMode: string;
  kind: ChangeKind;
}
export interface Head { name?: string; commit: string; }
export interface Comparison {
  head: Head;
  baseRef: string;
  baseCommit: string;
  ancestor: string;
  local: boolean;
  changes: Change[];
}
export interface Branch { name: string; ref: string; remote?: string; }
export interface Worktree { path: string; branch?: string; }
export const identity = (head: Head): string => head.name ?? head.commit;
const oid = (value: string): string | undefined => /^0+$/.test(value) ? undefined : value;

export function parseRawDiff(raw: string): Change[] {
  const fields = raw.split('\0');
  const result: Change[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i++]);
    if (!match || i >= fields.length - 1) { throw new Error('Unexpected Git diff output.'); }
    const [, oldMode, newMode, oldId, newId, status] = match;
    const oldPath = fields[i++];
    const renamed = status === 'R' || status === 'C';
    const filePath = renamed ? fields[i++] : oldPath;
    if (!filePath) { throw new Error('Incomplete Git diff path.'); }
    const kind: ChangeKind = status === 'A' || status === 'C' ? 'Added' : status === 'D' ? 'Deleted'
      : status === 'R' ? 'Renamed' : status === 'T' ? 'Type changed' : status === 'U' ? 'Conflict' : 'Modified';
    result.push({ path: filePath, oldPath, oldId: oid(oldId), newId: oid(newId), oldMode, newMode, kind });
  }
  return result;
}

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Reject symlink components as well as lexical traversal before opening an editable file. */
export async function safeFile(root: string, relative: string): Promise<string> {
  const full = path.resolve(root, relative);
  if (!inside(root, full)) { throw new Error('The file is outside the selected repository.'); }
  let current = root;
  for (const component of path.relative(root, full).split(path.sep)) {
    current = path.join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) { throw new Error('Symbolic links are displayed as summaries and are not editable here.'); }
  }
  if (!inside(await realpath(root), await realpath(full))) { throw new Error('The file resolves outside the repository.'); }
  return full;
}

export class Git {
  constructor(readonly root: string, private readonly executable = 'git') {}

  async run(args: string[]): Promise<Buffer> {
    const { stdout } = await exec(this.executable, ['--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd: this.root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }
  async text(args: string[]): Promise<string> { return (await this.run(args)).toString('utf8'); }

  async head(): Promise<Head> {
    const commit = (await this.text(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const name = (await this.text(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return { commit, name: name === 'HEAD' ? undefined : name };
  }

  async branches(): Promise<Branch[]> {
    const output = await this.text(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/']);
    return output.trim().split('\n').filter(Boolean).filter(ref => !ref.endsWith('/HEAD')).map(ref => {
      const remote = ref.startsWith('refs/remotes/');
      const name = ref.replace(/^refs\/(heads|remotes)\//, '');
      return { ref, name, remote: remote ? name.slice(0, name.indexOf('/')) : undefined };
    });
  }

  async worktrees(): Promise<Worktree[]> {
    const result: Worktree[] = [];
    for (const field of (await this.text(['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
      if (field.startsWith('worktree ')) { result.push({ path: field.slice(9) }); }
      if (field.startsWith('branch ') && result.length) { result.at(-1)!.branch = field.slice(7).replace(/^refs\/heads\//, ''); }
    }
    return result;
  }

  async resolveBase(preferred?: string): Promise<string> {
    const branches = await this.branches();
    if (preferred) {
      if (branches.some(branch => branch.ref === preferred)) { return preferred; }
      throw new Error('The selected comparison base no longer exists. Choose another base.');
    }
    const base = ['refs/heads/main', 'refs/remotes/origin/main'].find(ref => branches.some(branch => branch.ref === ref));
    if (!base) { throw new Error('No main or origin/main branch is available. Choose a comparison base.'); }
    return base;
  }

  async entry(ref: string, file: string): Promise<{ id: string; mode: string } | undefined> {
    const raw = await this.text(['ls-tree', '-z', ref, '--', file]);
    if (!raw) { return undefined; }
    const match = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(raw);
    if (!match) { throw new Error('Unexpected Git tree output.'); }
    return { mode: match[1], id: match[2] };
  }

  async blob(id: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40,64}$/.test(id)) { throw new Error('Invalid Git object.'); }
    const size = Number((await this.text(['cat-file', '-s', id])).trim());
    if (size > MAX_FILE_BYTES) { throw new Error('This file exceeds the 2 MB review limit. Open it in the regular editor.'); }
    return this.run(['cat-file', 'blob', id]);
  }

  async isClean(): Promise<boolean> {
    return (await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length === 0;
  }

  async compare(
    baseRef: string, local: boolean, dirty: ReadonlyMap<string, string> = new Map(),
    decode: (bytes: Buffer, file: string) => Promise<string> = async bytes => bytes.toString('utf8'),
  ): Promise<Comparison> {
    const head = await this.head();
    const baseCommit = (await this.text(['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
    let ancestor: string;
    try { ancestor = (await this.text(['merge-base', baseCommit, head.commit])).trim(); }
    catch { throw new Error('No common ancestor is available. Choose another base or fetch the missing history.'); }
    const raw = await this.text(['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', ancestor, ...local ? [] : [head.commit], '--']);
    const changes = new Map(parseRawDiff(raw).map(change => [change.path, change]));
    if (local) {
      const untracked = (await this.text(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      const untrackedPaths = new Set(untracked);
      const candidates = new Set([...untracked, ...dirty.keys()]);
      // ponytail: one tree lookup per extra path; batch ls-tree if large untracked sets prove slow.
      for (const file of candidates) {
        if (!inside(this.root, path.resolve(this.root, file))) { continue; }
        const tracked = (await this.run(['ls-files', '-z', '--', file])).length > 0;
        if (!tracked && !untrackedPaths.has(file)) { continue; }
        let change = changes.get(file);
        if (!change) {
          const old = await this.entry(ancestor, file);
          change = { path: file, oldPath: file, oldId: old?.id, oldMode: old?.mode ?? '000000', newMode: old?.mode ?? '100644', kind: old ? 'Modified' : 'Added' };
        } else if (change.kind === 'Deleted') {
          change = { ...change, kind: 'Modified', newMode: '100644' };
        }
        changes.set(file, change);
        if (untrackedPaths.has(file) && !dirty.has(file) && change.oldId && change.oldMode === change.newMode && change.oldMode.startsWith('100')) {
          const full = path.resolve(this.root, file);
          const stat = await lstat(full);
          if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
            const bytes = await readFile(await safeFile(this.root, file));
            const size = Number((await this.text(['cat-file', '-s', change.oldId])).trim());
            if (size <= MAX_FILE_BYTES && bytes.equals(await this.blob(change.oldId))) { changes.delete(file); }
          }
        }
        if (dirty.has(file) && change.oldId && change.kind !== 'Renamed' && change.kind !== 'Conflict' && change.oldMode.startsWith('100') && change.oldMode === change.newMode) {
          // Only dirty buffers need content comparison; normal saved files use Git's diff.
          try {
            const original = await decode(await this.blob(change.oldId), change.oldPath);
            if (original === dirty.get(file)) { changes.delete(file); }
          } catch (error) {
            if (!(error instanceof Error && error.message.includes('2 MB'))) { throw error; }
          }
        }
      }
      const conflicts = (await this.text(['diff', '--name-only', '--diff-filter=U', '-z', '--'])).split('\0').filter(Boolean);
      for (const file of conflicts) {
        const change = changes.get(file);
        if (change) { change.kind = 'Conflict'; }
        else { changes.set(file, { path: file, oldPath: file, oldMode: '000000', newMode: '100644', kind: 'Conflict' }); }
      }
    }
    const after = await this.head();
    if (after.commit !== head.commit || identity(after) !== identity(head)) { throw new Error('The branch changed while refreshing. Refresh again.'); }
    return { head, baseRef, baseCommit, ancestor, local, changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }
}
