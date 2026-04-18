import { describe, it, expect } from 'vitest';
import { registry, queueDepth } from '../../src/metrics';

describe('metrics', () => {
  it('exposes default + custom counters in Prometheus text format', async () => {
    queueDepth.inc({ status: 'queued' });
    const out = await registry.metrics();
    expect(out).toContain('lootgoblin_queue_items_total');
    expect(out).toContain('process_cpu_user_seconds_total'); // from collectDefaultMetrics
  });
});
