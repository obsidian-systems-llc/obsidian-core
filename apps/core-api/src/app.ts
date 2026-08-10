import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { createAuthorizationGuard, type Authorizer } from './authorization.js';
import { checkDatabase } from './health.js';
import type { OrganizationRepository } from './organizations.js';
import type { CustomerRepository } from './customers.js';
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

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
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
  apiSecurity,
  verifyToken,
}: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] } });
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
      reply.header('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
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
  if (verifyToken) {
    const authenticate = createAuthenticationGuard(verifyToken);
    app.get('/v1/identity/me', { preHandler: authenticate }, async (request) => ({
      subject: request.auth?.sub,
    }));
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
