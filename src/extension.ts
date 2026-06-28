import * as vscode from 'vscode';

import { loadDatabaseConfig } from './config/envLoader.js';
import { getWorkspaceRoot } from './config/workspace.js';
import { PostgresIntrospection } from './db/introspection.js';
import { PostgresClient } from './db/postgresClient.js';
import type { DatabaseConnectionDescription } from './db/types.js';
import { getErrorMessage, getFriendlyConnectionError } from './utils/errors.js';
import { MitoriTreeProvider } from './views/mitoriTreeProvider.js';
import type { MitoriNode } from './views/mitoriTreeProvider.js';
import { openRelationshipMapWebview } from './views/relationshipMapWebview.js';
import { openTableWebview } from './views/tableWebview.js';

let postgresClient: PostgresClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  postgresClient = new PostgresClient();

  let introspection: PostgresIntrospection | undefined;
  const treeProvider = new MitoriTreeProvider();

  const connectToDatabase = async (showNotifications: boolean): Promise<void> => {
    treeProvider.setConnectionState({
      status: 'connecting',
      message: 'Connecting to PostgreSQL...',
    });

    const config = await loadDatabaseConfig(getWorkspaceRoot());

    if (config.kind !== 'found') {
      introspection = undefined;
      treeProvider.setIntrospection(undefined);
      treeProvider.setConnectionState({
        status: 'idle',
        message: config.message,
      });

      if (showNotifications) {
        vscode.window.showInformationMessage(config.message);
      }

      return;
    }

    try {
      const connectionResult = await postgresClient?.connect(config.databaseUrl);
      const description = withConnectedDatabaseName(config.description, connectionResult?.databaseName);

      introspection = new PostgresIntrospection(postgresClient!);
      treeProvider.setIntrospection(introspection);
      treeProvider.setConnectionState({
        status: 'connected',
        description,
      });

      if (showNotifications) {
        vscode.window.showInformationMessage(`Mitori connected to ${description.databaseName}.`);
      }
    } catch {
      introspection = undefined;
      treeProvider.setIntrospection(undefined);
      treeProvider.setConnectionState({
        status: 'error',
        message: getFriendlyConnectionError(),
      });

      if (showNotifications) {
        vscode.window.showErrorMessage(getFriendlyConnectionError());
      }
    }
  };

  const treeView = vscode.window.createTreeView('mitori.schemaView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('mitori.connect', async () => {
      await connectToDatabase(true);
    }),
    vscode.commands.registerCommand('mitori.refresh', async () => {
      if (introspection) {
        treeProvider.refresh();
        return;
      }

      await connectToDatabase(true);
    }),
    vscode.commands.registerCommand('mitori.openTablePreview', async (node?: MitoriNode) => {
      const table = treeProvider.getTableFromNode(node);

      if (!table) {
        vscode.window.showWarningMessage('Select a table from the Mitori sidebar to preview it.');
        return;
      }

      if (!introspection) {
        vscode.window.showWarningMessage('Connect Mitori to a PostgreSQL database first.');
        return;
      }

      try {
        await openTableWebview(context, introspection, table, { reuseActive: true });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not open table preview. ${getErrorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('mitori.openTablePreviewInNewTab', async (node?: MitoriNode) => {
      const table = treeProvider.getTableFromNode(node);

      if (!table) {
        vscode.window.showWarningMessage('Select a table from the Mitori sidebar to preview it.');
        return;
      }

      if (!introspection) {
        vscode.window.showWarningMessage('Connect Mitori to a PostgreSQL database first.');
        return;
      }

      try {
        await openTableWebview(context, introspection, table);
      } catch (error) {
        vscode.window.showErrorMessage(`Could not open table preview in a new tab. ${getErrorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('mitori.openReferencedTablePreview', async (node?: MitoriNode) => {
      const table = treeProvider.getReferencedTableFromNode(node);

      if (!table) {
        vscode.window.showWarningMessage('Select a foreign-key column from the Mitori sidebar.');
        return;
      }

      if (!introspection) {
        vscode.window.showWarningMessage('Connect Mitori to a PostgreSQL database first.');
        return;
      }

      try {
        await openTableWebview(context, introspection, table, { reuseActive: true });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not open referenced table. ${getErrorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('mitori.openRelationshipMap', async () => {
      if (!introspection) {
        vscode.window.showWarningMessage('Connect Mitori to a PostgreSQL database first.');
        return;
      }

      try {
        await openRelationshipMapWebview(context, introspection);
      } catch (error) {
        vscode.window.showErrorMessage(`Could not open relationship map. ${getErrorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('mitori.explain', () => {
      vscode.window.showInformationMessage(
        'Mitori is a read-only PostgreSQL visualizer for VS Code. It helps you see schemas, tables, columns, keys, relationships, and sample rows without leaving your editor.',
      );
    }),
  );

  void connectToDatabase(false);
}

export async function deactivate(): Promise<void> {
  await postgresClient?.close();
  postgresClient = undefined;
}

function withConnectedDatabaseName(
  description: DatabaseConnectionDescription,
  databaseName: string | undefined,
): DatabaseConnectionDescription {
  return {
    ...description,
    databaseName: databaseName || description.databaseName,
  };
}
