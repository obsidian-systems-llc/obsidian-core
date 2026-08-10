import 'dotenv/config';

import { buildApp } from './app.js';
import { createAuth0TokenVerifier, loadAuth0Config } from './auth0.js';
import { PostgresAuthorizer } from './authorization.js';
import { loadEnvironment } from './env.js';
import { PostgresOrganizationRepository } from './organizations.js';
import { loadFieldEncryptor } from './encryption.js';
import { PostgresCustomerRepository } from './customers.js';
import { PostgresEmployeeRepository } from './employees.js';
import { PostgresTimekeepingRepository } from './timekeeping.js';
import { PostgresQuoteRepository } from './quotes.js';
import { PostgresJobRepository } from './jobs.js';
import { PostgresSubscriptionPlanRepository } from './subscriptions.js';
import { PostgresReportingRepository } from './reporting.js';
import { PostgresCompensationRepository } from './compensation.js';

const environment = loadEnvironment();
const fieldEncryptor = loadFieldEncryptor(environment);
const timekeepingRepository = new PostgresTimekeepingRepository(environment.DATABASE_URL);
const app = buildApp({
  databaseUrl: environment.DATABASE_URL,
  authorizer: new PostgresAuthorizer(environment.DATABASE_URL),
  organizationRepository: new PostgresOrganizationRepository(environment.DATABASE_URL),
  customerRepository: new PostgresCustomerRepository(environment.DATABASE_URL, fieldEncryptor),
  employeeRepository: new PostgresEmployeeRepository(environment.DATABASE_URL, fieldEncryptor),
  timekeepingRepository,
  mobileTimekeepingRepository: timekeepingRepository,
  quoteRepository: new PostgresQuoteRepository(environment.DATABASE_URL),
  jobRepository: new PostgresJobRepository(environment.DATABASE_URL),
  subscriptionPlanRepository: new PostgresSubscriptionPlanRepository(environment.DATABASE_URL),
  reportingRepository: new PostgresReportingRepository(environment.DATABASE_URL),
  compensationRepository: new PostgresCompensationRepository(environment.DATABASE_URL),
  apiSecurity: {
    allowedOrigins:
      environment.API_ALLOWED_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ?? [],
    sensitiveRateLimitMax: environment.API_SENSITIVE_RATE_LIMIT_MAX,
    sensitiveRateLimitWindowMs: environment.API_SENSITIVE_RATE_LIMIT_WINDOW_MS,
    stepUpClaim: environment.AUTH0_STEP_UP_CLAIM,
    stepUpValue: environment.AUTH0_STEP_UP_VALUE,
  },
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
