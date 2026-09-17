# Generated Diffs

A local VS Code extension for choosing a project and branch, reviewing its changes against main, and editing directly in the diff with automatic saving.

## Use

1. In VS Code, run **Extensions: Install from VSIX…** and select `generated-diffs-0.1.0.vsix`.
2. Open a trusted Git project, then open **Source Control → Generated Diffs**.
3. Click **Project** to choose an open repository or worktree. Click **Branch** to search branches and check one out.
4. Select a changed file, or use **Open All Changes**. Edit the right side. After about one second without typing, the change saves to the real file.

**Main (branch point)** on the left is read-only. The comparison starts at the common ancestor with local `main`, falling back to local `origin/main`. It includes committed work, saved changes, untracked files, and unsaved editor text. The base dropdown supports a different parent branch. Remote refs are used as they exist locally; the extension does not fetch automatically.

The status bar shows saving, saved, or a retryable error. The **Auto-save** row controls saving for files opened in this review; it does not change VS Code's global Auto Save setting. Existing VS Code Auto Save remains independent. **Committed only** switches to read-only snapshots of both versions.

Saves are ordinary, uncommitted working-file edits. Nothing is staged, committed, pushed, or sent to a server. Branch checkout requires a clean project so existing changes cannot silently move to another branch. Commit or stash through normal Source Control first. A branch open in another worktree offers to open that worktree.

## Boundaries

- Requires VS Code 1.138 or later, the built-in Git extension, and local Git. Browser-only and untrusted workspaces are unsupported.
- Binary files, symbolic links, submodule pointers, conflicts, and files over 2 MB display a summary. Deleted files have an empty read-only side.
- Unsaved files must have a path inside the selected repository. Ignored untracked files and untitled buffers are excluded.
- The extension serializes its own saves and checkouts, and checks the current branch before saving. An external Git process is not controlled by the extension: stop editing while switching branches outside it. VS Code's normal disk-conflict handling still applies.
- Selecting a remote branch creates a local tracking branch when needed. An existing local branch with a different upstream must be selected explicitly.

## Develop

```sh
npm ci --ignore-scripts
npm test
npm run package
npm run test:integration
```

Press F5 to open an Extension Development Host. Tests use Node's built-in runner and temporary Git repositories. Integration tests install the packaged VSIX into an isolated VS Code profile and exercise the real editor, automatic saving, branch checkout, and multi-file diffs. Set `VSCODE_EXECUTABLE` if VS Code is installed elsewhere. On macOS the runner deliberately uses the Visual Studio Code application rather than a `code` alias that might point to Cursor.

No runtime dependencies. VS Code's Git API handles discovery and checkout; a small read-only Git adapter provides NUL-delimited change metadata (including type changes), reliable untracked-file discovery, and worktree information independently of Source Control display settings. All Git arguments are passed directly without a shell.

This repository is local only and has no remote. The vendored Git API type declarations retain Microsoft's MIT license header.
