# Remote Deployment

**SFTP, FTP, FTPS, WebDAV and local-folder deployment for VS Code.** Browse your servers, upload and download, compare and sync with a built-in diff, upload automatically on save, edit remote files in place and open an SSH terminal, all from one activity bar view.

## Features

- **Remote Host view.** Every configured server in one tree. Drag files in from the Explorer, drag to move, create, rename, delete, cut / copy / paste, change permissions (rwx or octal), copy paths and web URLs, exclude paths, jump to any folder. Mapped items are green, excluded items are dimmed.
- **Upload / Download.** Right-click any file or folder → **Deployment** → Upload, Download, Compare, Sync, Edit Remote File. Upload To… / Download From… any server or group, and Upload All Open Files, from the Command Palette (`⌘⇧⌥X` / `Ctrl+Shift+Alt+X` for Upload To…).
- **Sync with Deployed.** Local and deployed files side by side (Name · Size · Date · operation · Date · Size · Name) with filters for new, different and equal files, and Compare by binary content, size, or size and timestamp. Space or click changes the operation, Enter performs it. The selected file's diff sits right below the table: a JetBrains-style diff ([ide-diff](https://github.com/akmalyf/ide-diff)) with IntelliJ's diff algorithms, word-level highlighting, a curved divider between changes and syntax highlighting, in your theme's colors:
  - `«` copies a change from the server into the local file; unlock the deployed side to edit it and push changes back with `»`
  - previous / next difference (F7 / Shift+F7), previous / next file, collapse unchanged fragments, side-by-side or unified, ignore policies (whitespace, empty lines), highlighting by lines / words / characters, whitespaces, line numbers, soft wraps
- **Edit Remote File.** Open a deployed file directly; saving uploads it (with a warning when the server copy changed or was deleted meanwhile). Upload Current Remote File (`⇧⌥Q`), Refresh, and Compare / Revert to the last uploaded version.
- **Automatic upload.** Always, or on explicit save only. Optionally includes changes made outside the editor and deletes remote files when local ones are deleted. Changes are batched per project.
- **SSH terminal** for SFTP servers, opened in the server's folder.
- **Upload on commit**, a `deployment` **task type** for `preLaunchTask`, **Open in Browser** through web path mappings, and **New Project from Existing Files** (download a server folder into a new project).
- **File Transfer panel.** Every operation with its result (transferred, up to date, excluded, skipped, deleted, failed) and per-file details, plus a log output channel.
- **Safe by default.** Manual uploads and remote deletions ask first; overwriting local files asks first; passwords live in the OS keychain; SFTP host keys are checked against `~/.ssh/known_hosts`; untrusted FTPS certificates need your confirmation.

## Getting started

