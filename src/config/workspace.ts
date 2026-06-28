import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}

export function resolveWorkspacePath(root: string, ...segments: string[]): string {
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved path is outside of the workspace.');
  }

  return candidate;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function findWorkspaceFile(root: string, fileName: string): Promise<string | undefined> {
  const filePath = resolveWorkspacePath(root, fileName);
  return (await fileExists(filePath)) ? filePath : undefined;
}
