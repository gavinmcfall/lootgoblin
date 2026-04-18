import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makerworld } from '../../src/adapters/makerworld';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '../fixtures/makerworld');
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => server.resetHandlers());

describe('MakerWorld adapter', () => {
  it('fetches metadata + default-instance 3MF', async () => {
    const endpoints = JSON.parse(
      await fs.readFile(path.join(FIX, 'endpoints-reference.json'), 'utf8'),
    );

    server.use(
      http.get(
        'https://makerworld.com/api/v1/design-service/design/2663598',
        () => HttpResponse.json(endpoints.design),
      ),
      http.get(
        /makerworld\.com\/api\/v1\/design-service\/instance\/\d+\/f3mf/,
        () => HttpResponse.json({ name: 'test.3mf', url: 'https://cdn/file.3mf' }),
      ),
      http.get(
        'https://cdn/file.3mf',
        () => HttpResponse.arrayBuffer(new ArrayBuffer(128)),
      ),
    );

    const blob = JSON.stringify({
      cookies: [{ name: 'session', value: 'xxx', domain: '.makerworld.com' }],
    });

    const item = await makerworld.fetch('2663598', blob);

    expect(item.sourceItemId).toBe('2663598');
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.designer.name.length).toBeGreaterThan(0);
    expect(item.files.length).toBeGreaterThan(0);
    expect(item.files[0].mediaType).toBe('model/3mf');
  });

  it('maps 401 → CredentialInvalidError', async () => {
    server.use(
      http.get(
        'https://makerworld.com/api/v1/design-service/design/999',
        () => new HttpResponse(null, { status: 401 }),
      ),
    );

    const blob = JSON.stringify({ cookies: [] });
    await expect(makerworld.fetch('999', blob)).rejects.toMatchObject({
      name: 'CredentialInvalidError',
    });
  });

  it('maps 403 → PermissionDeniedError', async () => {
    server.use(
      http.get(
        'https://makerworld.com/api/v1/design-service/design/999',
        () => new HttpResponse(null, { status: 403 }),
      ),
    );

    const blob = JSON.stringify({ cookies: [] });
    await expect(makerworld.fetch('999', blob)).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      retryable: false,
    });
  });
});
