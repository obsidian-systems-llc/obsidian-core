import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
const app = buildApp();
afterAll(async () => {
  await app.close();
});
describe('GET /health', () => {
  it('returns the service health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('propagates a supplied correlation ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'test-correlation-id' },
    });
    expect(response.headers['x-correlation-id']).toBe('test-correlation-id');
  });

  it('does not report ready when the database is unavailable', async () => {
    const unavailableApp = buildApp('postgresql://invalid:invalid@127.0.0.1:1/invalid');
    const response = await unavailableApp.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await unavailableApp.close();
  });
});
