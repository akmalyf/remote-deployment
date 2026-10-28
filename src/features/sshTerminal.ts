import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { Server } from '../core/config';
import type { Credentials } from '../core/credentials';
import { sshConnectConfig } from '../transport/sftp';
import { shellQuote } from '../transport/types';

/** Tools | Start SSH Session: an interactive shell over ssh2 in a VS Code terminal. */
export function startSshSession(server: Server, credentials: Credentials, cwd?: string): vscode.Terminal {
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let client: Client | undefined;
  let stream: ClientChannel | undefined;
  let dims: vscode.TerminalDimensions | undefined;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: (initial) => {
      dims = initial;
      write.fire(`Connecting to ${server.user ? server.user + '@' : ''}${server.host}…\r\n`);
      void (async () => {
        try {
          const target = await sshConnectConfig(server, credentials);
          client = new Client();
          client.on('ready', () => {
            client!.shell({ term: 'xterm-256color', cols: dims?.columns ?? 80, rows: dims?.rows ?? 24 }, (err, s) => {
              if (err) {
                write.fire(`\r\n${err.message}\r\n`);
                close.fire(1);
                return;
              }
              stream = s;
              s.on('data', (d: Buffer) => write.fire(d.toString('utf8')));
              s.stderr.on('data', (d: Buffer) => write.fire(d.toString('utf8')));
              s.on('close', () => {
                client?.end();
                close.fire(0);
              });
              if (cwd) {
                s.write(`cd ${shellQuote(cwd)} 2>/dev/null; clear\n`);
              }
            });
          });
          client.on('error', (e) => {
            write.fire(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
            close.fire(1);
          });
          client.on('close', () => close.fire(0));
          client.connect(target.config);
        } catch (e) {
          write.fire(`\r\n\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
          close.fire(1);
        }
      })();
    },
    close: () => {
      stream?.end();
      client?.end();
    },
    handleInput: (data) => stream?.write(data),
    setDimensions: (d) => {
      dims = d;
      stream?.setWindow(d.rows, d.columns, 0, 0);
    },
  };
  const terminal = vscode.window.createTerminal({ name: `SSH: ${server.name}`, pty, iconPath: new vscode.ThemeIcon('remote') });
  terminal.show();
  return terminal;
}
