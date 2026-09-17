const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cli = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : 'code');
const workspace = realpathSync(mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'gd-host-')));
const profile = path.join(workspace, 'profile');
const extensions = path.join(workspace, 'extensions');
const repo = path.join(workspace, 'project');
const driver = path.join(workspace, 'test-driver');
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
mkdirSync(repo); mkdirSync(driver); mkdirSync(path.join(profile, 'User'), { recursive: true });
writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
  'git.autofetch': false, 'files.autoSave': 'off', 'security.workspace.trust.enabled': false,
  'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true,
}));
writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'generated-diffs-test-driver', version: '0.0.1', engines: { vscode: '^1.138.0' }, main: './index.js', activationEvents: ['*'] }));
writeFileSync(path.join(driver, 'index.js'), 'exports.activate = () => {};');
git('init', '-b', 'main'); git('config', 'user.name', 'Generated Diffs Test'); git('config', 'user.email', 'test@example.invalid');
writeFileSync(path.join(repo, 'example.ts'), 'export const greeting = "Hello";\n');
writeFileSync(path.join(repo, 'deleted.txt'), 'Removed on feature branch\n');
writeFileSync(path.join(repo, 'old name.txt'), 'This file will be renamed\n');
git('add', '.'); git('commit', '-m', 'Baseline'); git('checkout', '-b', 'feature/review');
writeFileSync(path.join(repo, 'example.ts'), 'export const greeting = "Hello from my branch";\n');
git('rm', 'deleted.txt'); git('mv', 'old name.txt', 'new name.txt'); git('add', '.'); git('commit', '-m', 'Feature changes');
git('branch', 'feature/other');
const vsix = process.env.GENERATED_DIFFS_VSIX || path.join(root, 'generated-diffs-0.1.0.vsix');
execFileSync(cli, ['--user-data-dir', profile, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { stdio: 'inherit' });
const executable = process.env.VSCODE_TEST_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : cli);
const env = { ...process.env, GENERATED_DIFFS_TEST_ROOT: workspace };
delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
const child = spawn(executable, [repo, '--user-data-dir', profile, '--extensions-dir', extensions,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  `--extensionDevelopmentPath=${driver}`, `--extensionTestsPath=${path.join(root, 'out/test/integration.js')}`,
], { stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
const timer = setTimeout(() => { child.kill('SIGTERM'); process.exitCode = 1; }, 120000);
child.on('exit', code => {
  clearTimeout(timer);
  const resultPath = path.join(workspace, 'result.json');
  const passed = existsSync(resultPath) && JSON.parse(readFileSync(resultPath, 'utf8')).passed === true;
  if (!passed) { console.error('Integration checks did not report success.'); }
  if (!process.env.KEEP_GENERATED_DIFFS_TEST_PROFILE) { rmSync(workspace, { recursive: true, force: true }); }
  else { console.log(`Test workspace: ${workspace}`); }
  process.exitCode = code || process.exitCode || (passed ? 0 : 1);
});
