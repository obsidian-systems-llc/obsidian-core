import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { createAuthorizationGuard, type Authorizer } from './authorization.js';
import {
  AuthorizationAdministrationError,
  assignRoleSchema,
  createRoleSchema,
  grantEntitlementSchema,
  replaceRolePermissionsSchema,
  revokeAuthorizationSchema,
  type AuthorizationAdminRepository,
} from './authorization-admin.js';
import { checkDatabase } from './health.js';
import type { OrganizationRepository } from './organizations.js';
import {
  customerAddressSchema,
  customerAccountClosureSchema,
  customerDeviceSchema,
  customerPortalPageSchema,
  customerProfileUpdateSchema,
  customerRegistrationSchema,
  type CustomerRepository,
} from './customers.js';
import type { EmployeeRepository } from './employees.js';
import {
  customerWorkCompleteSchema,
  customerWorkEscalateSchema,
  customerWorkRouteSchema,
  type CustomerWorkRoutingRepository,
  type CustomerWorkType,
} from './customer-work-routing.js';
import {
  createAdminCustomerSchema,
  customerRepairPageSchema,
  repairCustomerAssociationSchema,
  updateAdminCustomerSchema,
  type CustomerAdministrationRepository,
} from './customer-admin.js';
import {
  createEmployeeAssignmentSchema,
  createEmployeeSchema,
  employeeLifecycleSchema,
  employeeManagementPageSchema,
  endEmployeeAssignmentSchema,
  replaceEmployeeProfileSchema,
  type EmployeeAdministrationRepository,
} from './employee-admin.js';
import {
  createTimeCorrectionSchema,
  createTimeEntrySchema,
  mobileTimeEventSchema,
  MobileTimeEventError,
  type MobileTimekeepingRepository,
  type TimekeepingRepository,
} from './timekeeping.js';
import {
  createQuoteSchema,
  quoteAcceptanceSchema,
  quoteLifecycleSchema,
  quoteRevisionSchema,
  QuoteInputError,
  QuoteLifecycleError,
  type QuoteRepository,
} from './quotes.js';
import {
  createJobSchema,
  customerRepairRequestSchema,
  JobTransitionError,
  transitionJobSchema,
  type JobRepository,
} from './jobs.js';
import type { ReportingRepository } from './reporting.js';
import { subscriptionPlanVersionSchema, type SubscriptionPlanRepository } from './subscriptions.js';
import {
  assignCompensationSchema,
  commissionEventSchema,
  createCommissionSchema,
  type CompensationRepository,
} from './compensation.js';
import {
  hasStepUpAuthentication,
  isOriginAllowed,
  isSensitiveRoute,
  SensitiveRouteRateLimiter,
  type ApiSecurityConfig,
} from './security.js';
import {
  type PaymentRepository,
  PaymentProviderError,
  paymentRequestSchema,
  refundRequestSchema,
  type SquareWebhookConfiguration,
  type StripeWebhookConfiguration,
  squareWebhookEventSchema,
  stripeWebhookEventSchema,
  verifyStripeWebhookSignature,
  verifySquareWebhookSignature,
} from './payments.js';
import {
  enrollDeviceCareSchema,
  paymentMethodMutationSchema,
  savePaymentMethodSchema,
  DeviceCareCancellationProviderUnavailableError,
  DeviceCareProviderError,
  type DeviceCareRepository,
} from './device-care.js';
import type { DeviceCareWallet } from './device-care-wallet.js';
import type { PublicDeviceCareOfferRepository } from './public-device-care-offer.js';
import {
  CommunicationWorkflowError,
  communicationDoNotCallSchema,
  communicationLeadSchema,
  communicationRepairJobSchema,
  retellWebhookSchema,
  verifyRetellWebhook,
  type RetellCallRepository,
} from './retell.js';
import {
  acceptAccountInvitationSchema,
  createAccountInvitationSchema,
  revokeAccountInvitationSchema,
  type AccountInvitationRepository,
} from './account-invitations.js';
import {
  coreCustomerRegistrationSchema,
  coreLoginSchema,
  coreMfaVerificationSchema,
  corePasswordResetConfirmSchema,
  corePasswordResetRequestSchema,
  coreTokenSchema,
  type CoreIdentityRepository,
} from './core-identity.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
    rawBody?: string;
  }
}

export type BuildAppOptions = {
  databaseUrl?: string;
  authorizer?: Authorizer;
  authorizationAdminRepository?: AuthorizationAdminRepository;
  organizationRepository?: OrganizationRepository;
  customerRepository?: CustomerRepository;
  customerAdministrationRepository?: CustomerAdministrationRepository;
  employeeRepository?: EmployeeRepository;
  customerWorkRoutingRepository?: CustomerWorkRoutingRepository;
  employeeAdministrationRepository?: EmployeeAdministrationRepository;
  timekeepingRepository?: TimekeepingRepository;
  mobileTimekeepingRepository?: MobileTimekeepingRepository;
  quoteRepository?: QuoteRepository;
  jobRepository?: JobRepository;
  subscriptionPlanRepository?: SubscriptionPlanRepository;
  reportingRepository?: ReportingRepository;
  compensationRepository?: CompensationRepository;
  paymentRepository?: PaymentRepository;
  deviceCareRepository?: DeviceCareRepository;
  deviceCareWalletRepository?: { forSubject(subject: string): Promise<DeviceCareWallet | null> };
  publicDeviceCareOfferRepository?: PublicDeviceCareOfferRepository;
  squareWebhookRepository?: Pick<PaymentRepository, 'processSquareWebhook'>;
  squareWebhooks?: {
    production?: SquareWebhookConfiguration | undefined;
    sandbox?: SquareWebhookConfiguration | undefined;
  };
  stripeWebhookRepository?: Pick<PaymentRepository, 'processStripeWebhook'>;
  stripeWebhooks?: {
    production?: StripeWebhookConfiguration | undefined;
    test?: StripeWebhookConfiguration | undefined;
  };
  retell?: { apiKey: string; repository: RetellCallRepository };
  accountInvitationRepository?: AccountInvitationRepository;
  invitationEmailClaim?: string;
  coreIdentityRepository?: CoreIdentityRepository;
  coreIdentitySessionCookie?: { maxAgeSeconds: number; name: string; secure: boolean };
  apiSecurity?: ApiSecurityConfig;
  verifyToken?: TokenVerifier;
};

