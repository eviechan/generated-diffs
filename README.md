# Generated Diffs

A VS Code extension for checking out a branch, reviewing everything it changes from `main`, and editing directly in the native diff editor. The review includes committed, staged, unstaged, untracked, and open-editor changes.

## Usage

1. Open a trusted Git project in VS Code.
2. Open **Source Control → Generated Diffs**.
3. Choose **Project**, then use **Branch** to search for and check out the branch to review.
4. Select a changed file, or choose **Open All Changes**. Edit the right side of a diff; the extension saves the working file after about one second without typing.

The left side, **Main (branch point)**, is read-only. The default base is the branch's common ancestor with local `main`, falling back to `origin/main`. The **Base branch** control can override that choice.

**Committed only** opens read-only snapshots of both versions. **Auto-save** affects only files opened by Generated Diffs and does not alter VS Code's global Auto Save setting.

## Installation

Build and install a local VSIX:

```sh
npm ci --ignore-scripts
npm run package
code --install-extension generated-diffs-0.1.0.vsix
```

Reload VS Code after installation. The extension requires VS Code 1.138 or later, the built-in Git extension, and local Git.

## How comparisons work

- The default comparison includes committed work and your current local edits.
- Selecting a remote-only branch creates a local tracking branch when needed.
- A branch already open in another worktree can be opened in that worktree instead.
- Checkout requires a clean project so local edits cannot be moved to another branch unexpectedly.
- Generated Diffs never stages, commits, pushes, fetches, or sends source code to a server.

## Limits

Binary files, symbolic links, submodule pointers, conflicts, and files over 2 MB show a summary. Deleted files have an empty read-only side. Ignored untracked files and untitled buffers are excluded.

External Git commands are outside the extension's control. Stop editing while switching branches outside VS Code; ordinary VS Code disk-conflict handling still applies.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run package
```

Press `F5` to start an Extension Development Host. `npm run test:integration` installs the packaged VSIX into an isolated VS Code profile and exercises the editor flow. Set `VSCODE_EXECUTABLE` when VS Code is installed outside the usual macOS location.

## License

[MIT](LICENSE). The bundled Git API declarations retain their original Microsoft MIT license header.
