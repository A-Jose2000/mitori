import { PostgresClient } from './postgresClient.js';
import type {
  DatabaseColumn,
  DatabaseForeignKey,
  DatabaseIndex,
  DatabaseSchema,
  DatabaseTable,
  TableMetadata,
  TablePreview,
  TableRelationships,
} from './types.js';
import { quoteIdentifier } from '../utils/identifiers.js';

export class PostgresIntrospection {
  constructor(private readonly client: PostgresClient) {}

  async getSchemas(): Promise<DatabaseSchema[]> {
    const result = await this.client.query<{ name: string }>(`
      select n.nspname as name
      from pg_catalog.pg_namespace n
      where n.nspname <> 'information_schema'
        and n.nspname not like 'pg_%'
      order by n.nspname
    `);

    return result.rows.map((row) => ({ name: row.name }));
  }

  async getTables(schemaName: string): Promise<DatabaseTable[]> {
    const result = await this.client.query<{ schema_name: string; name: string; estimated_row_count: string | null }>(
      `
        select
          n.nspname as schema_name,
          c.relname as name,
          case
            when c.reltuples >= 0 then greatest(round(c.reltuples)::bigint, 0)::text
            else null
          end as estimated_row_count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relkind in ('r', 'p')
        order by c.relname
      `,
      [schemaName],
    );

    return result.rows.map((row) => ({
      schema: row.schema_name,
      name: row.name,
      estimatedRowCount: parseOptionalInteger(row.estimated_row_count),
    }));
  }

  async getAllTables(): Promise<DatabaseTable[]> {
    const result = await this.client.query<{ schema_name: string; name: string; estimated_row_count: string | null }>(
      `
        select
          n.nspname as schema_name,
          c.relname as name,
          case
            when c.reltuples >= 0 then greatest(round(c.reltuples)::bigint, 0)::text
            else null
          end as estimated_row_count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname <> 'information_schema'
          and n.nspname not like 'pg_%'
          and c.relkind in ('r', 'p')
        order by n.nspname, c.relname
      `,
    );

    return result.rows.map((row) => ({
      schema: row.schema_name,
      name: row.name,
      estimatedRowCount: parseOptionalInteger(row.estimated_row_count),
    }));
  }

