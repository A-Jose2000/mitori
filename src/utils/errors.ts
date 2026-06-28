export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }

  if (typeof error === 'string') {
    return redactSensitiveText(error);
  }

  return 'An unknown error occurred.';
}

export function getFriendlyConnectionError(): string {
  return 'Could not connect to PostgreSQL. Check DATABASE_URL, database status, username, password, and port.';
}

function redactSensitiveText(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[redacted DATABASE_URL]');
}
