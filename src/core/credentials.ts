import * as vscode from 'vscode';
import { portOf, Server } from './config';

type Kind = 'password' | 'passphrase';

/**
 * Passwords live in the OS keychain (SecretStorage), keyed by the account they belong to rather
 * than the server name: a cloned project reusing a server name for another host never receives
 * a password saved for a different account.
 */
export class Credentials {
  private readonly session = new Map<string, string>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  static account(server: Server): string {
    if (server.type === 'local') {
      return `local:${server.rootPath}`;
    }
    const scheme = server.type === 'webdav' ? (server.ssl ? 'https' : 'http') : server.type;
    return `${scheme}://${server.user}@${server.host}:${portOf(server)}`;
  }

  private key(server: Server, kind: Kind): string {
    return kind === 'passphrase' ? `passphrase:${server.keyPath ?? ''}` : `password:${Credentials.account(server)}`;
  }

  async get(server: Server, kind: Kind): Promise<string | undefined> {
    const key = this.key(server, kind);
    return this.session.get(key) ?? (await this.secrets.get(key));
  }

  /** `permanent: false` keeps the value only until the window is closed ("saved until IDE restart"). */
  async set(server: Server, kind: Kind, value: string, permanent: boolean): Promise<void> {
    const key = this.key(server, kind);
    if (permanent) {
      this.session.delete(key);
      await this.secrets.store(key, value);
    } else {
      this.session.set(key, value);
    }
  }

  async forget(server: Server, kind: Kind): Promise<void> {
    const key = this.key(server, kind);
    this.session.delete(key);
    await this.secrets.delete(key);
  }

  async has(server: Server, kind: Kind): Promise<boolean> {
    return (await this.get(server, kind)) !== undefined;
  }

  /** Stored value, or ask the user (and offer to remember it). */
  async obtain(server: Server, kind: Kind, retry = false): Promise<string | undefined> {
    if (!retry) {
      const stored = await this.get(server, kind);
      if (stored !== undefined) {
        return stored;
      }
    }
    const what = kind === 'password' ? `password for ${Credentials.account(server)}` : `passphrase for ${server.keyPath}`;
    const value = await vscode.window.showInputBox({
      title: `Deployment: ${server.name}`,
      prompt: retry ? `Authentication failed. Enter ${what}` : `Enter ${what}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return undefined;
    }
    const save = await vscode.window.showQuickPick(
      [
        { label: 'Save password permanently', value: 'permanent' },
        { label: 'Save until restart', value: 'session' },
        { label: 'Do not save', value: 'none' },
      ],
      { title: `Deployment: ${server.name}`, placeHolder: 'Remember it?', ignoreFocusOut: true },
    );
    if (save?.value === 'permanent' || save?.value === 'session') {
      await this.set(server, kind, value, save.value === 'permanent');
    }
    return value;
  }
}
