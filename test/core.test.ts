import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Git, parseRawDiff, safeFile } from '../src/git';
import { ReviewSaves, SaveDocument } from '../src/saving';

const command = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'generated-diffs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  command(root, 'init', '-b', 'main');
  command(root, 'config', 'user.email', 'test@example.invalid');
  command(root, 'config', 'user.name', 'Generated Diffs Test');
  await writeFile(path.join(root, 'file.txt'), 'main\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  command(root, 'add', '.'); command(root, 'commit', '-m', 'main');
  command(root, 'checkout', '-b', 'feature');
  return { root, git: new Git(root), write: (file: string, text: string) => writeFile(path.join(root, file), text), commit: () => { command(root, 'add', '.'); command(root, 'commit', '-m', 'change'); } };
}

test('branch-point comparison includes committed, staged, saved, and unsaved changes; main/index remain unchanged', async t => {
  const f = await fixture(t);
  await f.write('file.txt', 'feature\n'); f.commit();
  command(f.root, 'checkout', 'main'); await f.write('main-only.txt', 'unrelated\n'); f.commit();
  command(f.root, 'checkout', 'feature');
  const mainBefore = command(f.root, 'rev-parse', 'main');
  await f.write('file.txt', 'staged\n'); command(f.root, 'add', 'file.txt');
  await f.write('file.txt', 'saved\n'); await f.write('new ü file.txt', 'new\n'); await f.write('ignored.txt', 'ignored');
  const indexBefore = command(f.root, 'write-tree');
  const result = await f.git.compare('refs/heads/main', true, new Map([['file.txt', 'unsaved\n'], ['ignored.txt', 'dirty ignored']]));
  assert.equal(result.head.name, 'feature');
  assert.notEqual(result.ancestor, result.baseCommit);
  assert.deepEqual(result.changes.map(change => change.path), ['file.txt', 'new ü file.txt']);
  assert.equal(result.changes[0].kind, 'Modified');
  assert.equal((await f.git.blob(result.changes[0].oldId!)).toString(), 'main\n');
  const committed = await f.git.compare('refs/heads/main', false);
  assert.deepEqual(committed.changes.map(change => change.path), ['file.txt']);
  assert.equal((await f.git.blob(committed.changes[0].newId!)).toString(), 'feature\n');
  assert.equal(command(f.root, 'rev-parse', 'main'), mainBefore);
  assert.equal(command(f.root, 'write-tree'), indexBefore);
});

test('dirty-only buffers appear; edits reverted to baseline disappear', async t => {
  const f = await fixture(t);
  const dirty = await f.git.compare('refs/heads/main', true, new Map([['file.txt', 'unsaved only']]));
  assert.equal(dirty.changes[0].path, 'file.txt');
  await f.write('file.txt', 'changed on disk');
  const reverted = await f.git.compare('refs/heads/main', true, new Map([['file.txt', 'main\n']]));
  assert.equal(reverted.changes.length, 0);
});

test('renames, deletions, tabs/newlines in paths, and symlink type changes are retained', async t => {
  const f = await fixture(t);
  await f.write('delete.txt', 'delete me\n'); f.commit();
  command(f.root, 'mv', 'file.txt', 'new\tname\nü.txt');
  await rm(path.join(f.root, 'delete.txt'));
  let changes = (await f.git.compare('refs/heads/main', true)).changes;
  assert.equal(changes.find(change => change.kind === 'Renamed')?.oldPath, 'file.txt');
  // delete.txt was introduced on the branch then deleted, so its net diff vanishes.
  assert.equal(changes.some(change => change.path === 'delete.txt'), false);
  command(f.root, 'reset', '--hard', 'HEAD');
  await rm(path.join(f.root, 'file.txt'));
  changes = (await f.git.compare('refs/heads/main', true)).changes;
  assert.equal(changes.find(change => change.path === 'file.txt')?.kind, 'Deleted');
  await symlink('/etc/hosts', path.join(f.root, 'file.txt'));
  changes = (await f.git.compare('refs/heads/main', true)).changes;
  assert.equal(changes.find(change => change.path === 'file.txt')?.kind, 'Type changed');
  await assert.rejects(safeFile(f.root, 'file.txt'), /Symbolic/);
  await assert.rejects(safeFile(f.root, '../elsewhere'), /outside/);
});

test('worktrees and detached HEAD are detected; missing bases/history fail clearly', async t => {
  const f = await fixture(t);
  const tree = path.join(f.root, 'other-tree');
  command(f.root, 'worktree', 'add', '-b', 'other', tree);
  assert.equal((await f.git.worktrees()).find(item => item.branch === 'other')?.path, tree);
  assert.equal(await f.git.resolveBase(), 'refs/heads/main');
  await assert.rejects(f.git.resolveBase('refs/heads/missing'), /no longer exists/);
  command(f.root, 'checkout', '--detach');
  assert.equal((await f.git.head()).name, undefined);
  command(f.root, 'checkout', '--orphan', 'unrelated');
  command(f.root, 'rm', '-rf', '--cached', '.');
  await f.write('unrelated', 'new root'); command(f.root, 'add', 'unrelated'); command(f.root, 'commit', '-m', 'unrelated root');
  await assert.rejects(f.git.compare('refs/heads/main', true), /No common ancestor/);
});

