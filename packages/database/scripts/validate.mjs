import { access } from 'node:fs/promises';
await access(new URL('../migrations/', import.meta.url));
console.log('Database migration directory is present.');
