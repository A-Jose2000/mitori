export interface DatabaseConnectionDescription {
  databaseName: string;
  host: string;
  port?: string;
  user?: string;
}

export interface DatabaseSchema {
  name: string;
}

export interface DatabaseTable {
  schema: string;
  name: string;
  estimatedRowCount?: number;
}

export interface ForeignKeyReference {
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface DatabaseForeignKey extends ForeignKeyReference {
  schema: string;
  table: string;
  columnName: string;
  constraintName: string;
}

export interface DatabaseColumn {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  sqlDefinition: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  foreignKey?: ForeignKeyReference;
}

export interface DatabaseIndex {
  schema: string;
  table: string;
  name: string;
  definition: string;
}

export interface TableMetadata {
  table: DatabaseTable;
  columns: DatabaseColumn[];
  indexes: DatabaseIndex[];
  relationships: TableRelationships;
}

export interface TablePreview {
  columns: string[];
  rows: Record<string, unknown>[];
  limit: number;
}

export interface TableRelationships {
  outbound: DatabaseForeignKey[];
  inbound: DatabaseForeignKey[];
}