test('untracked file replacing an index-deleted baseline path is shown once as modified', async t => {
  const f = await fixture(t);
  command(f.root, 'rm', '--cached', 'file.txt');
  await f.write('file.txt', 'replacement');
  const result = await f.git.compare('refs/heads/main', true);
  assert.equal(result.changes.filter(change => change.path === 'file.txt').length, 1);
  assert.equal(result.changes[0].kind, 'Modified');
  await f.write('file.txt', 'main\n');
  assert.equal((await f.git.compare('refs/heads/main', true)).changes.length, 0);
});

test('large historical blobs are bounded and symlinked parent folders are rejected', async t => {
  const f = await fixture(t);
  await f.write('large.txt', 'x'.repeat(2 * 1024 * 1024 + 1)); f.commit();
  const details = await f.git.entry('HEAD', 'large.txt');
  await assert.rejects(f.git.blob(details!.id), /2 MB/);
  await mkdir(path.join(f.root, 'folder'));
  await f.write('folder/file', 'text');
  await symlink('folder', path.join(f.root, 'alias'));
  await assert.rejects(safeFile(f.root, 'alias/file'), /Symbolic/);
  assert.equal(await readFile(await safeFile(f.root, 'folder/file'), 'utf8'), 'text');
});

test('raw diff parsing fails closed on incomplete data', () => {
  assert.throws(() => parseRawDiff(':bad\0file\0'), /Unexpected/);
  assert.throws(() => parseRawDiff(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100\0old\0`), /Incomplete/);
});

class Document implements SaveDocument {
  isDirty = true;
  isClosed = false;
  calls = 0;
  handler: () => Promise<boolean> = async () => { this.isDirty = false; return true; };
  save(): Promise<boolean> { this.calls++; return this.handler(); }
}
function saving() {
  const states: string[] = [];
  let session = 'feature';
  const saves = new ReviewSaves<Document>(async () => session, async () => {}, message => states.push(message), 10);
  return { saves, states, switchBranch: () => { session = 'other'; } };
}

test('only registered documents auto-save, after the typing delay', async t => {
  const { saves, states } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); const unrelated = new Document();
  saves.track(doc, 'feature'); saves.changed(doc); saves.changed(unrelated);
  assert.equal(doc.calls, 0);
  await delay(35);
  assert.equal(doc.calls, 1); assert.equal(unrelated.calls, 0);
  assert.equal(states.at(-1), 'Saved');
});

test('failed saves preserve dirty state and can be retried', async t => {
  const { saves, states } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); doc.handler = async () => false;
  saves.track(doc, 'feature');
  await assert.rejects(saves.flush(), /could not save/);
  assert.equal(doc.isDirty, true); assert.match(states.at(-1)!, /failed/);
  doc.handler = async () => { doc.isDirty = false; return true; };
  await saves.flush(); assert.equal(states.at(-1), 'Saved');
});

test('queued saves cannot write after checkout or session invalidation', async t => {
  const s = saving(); t.after(async () => s.saves.dispose());
  const doc = new Document(); s.saves.track(doc, 'feature'); s.saves.changed(doc);
  s.switchBranch(); await delay(35);
  assert.equal(doc.calls, 0); assert.equal(doc.isDirty, true);
  assert.match(s.states.at(-1)!, /failed/);
  s.saves.clear(); await s.saves.flush(); assert.equal(doc.calls, 0);
});

test('saving and checkout operations serialize; newer edits get another save', async t => {
  const { saves } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); const order: string[] = [];
  doc.handler = async () => {
    order.push(`save${doc.calls}`); await delay(15);
    doc.isDirty = doc.calls === 1;
    return true;
  };
  saves.track(doc, 'feature');
  const first = saves.flush();
  const checkout = saves.exclusive(async () => { order.push('checkout'); });
  await Promise.all([first, checkout]); await delay(45);
  assert.deepEqual(order, ['save1', 'checkout', 'save2']);
  assert.equal(doc.isDirty, false);
});

test('turning auto-save off cancels even an already queued automatic save', async t => {
  const { saves } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); saves.track(doc, 'feature');
  const blocking = saves.exclusive(async () => { await delay(45); });
  saves.changed(doc); await delay(20); saves.setEnabled(false);
  await blocking; await delay(20);
  assert.equal(doc.calls, 0); assert.equal(doc.isDirty, true);
});

test('a successful manual save clears an earlier automatic save failure', async t => {
  const { saves, states } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); doc.handler = async () => false; saves.track(doc, 'feature');
  await assert.rejects(saves.flush());
  doc.isDirty = false; saves.changed(doc);
  assert.equal(states.at(-1), 'Saved');
});

test('resuming after a blocked checkout saves edits made during the pause', async t => {
  const { saves } = saving(); t.after(async () => saves.dispose());
  const doc = new Document(); saves.track(doc, 'feature'); saves.paused = true;
  saves.changed(doc); await delay(20); assert.equal(doc.calls, 0);
  saves.paused = false; saves.setEnabled(saves.enabled);
  await delay(35); assert.equal(doc.calls, 1); assert.equal(doc.isDirty, false);
});
