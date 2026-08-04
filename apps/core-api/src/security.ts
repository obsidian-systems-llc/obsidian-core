import type { FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';

export type ApiSecurityConfig = {
  allowedOrigins: string[];
  sensitiveRateLimitMax: number;
  sensitiveRateLimitWindowMs: number;
  stepUpClaim: string | undefined;
  stepUpValue: string | undefined;
};

export class SensitiveRouteRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > now - this.windowMs,
    );
    if (recent.length >= this.max) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }
}

export function isSensitiveRoute(request: FastifyRequest): boolean {
  return request.method !== 'GET' && request.method !== 'HEAD' && request.url.startsWith('/v1/');
}

export function isOriginAllowed(origin: string | undefined, config: ApiSecurityConfig): boolean {
  return Boolean(origin && config.allowedOrigins.includes(origin));
}

export function hasStepUpAuthentication(payload: JWTPayload, config: ApiSecurityConfig): boolean {
  if (!config.stepUpClaim || !config.stepUpValue) return false;
  const value = payload[config.stepUpClaim];
  return Array.isArray(value) ? value.includes(config.stepUpValue) : value === config.stepUpValue;
}
