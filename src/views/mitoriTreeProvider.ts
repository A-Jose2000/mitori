import * as vscode from 'vscode';

import { PostgresIntrospection } from '../db/introspection.js';
import type {
  DatabaseColumn,
  DatabaseConnectionDescription,
  DatabaseSchema,
  DatabaseTable,
} from '../db/types.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface MitoriConnectionState {
  status: ConnectionStatus;
  message?: string;
  description?: DatabaseConnectionDescription;
}

export type MitoriNode =
  | { kind: 'connectionRoot' }
  | { kind: 'schemasRoot' }
  | { kind: 'connectionStatus'; state: MitoriConnectionState }
  | { kind: 'message'; message: string }
  | { kind: 'schema'; schema: DatabaseSchema }
  | { kind: 'table'; table: DatabaseTable }
  | { kind: 'column'; column: DatabaseColumn };

export class MitoriTreeProvider implements vscode.TreeDataProvider<MitoriNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MitoriNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private introspection: PostgresIntrospection | undefined;
  private connectionState: MitoriConnectionState = {
    status: 'idle',
    message: 'Open a workspace to use Mitori.',
  };

  setIntrospection(introspection: PostgresIntrospection | undefined): void {
    this.introspection = introspection;
    this.refresh();
  }

  setConnectionState(state: MitoriConnectionState): void {
    this.connectionState = state;
    this.refresh();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTableFromNode(node: MitoriNode | undefined): DatabaseTable | undefined {
    return node?.kind === 'table' ? node.table : undefined;
  }

  getReferencedTableFromNode(node: MitoriNode | undefined): DatabaseTable | undefined {
    if (node?.kind !== 'column' || !node.column.foreignKey) {
      return undefined;
    }

    return {
      schema: node.column.foreignKey.referencedSchema,
      name: node.column.foreignKey.referencedTable,
    };
  }

  getTreeItem(element: MitoriNode): vscode.TreeItem {
    switch (element.kind) {
      case 'connectionRoot':
        return treeItem('Connection', vscode.TreeItemCollapsibleState.Expanded, 'plug');
      case 'schemasRoot':
        return treeItem('Schemas', vscode.TreeItemCollapsibleState.Expanded, 'database');
      case 'connectionStatus':
        return this.getConnectionStatusItem(element.state);
      case 'message':
        return this.getMessageItem(element.message);
      case 'schema':
        return treeItem(element.schema.name, vscode.TreeItemCollapsibleState.Collapsed, 'symbol-namespace');
      case 'table':
        return this.getTableItem(element);
      case 'column':
        return this.getColumnItem(element.column);
    }
  }

  async getChildren(element?: MitoriNode): Promise<MitoriNode[]> {
    if (!element) {
      return [{ kind: 'connectionRoot' }, { kind: 'schemasRoot' }];
    }

    if (element.kind === 'connectionRoot') {
      return this.getConnectionChildren();
    }

    if (element.kind === 'schemasRoot') {
      return this.getSchemaChildren();
    }

    if (element.kind === 'schema') {
      return this.getTableChildren(element.schema.name);
    }

    if (element.kind === 'table') {
      return this.getColumnChildren(element.table);
    }

    return [];
  }

  private getConnectionChildren(): MitoriNode[] {
    if (this.connectionState.status === 'connected') {
      return [{ kind: 'connectionStatus', state: this.connectionState }];
    }

    if (this.connectionState.status === 'connecting') {
      return [{ kind: 'message', message: 'Connecting to PostgreSQL...' }];
    }

    return [
      {
        kind: 'message',
        message: this.connectionState.message ?? 'Use Mitori: Connect to Database to connect.',
      },
    ];
  }

  private async getSchemaChildren(): Promise<MitoriNode[]> {
    if (this.connectionState.status === 'connecting') {
      return [{ kind: 'message', message: 'Connecting to PostgreSQL...' }];
    }

    if (this.connectionState.status !== 'connected' || !this.introspection) {
      return [
        {
          kind: 'message',
          message: this.connectionState.message ?? 'Connect to a PostgreSQL database.',
        },
      ];
    }

    try {
      const schemas = await this.introspection.getSchemas();

      if (schemas.length === 0) {
        return [{ kind: 'message', message: 'Connected, but no schemas were found.' }];
      }

      return schemas.map((schema) => ({ kind: 'schema', schema }));
    } catch {
      return [{ kind: 'message', message: 'Could not load schemas.' }];
    }
  }

  private async getTableChildren(schemaName: string): Promise<MitoriNode[]> {
    if (!this.introspection) {
      return [{ kind: 'message', message: 'Connect to a PostgreSQL database.' }];
    }

    try {
      const tables = await this.introspection.getTables(schemaName);

      if (tables.length === 0) {
        return [{ kind: 'message', message: 'Connected, but no tables were found.' }];
      }

      return tables.map((table) => ({ kind: 'table', table }));
    } catch {
      return [{ kind: 'message', message: 'Could not load tables.' }];
    }
  }

  private async getColumnChildren(table: DatabaseTable): Promise<MitoriNode[]> {
    if (!this.introspection) {
      return [{ kind: 'message', message: 'Connect to a PostgreSQL database.' }];
    }

    try {
      const columns = await this.introspection.getColumns(table.schema, table.name);

      if (columns.length === 0) {
        return [{ kind: 'message', message: 'No columns found.' }];
      }

      return columns.map((column) => ({ kind: 'column', column }));
    } catch {
      return [{ kind: 'message', message: 'Could not load columns.' }];
    }
  }

  private getConnectionStatusItem(state: MitoriConnectionState): vscode.TreeItem {
    const databaseName = state.description?.databaseName ?? 'database';
    const item = treeItem(`Connected: ${databaseName}`, vscode.TreeItemCollapsibleState.None, 'circle-filled');
    item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));

    if (state.description) {
      const details = [
        `Database: ${state.description.databaseName}`,
        `Host: ${state.description.host}`,
        state.description.port ? `Port: ${state.description.port}` : undefined,
        state.description.user ? `User: ${state.description.user}` : undefined,
      ].filter(Boolean);

      item.tooltip = details.join('\n');
    }

    return item;
  }

  private getMessageItem(message: string): vscode.TreeItem {
    const item = treeItem(message, vscode.TreeItemCollapsibleState.None, 'info');
    item.tooltip = message;
    return item;
  }

  private getTableItem(node: Extract<MitoriNode, { kind: 'table' }>): vscode.TreeItem {
    const item = treeItem(node.table.name, vscode.TreeItemCollapsibleState.Collapsed, 'table');
    item.contextValue = 'mitori.table';
    item.description = formatRowEstimate(node.table.estimatedRowCount);
    item.tooltip = [
      `${node.table.schema}.${node.table.name}`,
      node.table.estimatedRowCount === undefined ? undefined : `${formatNumber(node.table.estimatedRowCount)} estimated rows`,
    ]
      .filter(Boolean)
      .join('\n');
    item.command = {
      command: 'mitori.openTablePreview',
      title: 'Mitori: Open Table Preview',
      arguments: [node],
    };

    return item;
  }

  private getColumnItem(column: DatabaseColumn): vscode.TreeItem {
    const label = formatColumnLabel(column);
    const icon = column.isPrimaryKey ? 'key' : column.foreignKey ? 'link' : 'symbol-field';
    const item = treeItem(label, vscode.TreeItemCollapsibleState.None, icon);
    item.tooltip = formatColumnTooltip(column);

    if (column.foreignKey) {
      item.contextValue = 'mitori.foreignKeyColumn';
      item.command = {
        command: 'mitori.openReferencedTablePreview',
        title: 'Mitori: Open Referenced Table',
        arguments: [{ kind: 'column', column } satisfies MitoriNode],
      };
    }

    return item;
  }
}