  async getColumns(schemaName: string, tableName: string): Promise<DatabaseColumn[]> {
    const [columnsResult, primaryKeys, foreignKeys] = await Promise.all([
      this.client.query<{
        column_name: string;
        data_type: string;
        column_default: string | null;
        identity_generation: string | null;
        generated_kind: string | null;
        collation_schema: string | null;
        collation_name: string | null;
        is_nullable: boolean;
        ordinal_position: number;
      }>(
        `
          select
            a.attname as column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
            pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) as column_default,
            case a.attidentity
              when 'a' then 'ALWAYS'
              when 'd' then 'BY DEFAULT'
              else null
            end as identity_generation,
            case a.attgenerated
              when 's' then 'STORED'
              when 'v' then 'VIRTUAL'
              else null
            end as generated_kind,
            collation_namespace.nspname as collation_schema,
            coll.collname as collation_name,
            not a.attnotnull as is_nullable,
            a.attnum as ordinal_position
          from pg_catalog.pg_attribute a
          join pg_catalog.pg_class c on c.oid = a.attrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          join pg_catalog.pg_type t on t.oid = a.atttypid
          left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          left join pg_catalog.pg_collation coll
            on coll.oid = a.attcollation
            and a.attcollation <> t.typcollation
            and a.attcollation <> 0
          left join pg_catalog.pg_namespace collation_namespace on collation_namespace.oid = coll.collnamespace
          where n.nspname = $1
            and c.relname = $2
            and c.relkind in ('r', 'p')
            and a.attnum > 0
            and not a.attisdropped
          order by a.attnum
        `,
        [schemaName, tableName],
      ),
      this.getPrimaryKeys(schemaName, tableName),
      this.getForeignKeys(schemaName, tableName),
    ]);

    const primaryKeyColumns = new Set(primaryKeys);
    const foreignKeyByColumn = new Map(foreignKeys.map((foreignKey) => [foreignKey.columnName, foreignKey]));
    const foreignKeyConstraintColumnCounts = countForeignKeyConstraintColumns(foreignKeys);

    return columnsResult.rows.map((row) => {
      const foreignKey = foreignKeyByColumn.get(row.column_name);
      const isPrimaryKey = primaryKeyColumns.has(row.column_name);
      const singleColumnForeignKey =
        foreignKey && foreignKeyConstraintColumnCounts.get(foreignKey.constraintName) === 1 ? foreignKey : undefined;

      return {
        schema: schemaName,
        table: tableName,
        name: row.column_name,
        dataType: row.data_type,
        sqlDefinition: buildColumnSqlDefinition({
          name: row.column_name,
          dataType: row.data_type,
          defaultExpression: row.column_default,
          identityGeneration: normalizeIdentityGeneration(row.identity_generation),
          generatedKind: normalizeGeneratedKind(row.generated_kind),
          collationSchema: row.collation_schema,
          collationName: row.collation_name,
          isNullable: row.is_nullable,
          isSingleColumnPrimaryKey: primaryKeyColumns.size === 1 && isPrimaryKey,
          singleColumnForeignKey,
        }),
        isNullable: row.is_nullable,
        isPrimaryKey,
        foreignKey: foreignKey
          ? {
              referencedSchema: foreignKey.referencedSchema,
              referencedTable: foreignKey.referencedTable,
              referencedColumn: foreignKey.referencedColumn,
            }
          : undefined,
      };
    });
  }

  async getPrimaryKeys(schemaName: string, tableName: string): Promise<string[]> {
    const result = await this.client.query<{ column_name: string }>(
      `
        select a.attname as column_name
        from pg_catalog.pg_index i
        join pg_catalog.pg_class c on c.oid = i.indrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
        where n.nspname = $1
          and c.relname = $2
          and i.indisprimary
        order by a.attnum
      `,
      [schemaName, tableName],
    );

    return result.rows.map((row) => row.column_name);
  }

  async getForeignKeys(schemaName: string, tableName: string): Promise<DatabaseForeignKey[]> {
    const result = await this.client.query<{
      constraint_name: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
    }>(
      `
        select
          con.conname as constraint_name,
          source_namespace.nspname as source_schema,
          source_class.relname as source_table,
          source_attribute.attname as column_name,
          target_namespace.nspname as referenced_schema,
          target_class.relname as referenced_table,
          target_attribute.attname as referenced_column
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class source_class on source_class.oid = con.conrelid
        join pg_catalog.pg_namespace source_namespace on source_namespace.oid = source_class.relnamespace
        join pg_catalog.pg_class target_class on target_class.oid = con.confrelid
        join pg_catalog.pg_namespace target_namespace on target_namespace.oid = target_class.relnamespace
        join unnest(con.conkey) with ordinality as source_columns(attnum, ord) on true
        join unnest(con.confkey) with ordinality as target_columns(attnum, ord) on target_columns.ord = source_columns.ord
        join pg_catalog.pg_attribute source_attribute on source_attribute.attrelid = con.conrelid and source_attribute.attnum = source_columns.attnum
        join pg_catalog.pg_attribute target_attribute on target_attribute.attrelid = con.confrelid and target_attribute.attnum = target_columns.attnum
        where con.contype = 'f'
          and source_namespace.nspname = $1
          and source_class.relname = $2
        order by con.conname, source_columns.ord
      `,
      [schemaName, tableName],
    );

    return result.rows.map((row) => ({
      constraintName: row.constraint_name,
      schema: schemaName,
      table: tableName,
      columnName: row.column_name,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    }));
  }

