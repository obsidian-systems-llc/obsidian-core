import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
const app = buildApp();
afterAll(async () => {
  await app.close();
});
describe('core-api health integration', () => {
  it('serves through the HTTP application boundary', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});