1. Open the **Deployment** view in the activity bar → **Add Server**, or run **Deployment: Configuration…**.
2. Fill in the connection, add mappings (local folder ↔ server folder), then **Test Connection** and **OK**.
3. Star a server as the default (★ in the Configuration list, or **Use as Default Server** in the server's ⋯ menu).
4. Right-click a file → **Deployment** → **Upload to Default Server**, or turn on automatic upload in **Options**.

Already have an `.idea` deployment configuration (`deployment.xml`, `webServers.xml`, `sshConfigs.xml`) in the project? Remote Deployment offers to import it, or run **Deployment: Import .idea Deployment Configuration**.

## Protocols

| Protocol | Notes |
|---|---|
| SFTP | Password, key pair (with passphrase), SSH agent, or `~/.ssh/config` + agent + identity files. Optional rsync for folder transfers (agent / key auth) and `sudo -n` for writes. |
| FTP / FTPS | Explicit (AUTH TLS) and implicit FTPS, data channel protection, optional TLS 1.3 switch-off. Passive mode only. |
| WebDAV | HTTP or HTTPS, basic authentication. No permissions or timestamps (protocol limitation). |
| Local or mounted folder | Copy to any folder, e.g. a mounted network share. |

## Configuration

Servers, mappings and options are stored in `.vscode/deployment.json` (edit it in **Deployment: Configuration…** or by hand; a JSON schema provides completion). Passwords are never written to this file.

```jsonc
{
  "defaultServer": "production",
  "servers": [
    {
      "name": "production",
      "type": "sftp",               // sftp | ftp | ftps | webdav | local
      "host": "example.com",
      "user": "deploy",
      "auth": "openSsh",            // password | key | agent | openSsh
      "rootPath": "/var/www",
      "webUrl": "https://example.com",
      "mappings": [{ "local": ".", "deploy": "/app", "web": "/" }],
      "excludedPaths": [{ "path": "vendor", "local": true }, { "path": "/app/storage", "local": false }]
    }
  ],
  "groups": [{ "name": "all", "servers": ["production", "staging"] }],
  "options": { "autoUpload": "onExplicitSave" }
}
```

Local mapping paths are relative to the workspace folder or absolute; deployment paths are relative to `rootPath`. A server with `"global": true` keeps its connection in VS Code and is available to all your projects; only its mappings live in the project file.

| `options` | Default | |
|---|---|---|
| `autoUpload` | `never` | `always`, `onExplicitSave` or `never` |
| `uploadExternalChanges` | `false` | Automatic upload also for changes made outside the editor |
| `deleteRemoteOnLocalDelete` | `false` | Automatic upload deletes remote files when local ones are deleted |
| `confirmBeforeUploading` | `true` | Ask before a manual upload |
| `confirmBeforeDeletion` | `true` | Ask before deleting remote items |
| `overwriteUpToDate` | `false` | Transfer files even when size and timestamp match |
| `preserveTimestamps` | `true` | Keep modification times |
| `deleteMissingItems` | `false` | Delete target items when the source ones do not exist |
| `createEmptyFolders` | `false` | Create empty folders |
| `promptOnLocalOverwrite` | `true` | Ask before overwriting or deleting local files |
| `promptOnRemoteOverwrite` | `none` | Warn when uploading over a newer server file: `none`, `timestamp` or `content` |
| `notifyRemoteChanges` | `false` | Warn when an opened file changed on the server |
| `excludeByName` | `.svn;.cvs;.idea;.DS_Store;.git;.hg;.vscode` | Names to skip (`;` separated, `*` and `?` wildcards) |
| `filePermissions`, `folderPermissions` | | Octal permissions for uploaded files / created folders |
| `useTempFile` | `false` | Upload to a temporary file, then rename |
| `uploadOnCommit` | | Server or group to upload committed files to |
| `logLevel` | `brief` | `errors`, `brief` or `details` |
| `autoUploadDebounceMs` / `autoUploadConfirmOver` | `400` / `100` | Automatic upload batching |

VS Code settings: `remoteDeployment.connectionIdleTimeout` (seconds, default 300) and `remoteDeployment.remoteEdit.uploadOnSave` (default on).

### Upload before running

```jsonc
// .vscode/tasks.json
{ "version": "2.0.0", "tasks": [{ "type": "deployment", "label": "deploy", "server": "staging" }] }
// .vscode/launch.json: "preLaunchTask": "deploy"
```

## Limitations

- FTP uses passive mode only.
- WebDAV cannot set permissions or timestamps, so up-to-date detection relies on size and the server's modification time.
- rsync runs the system `ssh` in batch mode and is skipped for password authentication or keys that need a passphrase prompt.
- The Sync diff shows text files up to 5 MB; binary files are reported as identical or different.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
```

`npm test` runs the unit tests and the local-folder transport. Pass a folder served by local SFTP / FTP / FTPS / WebDAV test servers to run the protocol tests too: `node dist-test/smoke.js <servers-dir>` (see the header of `test/smoke.ts`).

## License

[MIT](LICENSE)

The Sync diff uses [ide-diff](https://github.com/akmalyf/ide-diff) (Apache-2.0), a port of parts of the [JetBrains IntelliJ Platform](https://github.com/JetBrains/intellij-community) (Apache-2.0), and [CodeMirror](https://codemirror.net/) (MIT).
