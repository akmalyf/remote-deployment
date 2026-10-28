# Changelog

## 1.0.0

Initial release.

- Protocols: SFTP (password, key pair, agent, `~/.ssh/config`; known_hosts check; rsync; sudo), FTP, FTPS (explicit / implicit, data channel protection, TLS 1.3 switch), WebDAV, local or mounted folder.
- Remote Host view: browse servers, drag and drop, create / rename / delete / cut / copy / paste, permissions, exclusions, Go to Path, SSH session; server rows with a default star and a ⋯ action menu.
- Upload / Download to the default server or any server or group, Upload All Open Files, Compare with Deployed Version, Edit Remote File; manual uploads ask for confirmation by default.
- Sync with Deployed: directory diff table with filters, compare modes and per-item operations, and an embedded file diff with copy-to-local / push-to-server arrows.
- Edit Remote File with upload on save, Upload / Refresh Current Remote File, Compare / Revert to Last Uploaded Version.
- Automatic upload (always / on explicit save), external changes, remote deletion; upload on commit; `deployment` task type; Open in Browser; New Project from Existing Files.
- File Transfer panel and log.
- Configuration panel (servers, connection, mappings, excluded paths, groups, options) stored in `.vscode/deployment.json` with a JSON schema; passwords in the OS keychain; import of `.idea` deployment configurations.
