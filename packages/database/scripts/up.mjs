import { ensureWindowsServiceIsRunning, runPostgres } from './postgres-service.mjs';

ensureWindowsServiceIsRunning();
runPostgres([
  '--host',
  '127.0.0.1',
  '--port',
  '5432',
  '--username',
  'postgres',
  '--dbname',
  'obsidian_core',
]);
console.log('Local PostgreSQL is ready on 127.0.0.1:5432.');
