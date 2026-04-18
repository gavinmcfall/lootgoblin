import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { env } from './env';
import { logger } from './logger';

let started = false;

export function startOtel(): void {
  if (started || !env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-winston': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
    })],
  });
  sdk.start();
  started = true;
  logger.info({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'otel started');
}
