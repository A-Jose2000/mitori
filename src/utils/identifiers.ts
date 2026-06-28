export function quoteIdentifier(identifier: string): string {
  validateDatabaseIdentifier(identifier);
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function validateDatabaseIdentifier(identifier: string): void {
  if (!identifier || identifier.includes('\0')) {
    throw new Error('Invalid database identifier.');
  }
}
