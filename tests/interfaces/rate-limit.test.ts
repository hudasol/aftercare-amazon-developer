import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createContainer, type Container } from '../../src/container.js';
import { createHttpApp } from '../../src/interfaces/http/app.js';
import { rateLimit } from '../../src/interfaces/http/rate-limit.js';

describe('rate limit configuration', () => {
  it('is on with a generous default, and trusts the proxy only on Render or when asked', () => {
    const local = loadConfig({});
    expect(local.AFTERCARE_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(local.AFTERCARE_TRUST_PROXY).toBe(false);
    expect(loadConfig({ RENDER: 'true' }).AFTERCARE_TRUST_PROXY).toBe(true);
    expect(
      loadConfig({ RENDER: 'true', AFTERCARE_TRUST_PROXY: 'false' }).AFTERCARE_TRUST_PROXY,
    ).toBe(false);
    expect(
      loadConfig({ AFTERCARE_RATE_LIMIT_PER_MINUTE: '0' }).AFTERCARE_RATE_LIMIT_PER_MINUTE,
    ).toBe(0);
  });
});

describe('rate limit on /api and /mcp', () => {
  let dir: string;
  let container: Container;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aftercare-limit-'));
    container = createContainer({
      databasePath: join(dir, 'limit.db'),
      demoCustomer: 'cus_demo_maya',
    });
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: p } = probe.address() as AddressInfo;
        probe.close(() => resolve(p));
      });
    });
    server = await new Promise<Server>((resolve) => {
      const s = createHttpApp(
        container,
        loadConfig({
          PORT: String(port),
          HOST: '127.0.0.1',
          SERVE_WEB: 'false',
          AFTERCARE_RATE_LIMIT_PER_MINUTE: '3',
          AFTERCARE_TRUST_PROXY: 'true',
        }),
      ).listen(port, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    container.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers 429 with a clear message once a client exceeds the limit', async () => {
    const as = (ip: string) => ({ headers: { 'x-forwarded-for': `203.0.113.9, ${ip}` } });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base}/api/health`, as('198.51.100.1'))).status).toBe(200);
    }
    const limited = await fetch(`${base}/api/cases`, as('198.51.100.1'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    const mcp = await fetch(`${base}/mcp`, { ...as('198.51.100.1'), method: 'POST' });
    expect(mcp.status).toBe(429);
    // Another client is not affected.
    expect((await fetch(`${base}/api/health`, as('198.51.100.2'))).status).toBe(200);
  });
});

describe('rate limit window', () => {
  it('starts a fresh window after a minute and can be turned off', () => {
    let t = 0;
    const statuses: number[] = [];
    const limiter = rateLimit({ perMinute: 1, trustProxy: false, now: () => t });
    const call = (mw: ReturnType<typeof rateLimit>) => {
      const res = {
        status: (code: number) => {
          statuses.push(code);
          return res;
        },
        set: () => res,
        json: () => res,
      };
      mw({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, res as never, () =>
        statuses.push(200),
      );
    };
    call(limiter);
    call(limiter);
    t = 60_000;
    call(limiter);
    call(rateLimit({ perMinute: 0, trustProxy: false }));
    expect(statuses).toEqual([200, 429, 200, 200]);
  });
});
