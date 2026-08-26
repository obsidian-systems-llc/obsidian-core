import 'dotenv/config';

import { buildApp } from './app.js';
import { createAuth0TokenVerifier, loadAuth0Config } from './auth0.js';
import { PostgresAuthorizer } from './authorization.js';
import { PostgresAuthorizationAdminRepository } from './authorization-admin.js';
import { loadEnvironment } from './env.js';
import { PostgresOrganizationRepository } from './organizations.js';
import { loadFieldEncryptor } from './encryption.js';
import { PostgresCustomerRepository } from './customers.js';
import { PostgresCustomerAdministrationRepository } from './customer-admin.js';
import { PostgresCustomerWorkRoutingRepository } from './customer-work-routing.js';
import { PostgresEmployeeRepository } from './employees.js';
import { PostgresEmployeeAdministrationRepository } from './employee-admin.js';
import { PostgresTimekeepingRepository } from './timekeeping.js';
import { PostgresQuoteRepository } from './quotes.js';
import { PostgresJobRepository } from './jobs.js';
import { PostgresSubscriptionPlanRepository } from './subscriptions.js';
import { PostgresReportingRepository } from './reporting.js';
import { PostgresCompensationRepository } from './compensation.js';
import {
  loadPaymentProcessorConfiguration,
  loadSquareAdapterConfiguration,
  loadSquareDeviceCareConfiguration,
  loadSquareWebhookConfiguration,
  loadStripeDeviceCareConfiguration,
  loadStripeWebhookConfiguration,
  PostgresPaymentRepository,
  SquarePaymentProvider,
  StripePaymentProvider,
} from './payments.js';
import {
  PostgresDeviceCareRepository,
  SquareDeviceCareProvider,
  StripeDeviceCareProvider,
} from './device-care.js';
import { PostgresDeviceCareWalletRepository } from './device-care-wallet.js';
import { PostgresDeviceCareEntitlementRepository } from './device-care-entitlements.js';
import { PostgresPublicDeviceCareOfferRepository } from './public-device-care-offer.js';
import { PostgresRetellCallRepository } from './retell.js';
import { loadResendEmailConfiguration, PostgresCustomerEmailOutbox } from './customer-email.js';
import { PostgresAccountInvitationRepository } from './account-invitations.js';
import {
  createCompositeTokenVerifier,
  createCoreIdentityTokenVerifier,
  loadCoreIdentityConfiguration,
  PostgresCoreIdentityEmailOutbox,
  PostgresCoreIdentityRepository,
} from './core-identity.js';

const environment = loadEnvironment();
const emailConfiguration = loadResendEmailConfiguration(process.env);
const coreIdentityConfiguration = loadCoreIdentityConfiguration(process.env);
const coreIdentityRepository = coreIdentityConfiguration
  ? new PostgresCoreIdentityRepository(
      environment.DATABASE_URL,
      loadFieldEncryptor(environment),
      coreIdentityConfiguration,
    )
  : undefined;
const coreIdentityEmailOutbox =
  coreIdentityConfiguration && emailConfiguration
    ? new PostgresCoreIdentityEmailOutbox(
        environment.DATABASE_URL,
        coreIdentityConfiguration,
        emailConfiguration,
      )
    : undefined;
const customerEmailOutbox =
  environment.CUSTOMER_EMAIL_ENABLED && emailConfiguration
    ? new PostgresCustomerEmailOutbox(environment.DATABASE_URL, emailConfiguration)
    : undefined;
const fieldEncryptor = loadFieldEncryptor(environment);
const accountInvitationRepository = environment.STAFF_INVITATIONS_ENABLED
  ? new PostgresAccountInvitationRepository(
      environment.DATABASE_URL,
      fieldEncryptor,
      emailConfiguration!,
      environment.INVITATION_ACCEPT_URL!,
    )
  : undefined;
const timekeepingRepository = new PostgresTimekeepingRepository(environment.DATABASE_URL);
const paymentConfiguration = environment.PAYMENTS_ENABLED
  ? loadPaymentProcessorConfiguration(process.env)
  : undefined;
if (paymentConfiguration?.processor === 'worldpay')
  throw new Error(
    'Worldpay/Commerce360 payment processing is disabled pending provider verification.',
  );