  async getInboundForeignKeys(schemaName: string, tableName: string): Promise<DatabaseForeignKey[]> {
    const result = await this.client.query<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
    }>(
      `
        select
          con.conname as constraint_name,
          source_namespace.nspname as source_schema,
          source_class.relname as source_table,
          source_attribute.attname as column_name,
          target_namespace.nspname as referenced_schema,
          target_class.relname as referenced_table,
          target_attribute.attname as referenced_column
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class source_class on source_class.oid = con.conrelid
        join pg_catalog.pg_namespace source_namespace on source_namespace.oid = source_class.relnamespace
        join pg_catalog.pg_class target_class on target_class.oid = con.confrelid
        join pg_catalog.pg_namespace target_namespace on target_namespace.oid = target_class.relnamespace
        join unnest(con.conkey) with ordinality as source_columns(attnum, ord) on true
        join unnest(con.confkey) with ordinality as target_columns(attnum, ord) on target_columns.ord = source_columns.ord
        join pg_catalog.pg_attribute source_attribute on source_attribute.attrelid = con.conrelid and source_attribute.attnum = source_columns.attnum
        join pg_catalog.pg_attribute target_attribute on target_attribute.attrelid = con.confrelid and target_attribute.attnum = target_columns.attnum
        where con.contype = 'f'
          and target_namespace.nspname = $1
          and target_class.relname = $2
        order by source_namespace.nspname, source_class.relname, con.conname, source_columns.ord
      `,
      [schemaName, tableName],
    );

