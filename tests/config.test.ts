import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('refuses a non-loopback host without a token', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/AFTERCARE_ACCESS_TOKEN/);
  });

  it('accepts a non-loopback host with a token', () => {
    const config = loadConfig({
      HOST: '0.0.0.0',
      AFTERCARE_ACCESS_TOKEN: 'a-very-long-test-token',
    });
    expect(config.AFTERCARE_PUBLIC_DEMO).toBe(false);
  });

  it('accepts a non-loopback host without a token only when public demo mode is explicit', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0', AFTERCARE_PUBLIC_DEMO: 'false' })).toThrow();
    expect(() => loadConfig({ HOST: '0.0.0.0', AFTERCARE_PUBLIC_DEMO: 'yes' })).toThrow();
    const config = loadConfig({ HOST: '0.0.0.0', AFTERCARE_PUBLIC_DEMO: 'true' });
    expect(config.AFTERCARE_PUBLIC_DEMO).toBe(true);
    expect(config.AFTERCARE_ACCESS_TOKEN).toBeUndefined();
  });
});
