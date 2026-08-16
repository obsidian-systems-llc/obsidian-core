import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { createAuthorizationGuard, type Authorizer } from './authorization.js';
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
  createTimeCorrectionSchema,
  createTimeEntrySchema,
  mobileTimeEventSchema,
  MobileTimeEventError,
  type MobileTimekeepingRepository,
  type TimekeepingRepository,
} from './timekeeping.js';
import { createQuoteSchema, QuoteInputError, type QuoteRepository } from './quotes.js';
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
  squareWebhookEventSchema,
  verifySquareWebhookSignature,
} from './payments.js';
import {
  enrollDeviceCareSchema,
  paymentMethodMutationSchema,
  savePaymentMethodSchema,
  SquareDeviceCareProviderError,
  type DeviceCareRepository,
} from './device-care.js';
import type { DeviceCareWallet } from './device-care-wallet.js';
import {
  CommunicationWorkflowError,
  communicationDoNotCallSchema,
  communicationLeadSchema,
  communicationRepairJobSchema,
  retellWebhookSchema,
  verifyRetellWebhook,
  type RetellCallRepository,
} from './retell.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
    rawBody?: string;
  }
}

export type BuildAppOptions = {
  databaseUrl?: string;
  authorizer?: Authorizer;
  organizationRepository?: OrganizationRepository;
  customerRepository?: CustomerRepository;
  employeeRepository?: EmployeeRepository;
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
  squareWebhookRepository?: Pick<PaymentRepository, 'processSquareWebhook'>;
  squareWebhooks?: {
    production?: SquareWebhookConfiguration | undefined;
    sandbox?: SquareWebhookConfiguration | undefined;
  };
  retell?: { apiKey: string; repository: RetellCallRepository };
  apiSecurity?: ApiSecurityConfig;
  verifyToken?: TokenVerifier;
};

export function buildApp({
  databaseUrl,
  authorizer,
  organizationRepository,
  customerRepository,
  employeeRepository,
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
  squareWebhookRepository,
  squareWebhooks,
  retell,
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
                  error instanceof SquareDeviceCareProviderError
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