    return result.rows.map((row) => ({
      constraintName: row.constraint_name,
      schema: row.source_schema,
      table: row.source_table,
      columnName: row.column_name,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    }));
  }

  async getAllForeignKeys(): Promise<DatabaseForeignKey[]> {
    const result = await this.client.query<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
    }>(
      `
        select
          con.conname as constraint_name,
          source_namespace.nspname as source_schema,
          source_class.relname as source_table,
          source_attribute.attname as column_name,
          target_namespace.nspname as referenced_schema,
          target_class.relname as referenced_table,
          target_attribute.attname as referenced_column
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class source_class on source_class.oid = con.conrelid
        join pg_catalog.pg_namespace source_namespace on source_namespace.oid = source_class.relnamespace
        join pg_catalog.pg_class target_class on target_class.oid = con.confrelid
        join pg_catalog.pg_namespace target_namespace on target_namespace.oid = target_class.relnamespace
        join unnest(con.conkey) with ordinality as source_columns(attnum, ord) on true
        join unnest(con.confkey) with ordinality as target_columns(attnum, ord) on target_columns.ord = source_columns.ord
        join pg_catalog.pg_attribute source_attribute on source_attribute.attrelid = con.conrelid and source_attribute.attnum = source_columns.attnum
        join pg_catalog.pg_attribute target_attribute on target_attribute.attrelid = con.confrelid and target_attribute.attnum = target_columns.attnum
        where con.contype = 'f'
          and source_namespace.nspname <> 'information_schema'
          and source_namespace.nspname not like 'pg_%'
          and target_namespace.nspname <> 'information_schema'
          and target_namespace.nspname not like 'pg_%'
        order by source_namespace.nspname, source_class.relname, con.conname, source_columns.ord
      `,
    );

    return result.rows.map((row) => ({
      constraintName: row.constraint_name,
      schema: row.source_schema,
      table: row.source_table,
      columnName: row.column_name,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    }));
  }

  async getIndexes(schemaName: string, tableName: string): Promise<DatabaseIndex[]> {
    const result = await this.client.query<{
      schemaname: string;
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(
      `
        select schemaname, tablename, indexname, indexdef
        from pg_catalog.pg_indexes
        where schemaname = $1
          and tablename = $2
        order by indexname
      `,
      [schemaName, tableName],
    );

    return result.rows.map((row) => ({
      schema: row.schemaname,
      table: row.tablename,
      name: row.indexname,
      definition: row.indexdef,
    }));
  }

  async getTableMetadata(schemaName: string, tableName: string): Promise<TableMetadata> {
    const [columns, indexes, relationships] = await Promise.all([
      this.getColumns(schemaName, tableName),
      this.getIndexes(schemaName, tableName),
      this.getTableRelationships(schemaName, tableName),
    ]);

    return {
      table: {
        schema: schemaName,
        name: tableName,
      },
      columns,
      indexes,
      relationships,
    };
  }

  async getTableRelationships(schemaName: string, tableName: string): Promise<TableRelationships> {
    const [outbound, inbound] = await Promise.all([
      this.getForeignKeys(schemaName, tableName),
      this.getInboundForeignKeys(schemaName, tableName),
    ]);

    return {
      outbound,
      inbound,
    };
  }

  async getTablePreview(schemaName: string, tableName: string, limit: number): Promise<TablePreview> {
    await this.assertKnownTable(schemaName, tableName);

    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.client.query(
      `select * from ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} limit $1`,
      [safeLimit],
    );

    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows,
      limit: safeLimit,
    };
  }

  private async assertKnownTable(schemaName: string, tableName: string): Promise<void> {
    const result = await this.client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1
            and c.relname = $2
            and c.relkind in ('r', 'p')
        ) as exists
      `,
      [schemaName, tableName],
    );

    if (!result.rows[0]?.exists) {
      throw new Error('Table was not found in the connected database.');
    }
  }
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function countForeignKeyConstraintColumns(foreignKeys: DatabaseForeignKey[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const foreignKey of foreignKeys) {
    counts.set(foreignKey.constraintName, (counts.get(foreignKey.constraintName) ?? 0) + 1);
  }

  return counts;
}

function buildColumnSqlDefinition(input: {
  name: string;
  dataType: string;
  defaultExpression: string | null;
  identityGeneration: 'ALWAYS' | 'BY DEFAULT' | undefined;
  generatedKind: 'STORED' | 'VIRTUAL' | undefined;
  collationSchema: string | null;
  collationName: string | null;
  isNullable: boolean;
  isSingleColumnPrimaryKey: boolean;
  singleColumnForeignKey: DatabaseForeignKey | undefined;
}): string {
  const parts = [quoteIdentifier(input.name), input.dataType];

  if (input.collationSchema && input.collationName) {
    parts.push(`COLLATE ${formatQualifiedIdentifier(input.collationSchema, input.collationName)}`);
  }

  if (input.identityGeneration) {
    parts.push(`GENERATED ${input.identityGeneration} AS IDENTITY`);
  } else if (input.generatedKind && input.defaultExpression) {
    parts.push(`GENERATED ALWAYS AS (${input.defaultExpression}) ${input.generatedKind}`);
  } else if (input.defaultExpression) {
    parts.push(`DEFAULT ${input.defaultExpression}`);
  }

  if (!input.isNullable) {
    parts.push('NOT NULL');
  }

  if (input.isSingleColumnPrimaryKey) {
    parts.push('PRIMARY KEY');
  }

  if (input.singleColumnForeignKey) {
    parts.push(
      `REFERENCES ${formatQualifiedIdentifier(
        input.singleColumnForeignKey.referencedSchema,
        input.singleColumnForeignKey.referencedTable,
      )}(${quoteIdentifier(input.singleColumnForeignKey.referencedColumn)})`,
    );
  }

  return parts.join(' ');
}

function normalizeIdentityGeneration(value: string | null): 'ALWAYS' | 'BY DEFAULT' | undefined {
  return value === 'ALWAYS' || value === 'BY DEFAULT' ? value : undefined;
}

function normalizeGeneratedKind(value: string | null): 'STORED' | 'VIRTUAL' | undefined {
  return value === 'STORED' || value === 'VIRTUAL' ? value : undefined;
}

function formatQualifiedIdentifier(...identifiers: string[]): string {
  return identifiers.map((identifier) => quoteIdentifier(identifier)).join('.');
}
