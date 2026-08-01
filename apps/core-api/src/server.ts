import 'dotenv/config';

import { buildApp } from './app.js';
import { createAuth0TokenVerifier, loadAuth0Config } from './auth0.js';
import { PostgresAuthorizer } from './authorization.js';
import { loadEnvironment } from './env.js';
import { PostgresOrganizationRepository } from './organizations.js';
import { loadFieldEncryptor } from './encryption.js';
import { PostgresCustomerRepository } from './customers.js';
import { PostgresEmployeeRepository } from './employees.js';

const environment = loadEnvironment();
const fieldEncryptor = loadFieldEncryptor(environment);
const app = buildApp({
  databaseUrl: environment.DATABASE_URL,
  authorizer: new PostgresAuthorizer(environment.DATABASE_URL),
  organizationRepository: new PostgresOrganizationRepository(environment.DATABASE_URL),
  customerRepository: new PostgresCustomerRepository(environment.DATABASE_URL, fieldEncryptor),
  employeeRepository: new PostgresEmployeeRepository(environment.DATABASE_URL, fieldEncryptor),
  verifyToken: createAuth0TokenVerifier(loadAuth0Config(environment)),
});
async function start(): Promise<void> {
  try {
    await app.listen({ host: environment.CORE_API_HOST, port: environment.CORE_API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
void start();
