import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const queueDepth = new Counter({
  name: 'lootgoblin_queue_items_total',
  help: 'Queue items by status',
  labelNames: ['status'],
  registers: [registry],
});

export const fetchDuration = new Histogram({
  name: 'lootgoblin_fetch_duration_seconds',
  help: 'Source fetch duration',
  labelNames: ['source_id', 'outcome'],
  registers: [registry],
});

export const packagerDuration = new Histogram({
  name: 'lootgoblin_packager_duration_seconds',
  help: 'Packager duration',
  labelNames: ['packager'],
  registers: [registry],
});
