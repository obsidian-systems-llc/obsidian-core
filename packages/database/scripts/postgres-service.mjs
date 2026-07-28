import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const serviceName = 'postgresql-x64-17';
const defaultBinDirectory = 'C:\\Program Files\\PostgreSQL\\17\\bin';

export function postgresCommand(command) {
  const binDirectory = process.env.POSTGRES_BIN ?? defaultBinDirectory;
  const executable = join(binDirectory, process.platform === 'win32' ? `${command}.exe` : command);

  if (!existsSync(executable)) {
    throw new Error(
      `PostgreSQL executable not found at ${executable}. Set POSTGRES_BIN or install PostgreSQL 17.`,
    );
  }

  return executable;
}

export function runPostgres(args) {
  return execFileSync(postgresCommand('pg_isready'), args, { encoding: 'utf8' });
}

export function ensureWindowsServiceIsRunning() {
  if (process.platform !== 'win32') return;

  const status = execFileSync('sc.exe', ['query', serviceName], { encoding: 'utf8' });
  if (!status.includes('RUNNING')) {
    try {
      execFileSync('sc.exe', ['start', serviceName], { encoding: 'utf8' });
    } catch (error) {
      const details = error && typeof error === 'object' && 'stdout' in error ? error.stdout : '';
      if (!String(details).includes('1056')) throw error;
    }
  }
}

export { serviceName };