const paymentRepository = paymentConfiguration
  ? new PostgresPaymentRepository(
      environment.DATABASE_URL,
      paymentConfiguration.processor === 'square'
        ? new SquarePaymentProvider(paymentConfiguration.configuration)
        : new StripePaymentProvider(paymentConfiguration.configuration),
      paymentConfiguration.processor,
    )
  : undefined;
const squareDeviceCareConfiguration = loadSquareDeviceCareConfiguration(process.env);
const squareAdapterConfiguration = (() => {
  if (!environment.PAYMENTS_ENABLED || !squareDeviceCareConfiguration) return undefined;
  try {
    return paymentConfiguration?.processor === 'square'
      ? paymentConfiguration.configuration
      : loadSquareAdapterConfiguration(process.env);
  } catch (error) {
    // A Stripe deployment may retain historical Square agreements. Do not prevent startup when
    // their retired Square credentials have been removed; cancellation returns a stable Core error.
    console.warn('Square legacy Device Care cancellation is unavailable.', {
      message: error instanceof Error ? error.message : 'Unknown configuration error.',
    });
    return undefined;
  }
})();
const squareDeviceCareProvider =
  squareAdapterConfiguration && squareDeviceCareConfiguration
    ? new SquareDeviceCareProvider(squareAdapterConfiguration, squareDeviceCareConfiguration)
    : undefined;
const deviceCareRepository =
  paymentConfiguration?.processor === 'square' &&
  squareDeviceCareProvider &&
  squareDeviceCareConfiguration
    ? new PostgresDeviceCareRepository(
        environment.DATABASE_URL,
        squareDeviceCareProvider,
        squareDeviceCareConfiguration.environment,
      )
    : undefined;
const stripeDeviceCareConfiguration =
  paymentConfiguration?.processor === 'stripe'
    ? loadStripeDeviceCareConfiguration(process.env)
    : undefined;
const stripeDeviceCareRepository =
  paymentConfiguration?.processor === 'stripe' && stripeDeviceCareConfiguration
    ? new PostgresDeviceCareRepository(
        environment.DATABASE_URL,
        new StripeDeviceCareProvider(
          paymentConfiguration.configuration,
          stripeDeviceCareConfiguration,
        ),
        stripeDeviceCareConfiguration.environment,
        'stripe',
        squareDeviceCareProvider && squareDeviceCareConfiguration
          ? [
              {
                adapter: squareDeviceCareProvider,
                environment: squareDeviceCareConfiguration.environment,
                provider: 'square',
              },
            ]
          : [],
      )
    : undefined;
const squareWebhooks = {
  sandbox: loadSquareWebhookConfiguration('sandbox', process.env),
  production: loadSquareWebhookConfiguration('production', process.env),
};
const squareWebhookRepository =
  squareWebhooks.sandbox || squareWebhooks.production
    ? new PostgresPaymentRepository(environment.DATABASE_URL)
    : undefined;
const stripeWebhooks = {
  test: loadStripeWebhookConfiguration('test', process.env),
  production: loadStripeWebhookConfiguration('production', process.env),
};
const stripeWebhookRepository =
  stripeWebhooks.test || stripeWebhooks.production
    ? new PostgresPaymentRepository(environment.DATABASE_URL)
    : undefined;
