import { execFileSync } from 'node:child_process';
import { serviceName } from './postgres-service.mjs';

if (process.platform !== 'win32') {
  throw new Error('Use the platform service manager to stop native PostgreSQL.');
}

execFileSync('sc.exe', ['stop', serviceName], { encoding: 'utf8' });
console.log('Local PostgreSQL service stopped.');
