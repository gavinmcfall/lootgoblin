export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    startOtel();
  }
}
