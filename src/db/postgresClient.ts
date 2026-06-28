import pg from 'pg';
import type { Pool as PgPool, QueryResult, QueryResultRow } from 'pg';

const { Pool } = pg;

export interface ConnectionTestResult {
  databaseName: string;
  currentSchema: string;
}

export class PostgresClient {
  private pool: PgPool | undefined;

  get isConnected(): boolean {
    return Boolean(this.pool);
  }

  async connect(databaseUrl: string): Promise<ConnectionTestResult> {
    await this.close();

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'mitori-vscode',
    });

    try {
      return await this.testConnection();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('PostgreSQL is not connected.');
    }

    return this.pool.query<T>(text, params as unknown[]);
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    const pool = this.pool;
    this.pool = undefined;
    await pool.end();
  }

  private async testConnection(): Promise<ConnectionTestResult> {
    const result = await this.query<{ database_name: string; current_schema: string }>(
      'select current_database() as database_name, current_schema() as current_schema',
    );
    const row = result.rows[0];

    return {
      databaseName: row?.database_name ?? 'unknown database',
      currentSchema: row?.current_schema ?? 'public',
    };
  }
}
