import 'dotenv/config';

import { buildApp } from './app.js';
import { loadEnvironment } from './env.js';

const environment = loadEnvironment();
const app = buildApp(environment.DATABASE_URL);
async function start(): Promise<void> {
  try {
    await app.listen({ host: environment.CORE_API_HOST, port: environment.CORE_API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
void start();