function treeItem(label: string, collapsibleState: vscode.TreeItemCollapsibleState, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, collapsibleState);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function formatColumnLabel(column: DatabaseColumn): string {
  const markers = [];

  if (column.isPrimaryKey) {
    markers.push('PK');
  }

  if (column.foreignKey) {
    markers.push(`FK \u2192 ${column.foreignKey.referencedTable}.${column.foreignKey.referencedColumn}`);
  }

  markers.push(column.isNullable ? 'nullable' : 'not null');

  return `${column.name} ${column.dataType} ${markers.join(' ')}`;
}

function formatColumnTooltip(column: DatabaseColumn): string {
  const lines = [
    `${column.schema}.${column.table}.${column.name}`,
    `Type: ${column.dataType}`,
    column.isNullable ? 'Nullable' : 'Not null',
    column.isPrimaryKey ? 'Primary key' : undefined,
    column.foreignKey
      ? `References: ${column.foreignKey.referencedSchema}.${column.foreignKey.referencedTable}.${column.foreignKey.referencedColumn}`
      : undefined,
  ];

  return lines.filter(Boolean).join('\n');
}

function formatRowEstimate(estimatedRowCount: number | undefined): string | undefined {
  if (estimatedRowCount === undefined) {
    return undefined;
  }

  return `~${formatNumber(estimatedRowCount)} rows`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
