import * as vscode from 'vscode';
import { describeServer, PROTOCOL_LABELS, resolveTarget, Server } from '../core/config';
import { formatMode } from '../core/paths';
import type { Project } from '../core/project';

interface TargetItem extends vscode.QuickPickItem {
  target: string;
}

/** Choose a server or a server group ("Upload To…", "Download From…"). */
export async function pickTarget(
  project: Project,
  title: string,
  opts: { groups?: boolean; filter?: (s: Server) => boolean } = {},
): Promise<Server[] | undefined> {
  const items: TargetItem[] = [];
  const def = project.config.defaultServer;
  for (const s of project.config.servers.filter(opts.filter ?? (() => true))) {
    items.push({
      label: `$(server) ${s.name}`,
      description: `${PROTOCOL_LABELS[s.type]}${s.name === def ? ' · default' : ''}`,
      detail: describeServer(s),
      target: s.name,
    });
  }
  if (opts.groups !== false && project.config.groups.length) {
    items.push({ label: 'Groups', kind: vscode.QuickPickItemKind.Separator, target: '' });
    for (const g of project.config.groups) {
      items.push({ label: `$(server-environment) ${g.name}`, description: `${g.servers.join(', ')}${g.name === def ? ' · default' : ''}`, target: g.name });
    }
  }
  if (!items.length) {
    const add = await vscode.window.showInformationMessage('No deployment servers are configured.', 'Add Server');
    if (add) {
      await vscode.commands.executeCommand('deploy.configuration');
    }
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose server or group' });
  return picked ? resolveTarget(project.config, picked.target) : undefined;
}

export async function pickServer(project: Project, title: string, filter?: (s: Server) => boolean): Promise<Server | undefined> {
  const r = await pickTarget(project, title, { groups: false, filter });
  return r?.[0];
}

/** The default server/group, or ask to choose one when none is set. */
export async function defaultTargets(project: Project): Promise<Server[] | undefined> {
  const targets = project.defaultTargets();
  if (targets.length) {
    return targets;
  }
  const answer = await vscode.window.showWarningMessage(
    'Default server or group of servers is not configured.',
    'Choose Default Server',
    'Configure…',
  );
  if (answer === 'Choose Default Server') {
    await vscode.commands.executeCommand('deploy.selectDefaultServer', project);
    return project.defaultTargets().length ? project.defaultTargets() : undefined;
  }
  if (answer) {
    await vscode.commands.executeCommand('deploy.configuration');
  }
  return undefined;
}

interface BitItem extends vscode.QuickPickItem {
  bit: number;
}

/** Change Permissions dialog: Owner/Group/Others × R/W/X, or octal. */
export async function pickPermissions(current: number | undefined, name: string): Promise<number | undefined> {
  const mode = current ?? 0o644;
  const labels = ['Owner', 'Group', 'Others'];
  const perms = ['Read', 'Write', 'Execute'];
  const items: BitItem[] = [];
  for (let who = 0; who < 3; who++) {
    items.push({ label: labels[who], kind: vscode.QuickPickItemKind.Separator, bit: 0 });
    for (let p = 0; p < 3; p++) {
      const bit = 1 << (8 - who * 3 - p);
      items.push({ label: `${labels[who]}: ${perms[p]}`, bit, picked: (mode & bit) !== 0 });
    }
  }
  const qp = vscode.window.createQuickPick<BitItem>();
  qp.title = `Change Permissions — ${name}`;
  qp.canSelectMany = true;
  qp.items = items;
  qp.selectedItems = items.filter((i) => i.picked);
  qp.placeholder = 'Toggle permissions, or type an octal value (e.g. 755) and press Enter';
  const update = (): void => {
    const bits = qp.selectedItems.reduce((a, i) => a | i.bit, mode & ~0o777);
    qp.title = `Change Permissions — ${name}: ${formatMode(bits)} (${(bits & 0o7777).toString(8).padStart(3, '0')})`;
  };
  qp.onDidChangeSelection(update);
  update();
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      const typed = qp.value.trim();
      done = true;
      if (/^[0-7]{3,4}$/.test(typed)) {
        resolve(parseInt(typed, 8));
      } else {
        resolve(qp.selectedItems.reduce((a, i) => a | i.bit, mode & ~0o777));
      }
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) {
        resolve(undefined);
      }
      qp.dispose();
    });
    qp.show();
  });
}
