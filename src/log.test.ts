import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log.ts', () => {
  it('stores logs in buffer and trims to configured max size', async () => {
    vi.stubEnv('LOG_BUFFER_MAX_ENTRIES', '2');
    const { log, getRecentLogs } = await import('./log.js');

    log.info('first', { a: 1 });
    log.info('second', { a: 2 });
    log.info('third', { a: 3 });

    const recent = getRecentLogs(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].msg).toBe('second');
    expect(recent[1].msg).toBe('third');
  });

  it('includes error entries in metrics and recent logs', async () => {
    vi.stubEnv('LOG_BUFFER_MAX_ENTRIES', '10');
    const { log, getRecentLogs, getLogMetrics } = await import('./log.js');

    log.info('ok_event');
    log.error('bad_event', { code: 'E_TEST' });

    const recent = getRecentLogs(5);
    expect(recent.some((e) => e.level === 'error' && e.msg === 'bad_event')).toBe(true);

    const metrics = getLogMetrics('1h');
    expect(metrics.total).toBeGreaterThanOrEqual(2);
    expect(metrics.byLevel.error).toBeGreaterThanOrEqual(1);
    expect(metrics.byMessage.bad_event).toBeGreaterThanOrEqual(1);
  });
});
