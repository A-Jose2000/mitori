import * as fs from 'node:fs/promises';
import { parse } from 'dotenv';

import type { DatabaseConnectionDescription } from '../db/types.js';
import { findWorkspaceFile } from './workspace.js';

export type DatabaseConfigResult =
  | {
      kind: 'noWorkspace';
      message: string;
    }
  | {
      kind: 'missingEnv';
      message: string;
    }
  | {
      kind: 'missingDatabaseUrl';
      message: string;
    }
  | {
      kind: 'found';
      databaseUrl: string;
      description: DatabaseConnectionDescription;
    };

export async function loadDatabaseConfig(workspaceRoot: string | undefined): Promise<DatabaseConfigResult> {
  if (!workspaceRoot) {
    return {
      kind: 'noWorkspace',
      message: 'Open a workspace to use Mitori.',
    };
  }

  const envPath = await findWorkspaceFile(workspaceRoot, '.env');

  if (!envPath) {
    return {
      kind: 'missingEnv',
      message: 'No .env file found. Add DATABASE_URL to connect Mitori.',
    };
  }

  const envContents = await fs.readFile(envPath, 'utf8');
  const parsed = parse(envContents);
  const databaseUrl = parsed.DATABASE_URL?.trim();

  if (!databaseUrl) {
    return {
      kind: 'missingDatabaseUrl',
      message: 'No DATABASE_URL found in .env.',
    };
  }

  return {
    kind: 'found',
    databaseUrl,
    description: describeDatabaseUrl(databaseUrl),
  };
}

function describeDatabaseUrl(databaseUrl: string): DatabaseConnectionDescription {
  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'unknown database';
    const host = url.hostname || 'unknown host';
    const user = url.username ? decodeURIComponent(url.username) : undefined;
    const port = url.port || undefined;

    return {
      databaseName,
      host,
      port,
      user,
    };
  } catch {
    return {
      databaseName: 'unknown database',
      host: 'unknown host',
    };
  }
}