const configuredDeviceCareRepository = deviceCareRepository ?? stripeDeviceCareRepository;
const app = buildApp({
  databaseUrl: environment.DATABASE_URL,
  authorizer: new PostgresAuthorizer(environment.DATABASE_URL),
  authorizationAdminRepository: new PostgresAuthorizationAdminRepository(environment.DATABASE_URL),
  organizationRepository: new PostgresOrganizationRepository(environment.DATABASE_URL),
  customerRepository: new PostgresCustomerRepository(environment.DATABASE_URL, fieldEncryptor),
  customerAdministrationRepository: new PostgresCustomerAdministrationRepository(
    environment.DATABASE_URL,
    fieldEncryptor,
  ),
  customerWorkRoutingRepository: new PostgresCustomerWorkRoutingRepository(
    environment.DATABASE_URL,
  ),
  employeeRepository: new PostgresEmployeeRepository(environment.DATABASE_URL, fieldEncryptor),
  employeeAdministrationRepository: new PostgresEmployeeAdministrationRepository(
    environment.DATABASE_URL,
    fieldEncryptor,
  ),
  timekeepingRepository,
  mobileTimekeepingRepository: timekeepingRepository,
  quoteRepository: new PostgresQuoteRepository(environment.DATABASE_URL),
  jobRepository: new PostgresJobRepository(environment.DATABASE_URL, fieldEncryptor),
  subscriptionPlanRepository: new PostgresSubscriptionPlanRepository(environment.DATABASE_URL),
  reportingRepository: new PostgresReportingRepository(environment.DATABASE_URL),
  compensationRepository: new PostgresCompensationRepository(environment.DATABASE_URL),
  deviceCareWalletRepository: new PostgresDeviceCareWalletRepository(environment.DATABASE_URL),
  deviceCareEntitlementRepository: new PostgresDeviceCareEntitlementRepository(
    environment.DATABASE_URL,
  ),
  publicDeviceCareOfferRepository: new PostgresPublicDeviceCareOfferRepository(
    environment.DATABASE_URL,
  ),
  ...(paymentRepository
    ? {
        paymentRepository,
        squareWebhooks,
      }
    : {}),
  ...(configuredDeviceCareRepository
    ? { deviceCareRepository: configuredDeviceCareRepository }
    : {}),
  ...(accountInvitationRepository
    ? {
        accountInvitationRepository,
        invitationEmailClaim: environment.AUTH0_INVITATION_EMAIL_CLAIM,
      }
    : {}),
  ...(coreIdentityRepository
    ? {
        coreIdentityRepository,
        coreIdentitySessionCookie: {
          name: environment.CORE_IDENTITY_SESSION_COOKIE_NAME,
          secure: environment.NODE_ENV === 'production',
          maxAgeSeconds: coreIdentityConfiguration!.refreshTokenTtlSeconds,
        },
      }
    : {}),
  ...(squareWebhookRepository
    ? {
        squareWebhookRepository,
        squareWebhooks,
      }
    : {}),
  ...(stripeWebhookRepository ? { stripeWebhookRepository, stripeWebhooks } : {}),
  ...(environment.RETELL_ENABLED
    ? {
        retell: {
          apiKey: environment.RETELL_API_KEY!,
          repository: new PostgresRetellCallRepository(environment.DATABASE_URL, fieldEncryptor),
        },
      }
    : {}),
  apiSecurity: {
    allowedOrigins:
      environment.API_ALLOWED_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ?? [],
    sensitiveRateLimitMax: environment.API_SENSITIVE_RATE_LIMIT_MAX,
    sensitiveRateLimitWindowMs: environment.API_SENSITIVE_RATE_LIMIT_WINDOW_MS,
    stepUpClaim: environment.AUTH0_STEP_UP_CLAIM,
    stepUpValue: environment.AUTH0_STEP_UP_VALUE,
    coreIdentityStepUpMethod: 'mfa',
  },
  verifyToken: createCompositeTokenVerifier(
    coreIdentityConfiguration
      ? createCoreIdentityTokenVerifier(coreIdentityConfiguration)
      : undefined,
    environment.AUTH0_DOMAIN && environment.AUTH0_AUDIENCE
      ? createAuth0TokenVerifier(
          loadAuth0Config({
            AUTH0_DOMAIN: environment.AUTH0_DOMAIN,
            AUTH0_AUDIENCE: environment.AUTH0_AUDIENCE,
          }),
        )
      : undefined,
  ),
});
async function start(): Promise<void> {
  try {
    await app.listen({ host: environment.CORE_API_HOST, port: environment.CORE_API_PORT });
    if (customerEmailOutbox || accountInvitationRepository || coreIdentityEmailOutbox) {
      const deliverTransactionalEmail = () => {
        if (customerEmailOutbox)
          void customerEmailOutbox.deliverPending().catch((error: unknown) => app.log.error(error));
        if (accountInvitationRepository)
          void accountInvitationRepository
            .deliverPending()
            .catch((error: unknown) => app.log.error(error));
        if (coreIdentityEmailOutbox)
          void coreIdentityEmailOutbox
            .deliverPending()
            .catch((error: unknown) => app.log.error(error));
      };
      deliverTransactionalEmail();
      const interval = setInterval(() => {
        deliverTransactionalEmail();
      }, environment.CUSTOMER_EMAIL_DELIVERY_POLL_INTERVAL_MS);
      interval.unref();
    }
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
void start();