export function buildApp({
  databaseUrl,
  authorizer,
  authorizationAdminRepository,
  organizationRepository,
  customerRepository,
  customerAdministrationRepository,
  employeeRepository,
  customerWorkRoutingRepository,
  employeeAdministrationRepository,
  timekeepingRepository,
  mobileTimekeepingRepository,
  quoteRepository,
  jobRepository,
  subscriptionPlanRepository,
  reportingRepository,
  compensationRepository,
  paymentRepository,
  deviceCareRepository,
  deviceCareWalletRepository,
  publicDeviceCareOfferRepository,
  squareWebhookRepository,
  squareWebhooks,
  stripeWebhookRepository,
  stripeWebhooks,
  retell,
  accountInvitationRepository,
  invitationEmailClaim,
  coreIdentityRepository,
  coreIdentitySessionCookie,
  apiSecurity,
  verifyToken,
}: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body.toString();
    try {
      done(null, JSON.parse(request.rawBody));
    } catch {
      done(new Error('Invalid JSON body.'));
    }
  });
  const security = apiSecurity;
  const rateLimiter = security
    ? new SensitiveRouteRateLimiter(
        security.sensitiveRateLimitMax,
        security.sensitiveRateLimitWindowMs,
      )
    : undefined;
  app.addHook('onRequest', async (request, reply) => {
    const correlationId = request.headers['x-correlation-id'] ?? randomUUID();
    reply.header('x-correlation-id', correlationId);
    request.log = request.log.child({ correlationId });
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (!security) return;
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    if (origin && !isOriginAllowed(origin, security))
      return reply
        .code(403)
        .send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin is not allowed.' } });
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type, x-correlation-id');
      reply.header('access-control-allow-methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
      if (coreIdentitySessionCookie) reply.header('access-control-allow-credentials', 'true');
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
    if (rateLimiter && isSensitiveRoute(request)) {
      const key = `${request.ip}:${request.method}:${request.url.split('?')[0]}`;
      if (!rateLimiter.allow(key))
        return reply.code(429).send({
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
        });
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    if (!databaseUrl || !(await checkDatabase(databaseUrl)))
      return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ready' };
  });
  if (coreIdentityRepository) {
    const readCookie = (request: FastifyRequest) => {
      const name = coreIdentitySessionCookie?.name;
      if (!name) return undefined;
      const cookie = request.headers.cookie;
      return typeof cookie === 'string'
        ? cookie
            .split(';')
            .map((value) => value.trim())
            .find((value) => value.startsWith(`${name}=`))
            ?.slice(name.length + 1)
        : undefined;
    };
    const setSessionCookie = (reply: FastifyReply, refreshToken: string) => {
      if (!coreIdentitySessionCookie) return;
      reply.header(
        'set-cookie',
        `${coreIdentitySessionCookie.name}=${refreshToken}; Path=/v1/identity; HttpOnly; SameSite=${coreIdentitySessionCookie.secure ? 'None' : 'Lax'}; ${coreIdentitySessionCookie.secure ? 'Secure; ' : ''}Max-Age=${coreIdentitySessionCookie.maxAgeSeconds}`,
      );
    };
    const clearSessionCookie = (reply: FastifyReply) => {
      if (!coreIdentitySessionCookie) return;
      reply.header(
        'set-cookie',
        `${coreIdentitySessionCookie.name}=; Path=/v1/identity; HttpOnly; SameSite=${coreIdentitySessionCookie.secure ? 'None' : 'Lax'}; ${coreIdentitySessionCookie.secure ? 'Secure; ' : ''}Max-Age=0`,
      );
    };
    app.post('/v1/identity/customer-registration', async (request, reply) => {
      const parsed = coreCustomerRegistrationSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: {
            code: 'INVALID_IDENTITY_REGISTRATION',
            message: 'Registration input is invalid.',
          },
        });
      const result = await coreIdentityRepository.registerCustomer(
        parsed.data,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      if (result === 'email_exists')
        return reply.code(409).send({
          error: {
            code: 'IDENTITY_EMAIL_UNAVAILABLE',
            message: 'An account cannot be created with this email.',
          },
        });
      return reply.code(202).send(result);
    });
    app.post('/v1/identity/login', async (request, reply) => {
      const parsed = coreLoginSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_LOGIN', message: 'Login input is invalid.' } });
      const result = await coreIdentityRepository.login(
        parsed.data,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      if (result === 'invalid_credentials')
        return reply.code(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
        });
      if (result === 'email_verification_required')
        return reply.code(403).send({
          error: {
            code: 'EMAIL_VERIFICATION_REQUIRED',
            message: 'Verify your email before signing in.',
          },
        });
      setSessionCookie(reply, result.refreshToken);
      return { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' };
    });
    app.post('/v1/identity/session/refresh', async (request, reply) => {
      const parsed = coreTokenSchema.safeParse(request.body);
      const refreshToken = readCookie(request) ?? (parsed.success ? parsed.data.token : undefined);
      if (!refreshToken)
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid.' } });
      const result = await coreIdentityRepository.refresh(
        refreshToken,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      if (result === 'invalid_session')
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid.' } });
      setSessionCookie(reply, result.refreshToken);
      return { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' };
    });
    app.post('/v1/identity/logout', async (request, reply) => {
      const parsed = coreTokenSchema.safeParse(request.body);
      const refreshToken = readCookie(request) ?? (parsed.success ? parsed.data.token : undefined);
      if (refreshToken)
        await coreIdentityRepository.logout(
          refreshToken,
          String(request.headers['x-correlation-id'] ?? randomUUID()),
        );
      clearSessionCookie(reply);
      return reply.code(204).send();
    });
    app.post('/v1/identity/email-verification/confirm', async (request, reply) => {
      const parsed = coreTokenSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: {
            code: 'INVALID_EMAIL_VERIFICATION',
            message: 'Verification input is invalid.',
          },
        });
      const result = await coreIdentityRepository.confirmEmail(
        parsed.data.token,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      if (result === 'invalid_token')
        return reply.code(400).send({
          error: {
            code: 'INVALID_EMAIL_VERIFICATION',
            message: 'Verification link is invalid or expired.',
          },
        });
      return { status: 'verified' };
    });
    app.post('/v1/identity/password-reset/request', async (request, reply) => {
      const parsed = corePasswordResetRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: { code: 'INVALID_PASSWORD_RESET_REQUEST', message: 'Reset input is invalid.' },
        });
      await coreIdentityRepository.requestPasswordReset(
        parsed.data.email,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      return reply.code(202).send({ status: 'accepted' });
    });
    app.post('/v1/identity/password-reset/confirm', async (request, reply) => {
      const parsed = corePasswordResetConfirmSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_PASSWORD_RESET', message: 'Reset input is invalid.' } });
      const result = await coreIdentityRepository.confirmPasswordReset(
        parsed.data,
        String(request.headers['x-correlation-id'] ?? randomUUID()),
      );
      if (result === 'invalid_token')
        return reply.code(400).send({
          error: { code: 'INVALID_PASSWORD_RESET', message: 'Reset link is invalid or expired.' },
        });
      return { status: 'password_reset' };
    });
  }
  if (publicDeviceCareOfferRepository)
    app.get(
      '/v1/public/device-care/offer',
      async (_request, reply) =>
        (await publicDeviceCareOfferRepository.getActiveOffer()) ??
        reply.code(404).send({
          error: {
            code: 'DEVICE_CARE_OFFER_UNAVAILABLE',
            message: 'Device Care is not currently available for enrollment.',
          },
        }),
    );
  if (squareWebhookRepository && squareWebhooks) {
    const registerSquareWebhook = (
      environment: 'sandbox' | 'production',
      squareWebhook: SquareWebhookConfiguration,
    ) =>
      app.post(`/v1/webhooks/square/${environment}`, async (request, reply) => {
        const signature = request.headers['x-square-hmacsha256-signature'];
        const payload = request.rawBody;
        if (typeof signature !== 'string' || !payload)
          return reply.code(403).send({
            error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature is invalid.' },
          });
        if (
          !verifySquareWebhookSignature({
            notificationUrl: squareWebhook.notificationUrl,
            payload,
            signature,
            signatureKey: squareWebhook.signatureKey,
          })
        )
          return reply.code(403).send({
            error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature is invalid.' },
          });
        const parsed = squareWebhookEventSchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({
            error: { code: 'INVALID_SQUARE_WEBHOOK', message: 'Webhook payload is invalid.' },
          });
        const result = await squareWebhookRepository.processSquareWebhook(
          parsed.data,
          payload,
          environment,
        );
        return reply.code(result === 'duplicate' ? 200 : 202).send({ status: result });
      });
    if (squareWebhooks.sandbox) registerSquareWebhook('sandbox', squareWebhooks.sandbox);
    if (squareWebhooks.production) registerSquareWebhook('production', squareWebhooks.production);
  }
  if (stripeWebhookRepository && stripeWebhooks) {
    const registerStripeWebhook = (
      environment: 'test' | 'production',
      stripeWebhook: StripeWebhookConfiguration,
    ) =>
      app.post(`/v1/webhooks/stripe/${environment}`, async (request, reply) => {
        const signature = request.headers['stripe-signature'];
        const payload = request.rawBody;
        if (
          typeof signature !== 'string' ||
          !payload ||
          !verifyStripeWebhookSignature({
            payload,
            signature,
            signingSecret: stripeWebhook.signingSecret,
            toleranceSeconds: stripeWebhook.toleranceSeconds,
          })
        )
          return reply.code(403).send({
            error: {
              code: 'INVALID_WEBHOOK_SIGNATURE',
              message: 'Webhook signature is invalid.',
            },
          });
        const parsed = stripeWebhookEventSchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({
            error: { code: 'INVALID_STRIPE_WEBHOOK', message: 'Webhook payload is invalid.' },
          });
        const result = await stripeWebhookRepository.processStripeWebhook(
          parsed.data,
          payload,
          environment,
        );
        return reply.code(result === 'duplicate' ? 200 : 202).send({ status: result });
      });
    if (stripeWebhooks.test) registerStripeWebhook('test', stripeWebhooks.test);
    if (stripeWebhooks.production) registerStripeWebhook('production', stripeWebhooks.production);
  }
  if (retell)
    app.post('/v1/webhooks/retell', async (request, reply) => {
      const signature = request.headers['x-retell-signature'];
      const payload = request.rawBody;
      if (
        typeof signature !== 'string' ||
        !payload ||
        !verifyRetellWebhook({ apiKey: retell.apiKey, payload, signature })
      )
        return reply.code(403).send({
          error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature is invalid.' },
        });
      const parsed = retellWebhookSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: { code: 'INVALID_RETELL_WEBHOOK', message: 'Webhook payload is invalid.' },
        });
      const result = await retell.repository.processWebhook(parsed.data, payload);
      return reply.code(result === 'duplicate' ? 200 : 202).send({ status: result });
    });
  if (verifyToken) {
    const authenticate = createAuthenticationGuard(verifyToken);
    app.get('/v1/identity/me', { preHandler: authenticate }, async (request) => ({
      subject: request.auth?.sub,
    }));
    if (coreIdentityRepository) {
      app.post(
        '/v1/identity/mfa/enrollment',
        { preHandler: authenticate },
        async (request, reply) => {
          const result = await coreIdentityRepository.beginMfaEnrollment(
            request.auth!.sub!,
            String(request.headers['x-correlation-id'] ?? randomUUID()),
          );
          if (result === 'identity_not_found')
            return reply.code(404).send({
              error: { code: 'CORE_IDENTITY_NOT_FOUND', message: 'Core identity was not found.' },
            });
          return reply.code(201).send(result);
        },
      );
      app.post(
        '/v1/identity/mfa/enrollment/confirm',
        { preHandler: authenticate },
        async (request, reply) => {
          const input = coreMfaVerificationSchema.safeParse(request.body);
          if (!input.success)
            return reply.code(400).send({
              error: { code: 'INVALID_MFA_CODE', message: 'MFA verification input is invalid.' },
            });
          const result = await coreIdentityRepository.confirmMfaEnrollment(
            request.auth!.sub!,
            input.data,
            String(request.headers['x-correlation-id'] ?? randomUUID()),
          );
          if (result === 'identity_not_found')
            return reply.code(404).send({
              error: { code: 'CORE_IDENTITY_NOT_FOUND', message: 'Core identity was not found.' },
            });
          if (result === 'invalid_code')
            return reply
              .code(400)
              .send({ error: { code: 'INVALID_MFA_CODE', message: 'The MFA code is invalid.' } });
          return { status: 'verified' };
        },
      );
      app.post('/v1/identity/mfa/step-up', { preHandler: authenticate }, async (request, reply) => {
        const input = coreMfaVerificationSchema.safeParse(request.body);
        if (!input.success)
          return reply.code(400).send({
            error: { code: 'INVALID_MFA_CODE', message: 'MFA verification input is invalid.' },
          });
        const result = await coreIdentityRepository.stepUp(
          request.auth!.sub!,
          input.data,
          String(request.headers['x-correlation-id'] ?? randomUUID()),
        );
        if (result === 'identity_not_found')
          return reply.code(404).send({
            error: { code: 'CORE_IDENTITY_NOT_FOUND', message: 'Core identity was not found.' },
          });
        if (result === 'mfa_not_enrolled')
          return reply.code(409).send({
            error: {
              code: 'MFA_NOT_ENROLLED',
              message: 'Enroll an MFA factor before requesting step-up access.',
            },
          });
        if (result === 'invalid_code')
          return reply
            .code(401)
            .send({ error: { code: 'INVALID_MFA_CODE', message: 'The MFA code is invalid.' } });
        return { ...result, tokenType: 'Bearer' };
      });
    }
    if (retell && authorizer) {
      app.get(
        '/v1/employee-portal/communications/calls',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'employee-portal',
              permissionKey: 'communication.call.read',
            }),
          ],
        },
        async (request, reply) =>
          (await retell.repository.listForEmployee(request.auth!.sub!)) ??
          reply.code(404).send({
            error: { code: 'EMPLOYEE_PROFILE_NOT_FOUND', message: 'Employee profile not found.' },
          }),
      );
      app.get(
        '/v1/employee-portal/communications/calls/:id',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'employee-portal',
              permissionKey: 'communication.call.read',
            }),
          ],
        },
        async (request, reply) => {
          const id = (request.params as { id: string }).id;
          if (!zUuid(id))
            return reply.code(400).send({
              error: { code: 'INVALID_COMMUNICATION_CALL', message: 'Call ID is invalid.' },
            });
          return (
            (await retell.repository.getForEmployee(request.auth!.sub!, id)) ??
            reply.code(404).send({
              error: { code: 'COMMUNICATION_CALL_NOT_FOUND', message: 'Call not found.' },
            })
          );
        },
      );
      app.post(
        '/v1/employee-portal/communications/calls/:id/claim',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'employee-portal',
              permissionKey: 'communication.call.claim',
            }),
          ],
        },
        async (request, reply) => {
          const id = (request.params as { id: string }).id;
          if (!zUuid(id))
            return reply.code(400).send({
              error: { code: 'INVALID_COMMUNICATION_CALL', message: 'Call ID is invalid.' },
            });
          const result = await retell.repository.claimForEmployee(request.auth!.sub!, id);
          if (result === 'claimed') return { status: result };
          if (result === 'employee_not_found')
            return reply.code(404).send({
              error: {
                code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                message: 'Employee profile not found.',
              },
            });
          return reply.code(409).send({
            error: { code: 'CALL_ALREADY_ASSIGNED', message: 'Call is already assigned.' },
          });
        },
      );
      app.post(
        '/v1/employee-portal/communications/calls/:id/follow-up/complete',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'employee-portal',
              permissionKey: 'communication.call.follow_up',
            }),
          ],
        },
        async (request, reply) => {
          const id = (request.params as { id: string }).id;
          if (!zUuid(id))
            return reply.code(400).send({
              error: { code: 'INVALID_COMMUNICATION_CALL', message: 'Call ID is invalid.' },
            });
          const result = await retell.repository.completeFollowUpForEmployee(
            request.auth!.sub!,
            id,
          );
          if (result === null)
            return reply.code(404).send({
              error: {
                code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                message: 'Employee profile not found.',
              },
            });
          if (!result)
            return reply.code(409).send({
              error: {
                code: 'FOLLOW_UP_NOT_ASSIGNABLE',
                message: 'Follow-up is not assigned to this employee.',
              },
            });
          return { status: 'completed' };
        },
      );
      if (retell.repository.createRepairJobForEmployee) {
        app.post(
          '/v1/employee-portal/communications/calls/:id/repair-jobs',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'communication.call.repair.create',
              }),
            ],
          },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const parsed = communicationRepairJobSchema.safeParse(request.body);
            if (!zUuid(id) || !parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_COMMUNICATION_REPAIR_JOB',
                  message: 'Repair job input is invalid.',
                },
              });
            try {
              const result = await retell.repository.createRepairJobForEmployee!(
                request.auth!.sub!,
                id,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              );
              if (result === null)
                return reply.code(404).send({
                  error: {
                    code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                    message: 'Employee profile not found.',
                  },
                });
              if (result === 'unavailable')
                return reply.code(404).send({
                  error: { code: 'COMMUNICATION_CALL_NOT_FOUND', message: 'Call not found.' },
                });
              return reply.code(201).send(result);
            } catch (error) {
              if (error instanceof CommunicationWorkflowError)
                return reply.code(409).send({
                  error: { code: 'COMMUNICATION_REPAIR_JOB_CONFLICT', message: error.message },
                });
              throw error;
            }
          },
        );
      }
      if (retell.repository.createLeadForEmployee) {
        app.post(
          '/v1/employee-portal/communications/calls/:id/leads',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'communication.lead.create',
              }),
            ],
          },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const parsed = communicationLeadSchema.safeParse(request.body);
            if (!zUuid(id) || !parsed.success)
              return reply.code(400).send({
                error: { code: 'INVALID_COMMUNICATION_LEAD', message: 'Lead input is invalid.' },
              });
            const result = await retell.repository.createLeadForEmployee!(
              request.auth!.sub!,
              id,
              parsed.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === null)
              return reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                  message: 'Employee profile not found.',
                },
              });
            if (result === 'unavailable')
              return reply.code(404).send({
                error: { code: 'COMMUNICATION_CALL_NOT_FOUND', message: 'Call not found.' },
              });
            return reply.code(201).send(result);
          },
        );
      }
      if (retell.repository.suppressPhoneForEmployee) {
        app.post(
          '/v1/employee-portal/communications/calls/:id/do-not-call',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'communication.dnc.manage',
              }),
            ],
          },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const parsed = communicationDoNotCallSchema.safeParse(request.body);
            if (!zUuid(id) || !parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_DO_NOT_CALL_REQUEST',
                  message: 'Do-not-call input is invalid.',
                },
              });
            try {
              const result = await retell.repository.suppressPhoneForEmployee!(
                request.auth!.sub!,
                id,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              );
              if (result === null)
                return reply.code(404).send({
                  error: {
                    code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                    message: 'Employee profile not found.',
                  },
                });
              if (result === 'unavailable')
                return reply.code(404).send({
                  error: { code: 'COMMUNICATION_CALL_NOT_FOUND', message: 'Call not found.' },
                });
              return { status: 'suppressed' };
            } catch (error) {
              if (error instanceof CommunicationWorkflowError)
                return reply.code(400).send({
                  error: { code: 'INVALID_DO_NOT_CALL_REQUEST', message: error.message },
                });
              throw error;
            }
          },
        );
      }
      app.get(
        '/v1/core-admin/communications/calls',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'core-admin',
              permissionKey: 'communication.call.manage',
            }),
          ],
        },
        async () => retell.repository.listAll(),
      );
      app.put(
        '/v1/core-admin/communications/calls/:id/assignment',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'core-admin',
              permissionKey: 'communication.call.manage',
            }),
          ],
        },
        async (request, reply) => {
          const id = (request.params as { id: string }).id;
          const body = z.object({ employeeProfileId: z.uuid().nullable() }).safeParse(request.body);
          if (!zUuid(id) || !body.success)
            return reply.code(400).send({
              error: {
                code: 'INVALID_COMMUNICATION_ASSIGNMENT',
                message: 'Assignment input is invalid.',
              },
            });
          return (await retell.repository.assign(
            id,
            body.data.employeeProfileId,
            request.auth!.sub!,
          ))
            ? { status: 'assigned' }
            : reply.code(404).send({
                error: { code: 'COMMUNICATION_CALL_NOT_FOUND', message: 'Call not found.' },
              });
        },
      );
    }
    if (deviceCareWalletRepository && authorizer)
      app.get(
        '/v1/customer-portal/device-care/wallet',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'customer-portal',
              permissionKey: 'customer.portal.read',
            }),
          ],
        },
        async (request, reply) =>
          (await deviceCareWalletRepository.forSubject(request.auth!.sub!)) ??
          reply.code(404).send({
            error: { code: 'CUSTOMER_PROFILE_NOT_FOUND', message: 'Customer profile not found.' },
          }),
      );
    if (customerRepository?.registerForSubject)
      app.post(
        '/v1/customer-portal/registration',
        { preHandler: authenticate },
        async (request, reply) => {
          const parsed = customerRegistrationSchema.safeParse(request.body);
          if (!parsed.success)
            return reply.code(400).send({
              error: {
                code: 'INVALID_CUSTOMER_REGISTRATION',
                message: 'Registration input is invalid.',
              },
            });
          try {
            return await customerRepository.registerForSubject!(
              request.auth!.sub!,
              parsed.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
          } catch (error) {
            if (error instanceof Error && error.message === 'EMAIL_ALREADY_LINKED')
              return reply.code(409).send({
                error: {
                  code: 'CUSTOMER_EMAIL_ALREADY_LINKED',
                  message: 'A Core account already exists for this email.',
                },
              });
            if (error instanceof Error && error.message === 'IDENTITY_ALREADY_LINKED')
              return reply.code(409).send({
                error: {
                  code: 'IDENTITY_ALREADY_LINKED',
                  message: 'This identity is already linked to Core.',
                },
              });
            throw error;
          }
        },
      );
    if (authorizer) {
      app.get(
        '/v1/core-admin/authorization/access',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'core-admin',
              permissionKey: 'authorization.read',
            }),
          ],
        },
        async () => ({ status: 'authorized' }),
      );
      if (authorizationAdminRepository) {
        const authorizationManagementGuards = [
          authenticate,
          async (request: FastifyRequest, reply: FastifyReply) => {
            if (
              !security?.stepUpClaim ||
              !security.stepUpValue ||
              hasStepUpAuthentication(request.auth!, security)
            )
              return;
            return reply.code(403).send({
              error: { code: 'STEP_UP_REQUIRED', message: 'Step-up authentication is required.' },
            });
          },
          createAuthorizationGuard(authorizer, {
            applicationKey: 'core-admin',
            permissionKey: 'authorization.manage',
          }),
        ];
        const inputError = (reply: FastifyReply, code: string) =>
          reply
            .code(400)
            .send({ error: { code, message: 'Authorization administration input is invalid.' } });
        app.get(
          '/v1/core-admin/authorization/roles',
          { preHandler: authorizationManagementGuards },
          async () => authorizationAdminRepository.listRoles(),
        );
        app.post(
          '/v1/core-admin/authorization/roles',
          { preHandler: authorizationManagementGuards },
          async (request, reply) => {
            const input = createRoleSchema.safeParse(request.body);
            if (!input.success) return inputError(reply, 'INVALID_AUTHORIZATION_ROLE');
            try {
              const role = await authorizationAdminRepository.createRole(
                request.auth!.sub!,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              );
              return (
                role ??
                reply.code(404).send({
                  error: {
                    code: 'AUTHORIZATION_ACTOR_NOT_FOUND',
                    message: 'Authorization actor was not found.',
                  },
                })
              );
            } catch (error) {
              if (error instanceof AuthorizationAdministrationError)
                return reply
                  .code(409)
                  .send({ error: { code: 'AUTHORIZATION_ROLE_CONFLICT', message: error.message } });
              throw error;
            }
          },
        );
        app.put(
          '/v1/core-admin/authorization/roles/:id/permissions',
          { preHandler: authorizationManagementGuards },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = replaceRolePermissionsSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return inputError(reply, 'INVALID_AUTHORIZATION_ROLE_PERMISSIONS');
            try {
              const role = await authorizationAdminRepository.replaceRolePermissions(
                request.auth!.sub!,
                id,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              );
              if (role === 'protected')
                return reply.code(409).send({
                  error: {
                    code: 'PROTECTED_AUTHORIZATION_ROLE',
                    message: 'The protected Super Admin role cannot be changed through this route.',
                  },
                });
              return (
                role ??
                reply.code(404).send({
                  error: { code: 'AUTHORIZATION_ROLE_NOT_FOUND', message: 'Role not found.' },
                })
              );
            } catch (error) {
              if (error instanceof AuthorizationAdministrationError)
                return reply
                  .code(409)
                  .send({ error: { code: 'AUTHORIZATION_ROLE_CONFLICT', message: error.message } });
              throw error;
            }
          },
        );
        app.post(
          '/v1/core-admin/authorization/role-assignments',
          { preHandler: authorizationManagementGuards },
          async (request, reply) => {
            const input = assignRoleSchema.safeParse(request.body);
            if (!input.success) return inputError(reply, 'INVALID_ROLE_ASSIGNMENT');
            const result = await authorizationAdminRepository.assignRole(
              request.auth!.sub!,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'self_assignment')
              return reply.code(409).send({
                error: {
                  code: 'SELF_ACCESS_CHANGE_FORBIDDEN',
                  message: 'Administrators cannot change their own access.',
                },
              });
            return (
              result ??
              reply.code(404).send({
                error: {
                  code: 'AUTHORIZATION_TARGET_NOT_FOUND',
                  message: 'User or role not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/authorization/entitlements',
          { preHandler: authorizationManagementGuards },
          async (request, reply) => {
            const input = grantEntitlementSchema.safeParse(request.body);
            if (!input.success) return inputError(reply, 'INVALID_APPLICATION_ENTITLEMENT');
            const result = await authorizationAdminRepository.grantEntitlement(
              request.auth!.sub!,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'self_assignment')
              return reply.code(409).send({
                error: {
                  code: 'SELF_ACCESS_CHANGE_FORBIDDEN',
                  message: 'Administrators cannot change their own access.',
                },
              });
            return (
              result ??
              reply.code(404).send({
                error: {
                  code: 'AUTHORIZATION_TARGET_NOT_FOUND',
                  message: 'User or application not found.',
                },
              })
            );
          },
        );
        const revoke = (route: string, method: 'revokeRoleAssignment' | 'revokeEntitlement') =>
          app.post(route, { preHandler: authorizationManagementGuards }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = revokeAuthorizationSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return inputError(reply, 'INVALID_AUTHORIZATION_REVOCATION');
            const result = await authorizationAdminRepository[method](
              request.auth!.sub!,
              id,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'self_assignment')
              return reply.code(409).send({
                error: {
                  code: 'SELF_ACCESS_CHANGE_FORBIDDEN',
                  message: 'Administrators cannot change their own access.',
                },
              });
            return result
              ? { status: 'revoked' }
              : reply.code(404).send({
                  error: {
                    code: 'AUTHORIZATION_ASSIGNMENT_NOT_FOUND',
                    message: 'Active assignment not found.',
                  },
                });
          });
        revoke('/v1/core-admin/authorization/role-assignments/:id/revoke', 'revokeRoleAssignment');
        revoke('/v1/core-admin/authorization/entitlements/:id/revoke', 'revokeEntitlement');
      }
      if (accountInvitationRepository) {
        const invitationGuards = [
          authenticate,
          async (request: FastifyRequest, reply: FastifyReply) => {
            if (
              !security?.stepUpClaim ||
              !security.stepUpValue ||
              hasStepUpAuthentication(request.auth!, security)
            )
              return;
            return reply.code(403).send({
              error: { code: 'STEP_UP_REQUIRED', message: 'Step-up authentication is required.' },
            });
          },
          createAuthorizationGuard(authorizer, {
            applicationKey: 'core-admin',
            permissionKey: 'authorization.invite',
          }),
        ];
        app.get('/v1/core-admin/account-invitations', { preHandler: invitationGuards }, async () =>
          accountInvitationRepository.list(),
        );
        app.post(
          '/v1/core-admin/account-invitations',
          { preHandler: invitationGuards },
          async (request, reply) => {
            const input = createAccountInvitationSchema.safeParse(request.body);
            if (!input.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_ACCOUNT_INVITATION',
                  message: 'Account invitation input is invalid.',
                },
              });
            const result = await accountInvitationRepository.create(
              request.auth!.sub!,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'invalid_expiry')
              return reply.code(400).send({
                error: {
                  code: 'INVALID_ACCOUNT_INVITATION_EXPIRY',
                  message: 'Invitation expiry must be between now and 30 days from now.',
                },
              });
            return (
              result ??
              reply.code(409).send({
                error: {
                  code: 'ACCOUNT_INVITATION_ACCESS_EXISTS',
                  message: 'The recipient already has this application access or role.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/account-invitations/:id/revoke',
          { preHandler: invitationGuards },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = revokeAccountInvitationSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_ACCOUNT_INVITATION_REVOCATION',
                  message: 'Account invitation revocation input is invalid.',
                },
              });
            const revoked = await accountInvitationRepository.revoke(
              request.auth!.sub!,
              id,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            return revoked
              ? { status: 'revoked' }
              : reply.code(404).send({
                  error: {
                    code: 'ACCOUNT_INVITATION_NOT_FOUND',
                    message: 'An active account invitation was not found.',
                  },
                });
          },
        );
        app.post(
          '/v1/account-invitations/accept',
          { preHandler: authenticate },
          async (request, reply) => {
            const input = acceptAccountInvitationSchema.safeParse(request.body);
            if (!input.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_ACCOUNT_INVITATION_ACCEPTANCE',
                  message: 'Account invitation acceptance input is invalid.',
                },
              });
            const claim = invitationEmailClaim ?? 'email';
            const emailClaim = request.auth?.[claim];
            const result = await accountInvitationRepository.accept(
              request.auth!.sub!,
              typeof emailClaim === 'string' ? emailClaim : undefined,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'email_mismatch')
              return reply.code(400).send({
                error: {
                  code: 'INVITATION_EMAIL_CLAIM_MISSING',
                  message: 'The access token must contain the configured invitation email claim.',
                },
              });
            return (
              result ??
              reply.code(409).send({
                error: {
                  code: 'ACCOUNT_INVITATION_UNAVAILABLE',
                  message: 'This invitation is unavailable for the authenticated account.',
                },
              })
            );
          },
        );
      }
      if (organizationRepository) {
        app.get(
          '/v1/core-admin/organization-hierarchy',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'organization.read',
              }),
            ],
          },
          async () => organizationRepository.getHierarchy(),
        );
      }
      if (employeeAdministrationRepository) {
        const employeeAdministrationGuards = [
          authenticate,
          async (request: FastifyRequest, reply: FastifyReply) => {
            if (
              !security?.stepUpClaim ||
              !security.stepUpValue ||
              hasStepUpAuthentication(request.auth!, security)
            )
              return;
            return reply.code(403).send({
              error: { code: 'STEP_UP_REQUIRED', message: 'Step-up authentication is required.' },
            });
          },
          createAuthorizationGuard(authorizer, {
            applicationKey: 'core-admin',
            permissionKey: 'employee.manage',
          }),
        ];
        const employeeInputError = (reply: FastifyReply, code: string) =>
          reply.code(400).send({
            error: { code, message: 'Employee administration input is invalid.' },
          });
        app.post(
          '/v1/core-admin/employees',
          { preHandler: employeeAdministrationGuards },
          async (request, reply) => {
            const input = createEmployeeSchema.safeParse(request.body);
            if (!input.success) return employeeInputError(reply, 'INVALID_EMPLOYEE_CREATE');
            const result = await employeeAdministrationRepository.create(
              request.auth!.sub!,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'conflict')
              return reply.code(409).send({
                error: {
                  code: 'EMPLOYEE_CONFLICT',
                  message: 'Employee identity or number already exists.',
                },
              });
            return (
              result ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_USER_NOT_FOUND',
                  message: 'Active Core user not found.',
                },
              })
            );
          },
        );
        app.get(
          '/v1/core-admin/employees/:id',
          { preHandler: employeeAdministrationGuards },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!zUuid(id)) return employeeInputError(reply, 'INVALID_EMPLOYEE_ID');
            return (
              (await employeeAdministrationRepository.getForAdmin(id)) ??
              reply.code(404).send({
                error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' },
              })
            );
          },
        );
        app.put(
          '/v1/core-admin/employees/:id/profile',
          { preHandler: employeeAdministrationGuards },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = replaceEmployeeProfileSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return employeeInputError(reply, 'INVALID_EMPLOYEE_PROFILE');
            return (
              (await employeeAdministrationRepository.replaceProfile(
                request.auth!.sub!,
                id,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply
                .code(404)
                .send({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' } })
            );
          },
        );
        const lifecycle = (route: string, method: 'deactivate' | 'reactivate') =>
          app.post(route, { preHandler: employeeAdministrationGuards }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = employeeLifecycleSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return employeeInputError(reply, 'INVALID_EMPLOYEE_LIFECYCLE');
            const result = await employeeAdministrationRepository[method](
              request.auth!.sub!,
              id,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            return result
              ? { status: method === 'deactivate' ? 'deactivated' : 'active' }
              : reply.code(409).send({
                  error: {
                    code: 'EMPLOYEE_LIFECYCLE_CONFLICT',
                    message: 'Employee was not eligible for this lifecycle change.',
                  },
                });
          });
        lifecycle('/v1/core-admin/employees/:id/deactivate', 'deactivate');
        lifecycle('/v1/core-admin/employees/:id/reactivate', 'reactivate');
        app.post(
          '/v1/core-admin/employee-assignments',
          { preHandler: employeeAdministrationGuards },
          async (request, reply) => {
            const input = createEmployeeAssignmentSchema.safeParse(request.body);
            if (!input.success) return employeeInputError(reply, 'INVALID_EMPLOYEE_ASSIGNMENT');
            const result = await employeeAdministrationRepository.createAssignment(
              request.auth!.sub!,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'conflict')
              return reply.code(409).send({
                error: {
                  code: 'EMPLOYEE_ASSIGNMENT_CONFLICT',
                  message: 'Assignment overlaps an existing assignment in the same scope.',
                },
              });
            return (
              result ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_ASSIGNMENT_TARGET_NOT_FOUND',
                  message: 'Employee, manager, store, or department not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/employee-assignments/:id/end',
          { preHandler: employeeAdministrationGuards },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = endEmployeeAssignmentSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return employeeInputError(reply, 'INVALID_EMPLOYEE_ASSIGNMENT_END');
            const result = await employeeAdministrationRepository.endAssignment(
              request.auth!.sub!,
              id,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'invalid_effective_to')
              return reply.code(409).send({
                error: {
                  code: 'INVALID_ASSIGNMENT_EFFECTIVE_TO',
                  message: 'Assignment end must be after its start.',
                },
              });
            return result
              ? { status: 'ended' }
              : reply.code(404).send({
                  error: {
                    code: 'EMPLOYEE_ASSIGNMENT_NOT_FOUND',
                    message: 'Active employee assignment not found.',
                  },
                });
          },
        );
        app.get(
          '/v1/employee-portal/managed-employees',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'employee.scope.read',
              }),
            ],
          },
          async (request, reply) => {
            const page = employeeManagementPageSchema.safeParse(request.query);
            if (!page.success)
              return employeeInputError(reply, 'INVALID_MANAGED_EMPLOYEE_PAGINATION');
            const result = await employeeAdministrationRepository.listManaged(
              request.auth!.sub!,
              page.data,
            );
            return {
              ...result,
              page: {
                limit: page.data.limit,
                offset: page.data.offset,
                nextOffset: result.nextOffset,
              },
            };
          },
        );
      }
      if (customerAdministrationRepository) {
        const customerAdministrationGuards = (permissionKey: string) => [
          authenticate,
          async (request: FastifyRequest, reply: FastifyReply) => {
            if (
              !security?.stepUpClaim ||
              !security.stepUpValue ||
              hasStepUpAuthentication(request.auth!, security)
            )
              return;
            return reply.code(403).send({
              error: { code: 'STEP_UP_REQUIRED', message: 'Step-up authentication is required.' },
            });
          },
          createAuthorizationGuard(authorizer, { applicationKey: 'core-admin', permissionKey }),
        ];
        const customerInputError = (reply: FastifyReply, code: string) =>
          reply
            .code(400)
            .send({ error: { code, message: 'Customer administration input is invalid.' } });
        app.post(
          '/v1/core-admin/customers',
          { preHandler: customerAdministrationGuards('customer.manage') },
          async (request, reply) => {
            const input = createAdminCustomerSchema.safeParse(request.body);
            if (!input.success) return customerInputError(reply, 'INVALID_ADMIN_CUSTOMER_CREATE');
            return (
              (await customerAdministrationRepository.create(
                request.auth!.sub!,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply.code(404).send({
                error: {
                  code: 'CUSTOMER_ADMIN_ACTOR_NOT_FOUND',
                  message: 'Active Core actor not found.',
                },
              })
            );
          },
        );
        app.get(
          '/v1/core-admin/customers/:id',
          { preHandler: customerAdministrationGuards('customer.manage') },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!zUuid(id)) return customerInputError(reply, 'INVALID_ADMIN_CUSTOMER_ID');
            return (
              (await customerAdministrationRepository.get(id)) ??
              reply
                .code(404)
                .send({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' } })
            );
          },
        );
        app.put(
          '/v1/core-admin/customers/:id',
          { preHandler: customerAdministrationGuards('customer.manage') },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = updateAdminCustomerSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return customerInputError(reply, 'INVALID_ADMIN_CUSTOMER_UPDATE');
            return (
              (await customerAdministrationRepository.update(
                request.auth!.sub!,
                id,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply.code(404).send({
                error: { code: 'CUSTOMER_NOT_FOUND', message: 'Active customer not found.' },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/repair-jobs/:id/customer-association',
          { preHandler: customerAdministrationGuards('repair.customer.manage') },
          async (request, reply) => {
            const id = (request.params as { id: string }).id;
            const input = repairCustomerAssociationSchema.safeParse(request.body);
            if (!zUuid(id) || !input.success)
              return customerInputError(reply, 'INVALID_REPAIR_CUSTOMER_ASSOCIATION');
            const result = await customerAdministrationRepository.associateRepair(
              request.auth!.sub!,
              id,
              input.data,
              String(request.headers['x-correlation-id'] ?? randomUUID()),
            );
            if (result === 'unchanged')
              return reply.code(409).send({
                error: {
                  code: 'REPAIR_CUSTOMER_ASSOCIATION_UNCHANGED',
                  message: 'Repair already has the requested customer association.',
                },
              });
            return (
              result ??
              reply.code(404).send({
                error: {
                  code: 'REPAIR_OR_CUSTOMER_NOT_FOUND',
                  message: 'Repair or active customer not found.',
                },
              })
            );
          },
        );
        app.get(
          '/v1/customer-portal/repairs',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'customer-portal',
                permissionKey: 'customer.portal.read',
              }),
            ],
          },
          async (request, reply) => {
            const page = customerRepairPageSchema.safeParse(request.query);
            if (!page.success)
              return customerInputError(reply, 'INVALID_CUSTOMER_REPAIR_PAGINATION');
            const result = await customerAdministrationRepository.listPortalRepairs(
              request.auth!.sub!,
              page.data,
            );
            return result
              ? {
                  ...result,
                  page: {
                    limit: page.data.limit,
                    offset: page.data.offset,
                    nextOffset: result.nextOffset,
                  },
                }
              : reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                });
          },
        );
      }
      if (customerWorkRoutingRepository) {
        const workType = (value: string): CustomerWorkType | null =>
          value === 'communication_call' || value === 'repair_job' ? value : null;
        const workError = (reply: FastifyReply, code: string) =>
          reply.code(400).send({
            error: { code, message: 'Customer work routing input is invalid.' },
          });
        const employeeWorkGuard = (permissionKey: string) => [
          authenticate,
          createAuthorizationGuard(authorizer, {
            applicationKey: 'employee-portal',
            permissionKey,
          }),
        ];
        app.get(
          '/v1/employee-portal/customer-work',
          { preHandler: employeeWorkGuard('customer.work.complete') },
          async (request, reply) =>
            (await customerWorkRoutingRepository.listForEmployee(request.auth!.sub!)) ??
            reply.code(404).send({
              error: { code: 'EMPLOYEE_PROFILE_NOT_FOUND', message: 'Employee profile not found.' },
            }),
        );
        const employeeAction = (action: 'route' | 'escalate' | 'complete', permissionKey: string) =>
          app.post(
            `/v1/employee-portal/customer-work/:type/:id/${action}`,
            { preHandler: employeeWorkGuard(permissionKey) },
            async (request, reply) => {
              const { type, id } = request.params as { type: string; id: string };
              const normalized = workType(type);
              const schemas = {
                route: customerWorkRouteSchema,
                escalate: customerWorkEscalateSchema,
                complete: customerWorkCompleteSchema,
              };
              const input = schemas[action].safeParse(request.body);
              if (!normalized || !zUuid(id) || !input.success)
                return workError(reply, `INVALID_CUSTOMER_WORK_${action.toUpperCase()}`);
              const correlationId = String(request.headers['x-correlation-id'] ?? randomUUID());
              const result =
                action === 'route'
                  ? await customerWorkRoutingRepository.route(
                      request.auth!.sub!,
                      normalized,
                      id,
                      input.data as z.infer<typeof customerWorkRouteSchema>,
                      correlationId,
                      false,
                    )
                  : action === 'escalate'
                    ? await customerWorkRoutingRepository.escalate(
                        request.auth!.sub!,
                        normalized,
                        id,
                        input.data as z.infer<typeof customerWorkEscalateSchema>,
                        correlationId,
                      )
                    : await customerWorkRoutingRepository.complete(
                        request.auth!.sub!,
                        normalized,
                        id,
                        input.data as z.infer<typeof customerWorkCompleteSchema>,
                        correlationId,
                      );
              if (result === 'scope_forbidden' || result === 'not_owner')
                return reply.code(403).send({
                  error: {
                    code: 'CUSTOMER_WORK_SCOPE_FORBIDDEN',
                    message: 'Customer work is outside the caller scope.',
                  },
                });
              return result
                ? action === 'complete'
                  ? { status: 'completed' }
                  : result
                : reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_WORK_NOT_FOUND',
                      message: 'Customer work not found.',
                    },
                  });
            },
          );
        employeeAction('route', 'customer.work.route');
        employeeAction('escalate', 'customer.work.escalate');
        employeeAction('complete', 'customer.work.complete');
        app.post(
          '/v1/core-admin/customer-work/:type/:id/route',
          {
            preHandler: [
              authenticate,
              async (request: FastifyRequest, reply: FastifyReply) => {
                if (
                  !security?.stepUpClaim ||
                  !security.stepUpValue ||
                  hasStepUpAuthentication(request.auth!, security)
                )
                  return;
                return reply.code(403).send({
                  error: {
                    code: 'STEP_UP_REQUIRED',
                    message: 'Step-up authentication is required.',
                  },
                });
              },
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'customer.work.manage',
              }),
            ],
          },
          async (request, reply) => {
            const { type, id } = request.params as { type: string; id: string };
            const input = customerWorkRouteSchema.safeParse(request.body);
            const normalized = workType(type);
            if (!normalized || !zUuid(id) || !input.success)
              return workError(reply, 'INVALID_CUSTOMER_WORK_ROUTE');
            return (
              (await customerWorkRoutingRepository.route(
                request.auth!.sub!,
                normalized,
                id,
                input.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
                true,
              )) ??
              reply.code(404).send({
                error: {
                  code: 'CUSTOMER_WORK_NOT_FOUND',
                  message: 'Customer work or target employee not found.',
                },
              })
            );
          },
        );
      }
      if (customerRepository) {
        const customerWriteRequirement = {
          applicationKey: 'customer-portal',
          permissionKey: 'customer.profile.write',
        };
        app.get(
          '/v1/customer-portal/profile',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'customer-portal',
                permissionKey: 'customer.profile.read',
              }),
            ],
          },
          async (request, reply) => {
            const profile = await customerRepository.getForSubject(request.auth!.sub!);
            return (
              profile ??
              reply.code(404).send({
                error: {
                  code: 'CUSTOMER_PROFILE_NOT_FOUND',
                  message: 'Customer profile not found.',
                },
              })
            );
          },
        );
        if (customerRepository.updateForSubject)
          app.put(
            '/v1/customer-portal/profile',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, customerWriteRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = customerProfileUpdateSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_CUSTOMER_PROFILE_UPDATE',
                    message: 'Customer profile update input is invalid.',
                  },
                });
              return (
                (await customerRepository.updateForSubject!(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                })
              );
            },
          );
        if (customerRepository.closeAccountForSubject)
          app.delete(
            '/v1/customer-portal/account',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'customer.account.close',
                }),
              ],
            },
            async (request, reply) => {
              const parsed = customerAccountClosureSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_CUSTOMER_ACCOUNT_CLOSURE',
                    message: 'Account closure confirmation is invalid.',
                  },
                });
              const result = await customerRepository.closeAccountForSubject!(
                request.auth!.sub!,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              );
              if (result === 'active_subscription')
                return reply.code(409).send({
                  error: {
                    code: 'ACTIVE_SUBSCRIPTION_REQUIRES_CANCELLATION',
                    message: 'Cancel active subscriptions before closing the account.',
                  },
                });
              return (
                result ??
                reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                })
              );
            },
          );
        if (customerRepository.portalOverviewForSubject)
          app.get(
            '/v1/customer-portal/overview',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'customer.portal.read',
                }),
              ],
            },
            async (request, reply) => {
              const page = customerPortalPageSchema.safeParse(request.query);
              if (!page.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_CUSTOMER_PORTAL_PAGINATION',
                    message: 'Pagination input is invalid.',
                  },
                });
              return (
                (await customerRepository.portalOverviewForSubject!(
                  request.auth!.sub!,
                  page.data,
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                })
              );
            },
          );
        if (customerRepository.addAddressForSubject)
          app.post(
            '/v1/customer-portal/addresses',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, customerWriteRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = customerAddressSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_CUSTOMER_ADDRESS',
                    message: 'Address input is invalid.',
                  },
                });
              return (
                (await customerRepository.addAddressForSubject!(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                })
              );
            },
          );
        if (customerRepository.addDeviceForSubject)
          app.post(
            '/v1/customer-portal/devices',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, customerWriteRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = customerDeviceSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: { code: 'INVALID_CUSTOMER_DEVICE', message: 'Device input is invalid.' },
                });
              return (
                (await customerRepository.addDeviceForSubject!(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'CUSTOMER_PROFILE_NOT_FOUND',
                    message: 'Customer profile not found.',
                  },
                })
              );
            },
          );
        if (deviceCareRepository) {
          const deviceCareRequirement = {
            applicationKey: 'customer-portal',
            permissionKey: 'payment-method.manage',
          };
          app.post(
            '/v1/customer-portal/payment-methods/setup',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, deviceCareRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = paymentMethodMutationSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_PAYMENT_METHOD_SETUP',
                    message: 'Payment-method setup input is invalid.',
                  },
                });
              try {
                const result = await deviceCareRepository.createPaymentMethodSetupForSubject?.(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                );
                if (!result)
                  return reply.code(503).send({
                    error: {
                      code: 'PAYMENT_METHOD_SETUP_UNAVAILABLE',
                      message: 'Payment-method setup is unavailable for the selected provider.',
                    },
                  });
                return result;
              } catch (error) {
                request.log.warn(
                  error instanceof DeviceCareProviderError
                    ? { providerStatusCode: error.statusCode }
                    : {},
                  'Payment method setup failed.',
                );
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the payment-method setup.',
                  },
                });
              }
            },
          );
          app.post(
            '/v1/customer-portal/payment-methods',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, deviceCareRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = savePaymentMethodSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_PAYMENT_METHOD',
                    message: 'Payment method input is invalid.',
                  },
                });
              try {
                return (
                  (await deviceCareRepository.savePaymentMethodForSubject(
                    request.auth!.sub!,
                    parsed.data,
                    String(request.headers['x-correlation-id'] ?? randomUUID()),
                  )) ??
                  reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_PROFILE_NOT_FOUND',
                      message: 'Customer profile not found.',
                    },
                  })
                );
              } catch (error) {
                request.log.warn(
                  error instanceof DeviceCareProviderError
                    ? {
                        providerErrorCodes: error.errors.map((item) => item.code).filter(Boolean),
                        providerErrorFields: error.errors.map((item) => item.field).filter(Boolean),
                        providerStatusCode: error.statusCode,
                      }
                    : { error },
                  'Device Care payment method was rejected.',
                );
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the payment method.',
                  },
                });
              }
            },
          );
          app.get(
            '/v1/customer-portal/payment-methods',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'payment-method.read',
                }),
              ],
            },
            async (request, reply) =>
              (await deviceCareRepository.listPaymentMethodsForSubject(request.auth!.sub!)) ??
              reply.code(404).send({
                error: {
                  code: 'CUSTOMER_PROFILE_NOT_FOUND',
                  message: 'Customer profile not found.',
                },
              }),
          );
          app.put(
            '/v1/customer-portal/payment-methods/:id/primary',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, deviceCareRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = paymentMethodMutationSchema.safeParse(request.body);
              const id = (request.params as { id: string }).id;
              if (!parsed.success || !zUuid(id))
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_PAYMENT_METHOD_MUTATION',
                    message: 'Payment method update input is invalid.',
                  },
                });
              try {
                const result = await deviceCareRepository.setPrimaryPaymentMethodForSubject(
                  request.auth!.sub!,
                  id,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                );
                return (
                  result ??
                  reply.code(404).send({
                    error: {
                      code: 'PAYMENT_METHOD_NOT_FOUND',
                      message: 'Payment method not found.',
                    },
                  })
                );
              } catch (error) {
                request.log.warn({ error }, 'Primary payment method update was rejected.');
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the payment method update.',
                  },
                });
              }
            },
          );
          app.delete(
            '/v1/customer-portal/payment-methods/:id',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, deviceCareRequirement),
              ],
            },
            async (request, reply) => {
              const parsed = paymentMethodMutationSchema.safeParse(request.body);
              const id = (request.params as { id: string }).id;
              if (!parsed.success || !zUuid(id))
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_PAYMENT_METHOD_MUTATION',
                    message: 'Payment method removal input is invalid.',
                  },
                });
              try {
                const result = await deviceCareRepository.removePaymentMethodForSubject(
                  request.auth!.sub!,
                  id,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                );
                if (result === 'in_use')
                  return reply.code(409).send({
                    error: {
                      code: 'PAYMENT_METHOD_IN_USE',
                      message: 'Payment method is linked to an active subscription.',
                    },
                  });
                if (result === 'not_found')
                  return reply.code(404).send({
                    error: {
                      code: 'PAYMENT_METHOD_NOT_FOUND',
                      message: 'Payment method not found.',
                    },
                  });
                if (result === null)
                  return reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_PROFILE_NOT_FOUND',
                      message: 'Customer profile not found.',
                    },
                  });
                return reply.code(result === 'duplicate' ? 200 : 202).send({ status: result });
              } catch (error) {
                request.log.warn({ error }, 'Payment method removal was rejected.');
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the payment method removal.',
                  },
                });
              }
            },
          );
          app.post(
            '/v1/customer-portal/subscriptions/device-care',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'subscription.enroll',
                }),
              ],
            },
            async (request, reply) => {
              const parsed = enrollDeviceCareSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_DEVICE_CARE_ENROLLMENT',
                    message: 'Device Care enrollment input is invalid.',
                  },
                });
              try {
                return (
                  (await deviceCareRepository.enrollForSubject(
                    request.auth!.sub!,
                    parsed.data,
                    String(request.headers['x-correlation-id'] ?? randomUUID()),
                  )) ??
                  reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_PROFILE_NOT_FOUND',
                      message: 'Customer profile not found.',
                    },
                  })
                );
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message === 'DEVICE_CARE_CONFIGURATION_UNAVAILABLE'
                )
                  return reply.code(409).send({
                    error: {
                      code: 'DEVICE_CARE_CONFIGURATION_UNAVAILABLE',
                      message: 'A valid saved payment method and Device Care plan are required.',
                    },
                  });
                request.log.warn({ error }, 'Device Care enrollment was rejected.');
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the enrollment.',
                  },
                });
              }
            },
          );
          app.post(
            '/v1/customer-portal/subscriptions/device-care/cancel',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'subscription.cancel',
                }),
              ],
            },
            async (request, reply) => {
              const parsed = paymentMethodMutationSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_SUBSCRIPTION_CANCELLATION',
                    message: 'Subscription cancellation input is invalid.',
                  },
                });
              try {
                const result = await deviceCareRepository.cancelForSubject(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                );
                return (
                  result ??
                  reply.code(404).send({
                    error: {
                      code: 'ACTIVE_SUBSCRIPTION_NOT_FOUND',
                      message: 'Active Device Care subscription not found.',
                    },
                  })
                );
              } catch (error) {
                request.log.warn({ error }, 'Device Care cancellation was rejected.');
                if (error instanceof DeviceCareCancellationProviderUnavailableError)
                  return reply.code(409).send({
                    error: {
                      code: 'LEGACY_SUBSCRIPTION_PROVIDER_UNAVAILABLE',
                      message:
                        'This subscription provider is not currently configured for cancellation.',
                    },
                  });
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the cancellation.',
                  },
                });
              }
            },
          );
        }
      }
      if (paymentRepository) {
        const paymentRequirement = {
          applicationKey: 'core-admin',
          permissionKey: 'payment.manage',
        };
        app.post(
          '/v1/core-admin/payments',
          { preHandler: [authenticate, createAuthorizationGuard(authorizer, paymentRequirement)] },
          async (request, reply) => {
            const parsed = paymentRequestSchema.safeParse(request.body);
            if (!parsed.success)
              return reply
                .code(400)
                .send({ error: { code: 'INVALID_PAYMENT', message: 'Payment input is invalid.' } });
            try {
              return (
                (await paymentRepository.createForSubject(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'PAYMENT_ACTOR_NOT_FOUND',
                    message: 'Payment actor was not found.',
                  },
                })
              );
            } catch (error) {
              if (error instanceof PaymentProviderError)
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the request.',
                  },
                });
              throw error;
            }
          },
        );
        app.post(
          '/v1/core-admin/payments/:id/refunds',
          { preHandler: [authenticate, createAuthorizationGuard(authorizer, paymentRequirement)] },
          async (request, reply) => {
            const parsed = refundRequestSchema.safeParse(request.body);
            const id = (request.params as { id: string }).id;
            if (!parsed.success || !zUuid(id))
              return reply
                .code(400)
                .send({ error: { code: 'INVALID_REFUND', message: 'Refund input is invalid.' } });
            try {
              return (
                (await paymentRepository.refundForSubject(
                  request.auth!.sub!,
                  id,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply
                  .code(404)
                  .send({ error: { code: 'PAYMENT_NOT_FOUND', message: 'Payment was not found.' } })
              );
            } catch (error) {
              if (error instanceof PaymentProviderError)
                return reply.code(502).send({
                  error: {
                    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
                    message: 'Payment provider did not accept the request.',
                  },
                });
              if (error instanceof Error && error.message.startsWith('Refund amount exceeds'))
                return reply.code(422).send({
                  error: { code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT', message: error.message },
                });
              throw error;
            }
          },
        );
      }
      if (employeeRepository) {
        app.get(
          '/v1/employee-portal/profile',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'employee.profile.read',
              }),
            ],
          },
          async (request, reply) => {
            const profile = await employeeRepository.getForSubject(request.auth!.sub!);
            return (
              profile ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                  message: 'Employee profile not found.',
                },
              })
            );
          },
        );
      }
      if (timekeepingRepository) {
        const timekeepingRequirement = {
          applicationKey: 'employee-portal',
          permissionKey: 'timekeeping.self.manage',
        };
        app.get(
          '/v1/employee-portal/time-entries',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, timekeepingRequirement),
            ],
          },
          async (request, reply) => {
            const entries = await timekeepingRepository.listForSubject(request.auth!.sub!);
            return (
              entries ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                  message: 'Employee profile not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/employee-portal/time-entries',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, timekeepingRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = createTimeEntrySchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: { code: 'INVALID_TIME_ENTRY', message: 'Time entry input is invalid.' },
              });
            const entry = await timekeepingRepository.createForSubject(
              request.auth!.sub!,
              parsed.data,
            );
            return (
              entry ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                  message: 'Employee profile not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/employee-portal/time-entries/:id/corrections',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, timekeepingRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = createTimeCorrectionSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_TIME_CORRECTION',
                  message: 'Time correction input is invalid.',
                },
              });
            const params = request.params as { id: string };
            if (
              !params.id ||
              !createTimeEntrySchema.shape.idempotencyKey.safeParse(params.id).success
            )
              return reply.code(400).send({
                error: { code: 'INVALID_TIME_ENTRY', message: 'Time entry ID is invalid.' },
              });
            const correlationId = request.headers['x-correlation-id'];
            const entry = await timekeepingRepository.correctForSubject(
              request.auth!.sub!,
              params.id,
              parsed.data,
              typeof correlationId === 'string' ? correlationId : randomUUID(),
            );
            return (
              entry ??
              reply.code(404).send({
                error: { code: 'TIME_ENTRY_NOT_FOUND', message: 'Time entry not found.' },
              })
            );
          },
        );
      }
      if (mobileTimekeepingRepository) {
        const mobileTimekeepingRequirement = {
          applicationKey: 'employee-mobile',
          permissionKey: 'timekeeping.self.manage',
        };
        app.get(
          '/v1/employee-mobile/timekeeping-state',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, mobileTimekeepingRequirement),
            ],
          },
          async (request, reply) =>
            (await mobileTimekeepingRepository.mobileStateForSubject(request.auth!.sub!)) ??
            reply.code(404).send({
              error: { code: 'EMPLOYEE_PROFILE_NOT_FOUND', message: 'Employee profile not found.' },
            }),
        );
        app.post(
          '/v1/employee-mobile/time-events',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, mobileTimekeepingRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = mobileTimeEventSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_MOBILE_TIME_EVENT',
                  message: 'Mobile time event input is invalid.',
                },
              });
            try {
              return (
                (await mobileTimekeepingRepository.recordMobileEvent(
                  request.auth!.sub!,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply.code(404).send({
                  error: {
                    code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                    message: 'Employee profile not found.',
                  },
                })
              );
            } catch (error) {
              if (error instanceof MobileTimeEventError)
                return reply.code(409).send({
                  error: {
                    code: 'MOBILE_TIME_EVENT_CONFLICT',
                    message: 'Mobile time event conflicts with current state.',
                  },
                });
              throw error;
            }
          },
        );
      }
      if (quoteRepository) {
        const quoteLifecycleError = (error: unknown, reply: FastifyReply) => {
          if (!(error instanceof QuoteLifecycleError)) throw error;
          const code =
            error.code === 'QUOTE_NOT_FOUND' ? 404 : error.code === 'QUOTE_EXPIRED' ? 409 : 409;
          return reply.code(code).send({
            error: {
              code: error.code,
              message:
                error.code === 'QUOTE_NOT_FOUND'
                  ? 'Quote was not found.'
                  : error.code === 'QUOTE_EXPIRED'
                    ? 'Quote has expired.'
                    : 'Quote cannot complete that lifecycle action.',
            },
          });
        };
        const quoteId = (request: FastifyRequest) =>
          z.object({ id: z.uuid() }).safeParse(request.params).data?.id;
        const quoteStepUpGuard = async (request: FastifyRequest, reply: FastifyReply) => {
          if (
            !security?.stepUpClaim ||
            !security.stepUpValue ||
            hasStepUpAuthentication(request.auth!, security)
          )
            return;
          return reply.code(403).send({
            error: { code: 'STEP_UP_REQUIRED', message: 'Step-up authentication is required.' },
          });
        };
        app.post(
          '/v1/core-admin/quotes',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'quote.create',
              }),
            ],
          },
          async (request, reply) => {
            const parsed = createQuoteSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: { code: 'INVALID_QUOTE', message: 'Quote input is invalid.' },
              });
            try {
              const quote = await quoteRepository.createForSubject(
                request.auth!.sub!,
                parsed.data,
                typeof request.headers['x-correlation-id'] === 'string'
                  ? request.headers['x-correlation-id']
                  : randomUUID(),
              );
              return (
                quote ??
                reply.code(404).send({
                  error: { code: 'QUOTE_ACTOR_NOT_FOUND', message: 'Quote actor was not found.' },
                })
              );
            } catch (error) {
              if (error instanceof QuoteInputError)
                return reply.code(422).send({
                  error: {
                    code: 'UNQUOTABLE_CATALOG',
                    message: 'Catalog cannot price this quote.',
                  },
                });
              throw error;
            }
          },
        );
        if (quoteRepository.transitionForSubject) {
          for (const [pathAction, permissionKey, requiresStepUp] of [
            ['issue', 'quote.issue', false],
            ['approve', 'quote.approve', true],
            ['cancel', 'quote.cancel', false],
            ['expire', 'quote.issue', false],
          ] as const) {
            const action =
              pathAction === 'issue'
                ? 'issued'
                : pathAction === 'approve'
                  ? 'approved'
                  : pathAction === 'cancel'
                    ? 'cancelled'
                    : 'expired';
            app.post(
              `/v1/core-admin/quotes/:id/${pathAction}`,
              {
                preHandler: [
                  authenticate,
                  createAuthorizationGuard(authorizer, {
                    applicationKey: 'core-admin',
                    permissionKey,
                  }),
                  ...(requiresStepUp ? [quoteStepUpGuard] : []),
                ],
              },
              async (request, reply) => {
                const input = quoteLifecycleSchema.safeParse(request.body);
                const id = quoteId(request);
                if (!input.success || !id)
                  return reply.code(400).send({
                    error: {
                      code: 'INVALID_QUOTE_LIFECYCLE',
                      message: 'Quote lifecycle input is invalid.',
                    },
                  });
                try {
                  const quote = await quoteRepository.transitionForSubject!(
                    request.auth!.sub!,
                    id,
                    action,
                    input.data,
                    typeof request.headers['x-correlation-id'] === 'string'
                      ? request.headers['x-correlation-id']
                      : randomUUID(),
                  );
                  return (
                    quote ??
                    reply.code(404).send({
                      error: {
                        code: 'QUOTE_ACTOR_NOT_FOUND',
                        message: 'Quote actor was not found.',
                      },
                    })
                  );
                } catch (error) {
                  return quoteLifecycleError(error, reply);
                }
              },
            );
          }
        }
        if (quoteRepository.acceptForSubject) {
          app.post(
            '/v1/customer-portal/quotes/:id/accept',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'quote.self.accept',
                }),
              ],
            },
            async (request, reply) => {
              const input = quoteAcceptanceSchema.safeParse(request.body);
              const id = quoteId(request);
              if (!input.success || !id)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_QUOTE_ACCEPTANCE',
                    message: 'Quote acceptance input is invalid.',
                  },
                });
              try {
                const quote = await quoteRepository.acceptForSubject!(
                  request.auth!.sub!,
                  id,
                  input.data,
                  typeof request.headers['x-correlation-id'] === 'string'
                    ? request.headers['x-correlation-id']
                    : randomUUID(),
                );
                return (
                  quote ??
                  reply.code(404).send({
                    error: {
                      code: 'QUOTE_ACTOR_NOT_FOUND',
                      message: 'Quote actor was not found.',
                    },
                  })
                );
              } catch (error) {
                return quoteLifecycleError(error, reply);
              }
            },
          );
        }
        if (quoteRepository.reviseForSubject) {
          for (const [path, permissionKey, overrides] of [
            ['revisions', 'quote.revise', false],
            ['overrides', 'quote.override', true],
          ] as const) {
            app.post(
              `/v1/core-admin/quotes/:id/${path}`,
              {
                preHandler: [
                  authenticate,
                  createAuthorizationGuard(authorizer, {
                    applicationKey: 'core-admin',
                    permissionKey,
                  }),
                  ...(overrides ? [quoteStepUpGuard] : []),
                ],
              },
              async (request, reply) => {
                const input = quoteRevisionSchema.safeParse(request.body);
                const id = quoteId(request);
                if (!input.success || !id)
                  return reply.code(400).send({
                    error: {
                      code: 'INVALID_QUOTE_REVISION',
                      message: 'Quote revision input is invalid.',
                    },
                  });
                try {
                  const quote = await quoteRepository.reviseForSubject!(
                    request.auth!.sub!,
                    id,
                    input.data,
                    String(request.headers['x-correlation-id'] ?? randomUUID()),
                    overrides,
                  );
                  return (
                    quote ??
                    reply.code(404).send({
                      error: {
                        code: 'QUOTE_ACTOR_NOT_FOUND',
                        message: 'Quote actor was not found.',
                      },
                    })
                  );
                } catch (error) {
                  return quoteLifecycleError(error, reply);
                }
              },
            );
          }
        }
      }
      if (jobRepository) {
        if (jobRepository.createRepairRequestForSubject)
          app.post(
            '/v1/customer-portal/repair-requests',
            {
              preHandler: [
                authenticate,
                createAuthorizationGuard(authorizer, {
                  applicationKey: 'customer-portal',
                  permissionKey: 'repair-request.create',
                }),
              ],
            },
            async (request, reply) => {
              const parsed = customerRepairRequestSchema.safeParse(request.body);
              if (!parsed.success)
                return reply.code(400).send({
                  error: {
                    code: 'INVALID_REPAIR_REQUEST',
                    message: 'Repair request input is invalid.',
                  },
                });
              try {
                return (
                  (await jobRepository.createRepairRequestForSubject!(
                    request.auth!.sub!,
                    parsed.data,
                    String(request.headers['x-correlation-id'] ?? randomUUID()),
                  )) ??
                  reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_PROFILE_NOT_FOUND',
                      message: 'Customer profile not found.',
                    },
                  })
                );
              } catch (error) {
                if (error instanceof JobTransitionError)
                  return reply.code(404).send({
                    error: {
                      code: 'CUSTOMER_RESOURCE_NOT_FOUND',
                      message: 'Requested customer resource was not found.',
                    },
                  });
                throw error;
              }
            },
          );
        app.post(
          '/v1/core-admin/jobs',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'job.create',
              }),
            ],
          },
          async (request, reply) => {
            const parsed = createJobSchema.safeParse(request.body);
            if (!parsed.success)
              return reply
                .code(400)
                .send({ error: { code: 'INVALID_JOB', message: 'Job input is invalid.' } });
            const job = await jobRepository.createForSubject(
              request.auth!.sub!,
              parsed.data,
              typeof request.headers['x-correlation-id'] === 'string'
                ? request.headers['x-correlation-id']
                : randomUUID(),
            );
            return (
              job ??
              reply.code(404).send({
                error: { code: 'JOB_ACTOR_NOT_FOUND', message: 'Job actor was not found.' },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/jobs/:id/transitions',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'job.transition',
              }),
            ],
          },
          async (request, reply) => {
            const parsed = transitionJobSchema.safeParse(request.body);
            const id = (request.params as { id: string }).id;
            if (!parsed.success || !zUuid(id))
              return reply.code(400).send({
                error: {
                  code: 'INVALID_JOB_TRANSITION',
                  message: 'Job transition input is invalid.',
                },
              });
            try {
              const job = await jobRepository.transitionForSubject(
                request.auth!.sub!,
                id,
                parsed.data,
                typeof request.headers['x-correlation-id'] === 'string'
                  ? request.headers['x-correlation-id']
                  : randomUUID(),
              );
              return (
                job ??
                reply
                  .code(404)
                  .send({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } })
              );
            } catch (error) {
              if (error instanceof JobTransitionError)
                return reply.code(409).send({
                  error: {
                    code: 'INVALID_JOB_TRANSITION',
                    message: 'Job transition is not allowed.',
                  },
                });
              throw error;
            }
          },
        );
      }
      if (jobRepository?.listForAssignedSubject && jobRepository.transitionForAssignedSubject) {
        const mobileJobRequirement = {
          applicationKey: 'employee-mobile',
          permissionKey: 'job.self.read',
        };
        app.get(
          '/v1/employee-mobile/jobs',
          {
            preHandler: [authenticate, createAuthorizationGuard(authorizer, mobileJobRequirement)],
          },
          async (request, reply) =>
            (await jobRepository.listForAssignedSubject!(request.auth!.sub!)) ??
            reply.code(404).send({
              error: { code: 'EMPLOYEE_PROFILE_NOT_FOUND', message: 'Employee profile not found.' },
            }),
        );
        app.post(
          '/v1/employee-mobile/jobs/:id/transitions',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-mobile',
                permissionKey: 'job.self.transition',
              }),
            ],
          },
          async (request, reply) => {
            const parsed = transitionJobSchema.safeParse(request.body);
            const id = (request.params as { id: string }).id;
            if (!parsed.success || !zUuid(id))
              return reply.code(400).send({
                error: {
                  code: 'INVALID_JOB_TRANSITION',
                  message: 'Job transition input is invalid.',
                },
              });
            try {
              return (
                (await jobRepository.transitionForAssignedSubject!(
                  request.auth!.sub!,
                  id,
                  parsed.data,
                  String(request.headers['x-correlation-id'] ?? randomUUID()),
                )) ??
                reply
                  .code(404)
                  .send({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } })
              );
            } catch (error) {
              if (error instanceof JobTransitionError)
                return reply.code(409).send({
                  error: {
                    code: 'INVALID_JOB_TRANSITION',
                    message: 'Job transition is not allowed.',
                  },
                });
              throw error;
            }
          },
        );
      }
      if (subscriptionPlanRepository) {
        app.post(
          '/v1/executive/subscription-plan-versions',
          {
            preHandler: [
              authenticate,
              async (request, reply) => {
                if (
                  !security ||
                  !security.stepUpClaim ||
                  !security.stepUpValue ||
                  hasStepUpAuthentication(request.auth!, security)
                )
                  return;
                return reply.code(403).send({
                  error: {
                    code: 'STEP_UP_REQUIRED',
                    message: 'Step-up authentication is required.',
                  },
                });
              },
              createAuthorizationGuard(authorizer, {
                applicationKey: 'executive-panel',
                permissionKey: 'subscription.plan.manage',
              }),
            ],
          },
          async (request, reply) => {
            const parsed = subscriptionPlanVersionSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_SUBSCRIPTION_PLAN',
                  message: 'Subscription plan input is invalid.',
                },
              });
            const version = await subscriptionPlanRepository.createVersion(
              request.auth!.sub!,
              parsed.data,
              typeof request.headers['x-correlation-id'] === 'string'
                ? request.headers['x-correlation-id']
                : randomUUID(),
            );
            return (
              version ??
              reply.code(404).send({
                error: {
                  code: 'SUBSCRIPTION_PLAN_ACTOR_NOT_FOUND',
                  message: 'Subscription plan actor was not found.',
                },
              })
            );
          },
        );
      }
      if (compensationRepository) {
        const compensationRequirement = {
          applicationKey: 'core-admin',
          permissionKey: 'compensation.manage',
        };
        app.post(
          '/v1/core-admin/compensation-assignments',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, compensationRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = assignCompensationSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: {
                  code: 'INVALID_COMPENSATION_ASSIGNMENT',
                  message: 'Compensation assignment input is invalid.',
                },
              });
            return (
              (await compensationRepository.assign(
                request.auth!.sub!,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply.code(404).send({
                error: {
                  code: 'COMPENSATION_ACTOR_NOT_FOUND',
                  message: 'Compensation actor was not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/commissions',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, compensationRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = createCommissionSchema.safeParse(request.body);
            if (!parsed.success)
              return reply.code(400).send({
                error: { code: 'INVALID_COMMISSION', message: 'Commission input is invalid.' },
              });
            return (
              (await compensationRepository.createCommission(
                request.auth!.sub!,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply.code(404).send({
                error: {
                  code: 'COMPENSATION_PLAN_NOT_FOUND',
                  message: 'Compensation plan was not found.',
                },
              })
            );
          },
        );
        app.post(
          '/v1/core-admin/commissions/:id/events',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, compensationRequirement),
            ],
          },
          async (request, reply) => {
            const parsed = commissionEventSchema.safeParse(request.body);
            const id = (request.params as { id: string }).id;
            if (!parsed.success || !zUuid(id))
              return reply.code(400).send({
                error: {
                  code: 'INVALID_COMMISSION_EVENT',
                  message: 'Commission event input is invalid.',
                },
              });
            return (
              (await compensationRepository.addCommissionEvent(
                request.auth!.sub!,
                id,
                parsed.data,
                String(request.headers['x-correlation-id'] ?? randomUUID()),
              )) ??
              reply.code(404).send({
                error: { code: 'COMMISSION_NOT_FOUND', message: 'Commission was not found.' },
              })
            );
          },
        );
        app.get(
          '/v1/employee-portal/earnings-estimate',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'earnings.self.read',
              }),
            ],
          },
          async (request, reply) =>
            (await compensationRepository.earnings(request.auth!.sub!)) ??
            reply.code(404).send({
              error: {
                code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                message: 'Employee profile was not found.',
              },
            }),
        );
      }
      if (reportingRepository)
        app.get(
          '/v1/executive/overview',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'executive-panel',
                permissionKey: 'reporting.read',
              }),
            ],
          },
          async (request) => reportingRepository.overviewForSubject(request.auth!.sub!),
        );
      if (reportingRepository)
        app.get(
          '/v1/executive/operating-aggregates',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'executive-panel',
                permissionKey: 'reporting.read',
              }),
            ],
          },
          async (request) => reportingRepository.listForSubject(request.auth!.sub!),
        );
    }
  }
  return app;
}

function zUuid(value: string | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value ?? '',
  );
}
