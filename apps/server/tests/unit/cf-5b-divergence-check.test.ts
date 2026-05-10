import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDivergenceCheck, CF_5B_SINGLE_COLOR_RATIO, CF_5B_MULTI_MATERIAL_RATIO, CF_5B_MIN_GRAMS } from '../../src/forge/status/divergence/check';
import { logger } from '../../src/logger';

describe('runDivergenceCheck — V2-005f-CF-5b T_b2', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports thresholds: SINGLE_COLOR=0.50, MULTI_MATERIAL=0.40, MIN_GRAMS=10', () => {
    expect(CF_5B_SINGLE_COLOR_RATIO).toBe(0.50);
    expect(CF_5B_MULTI_MATERIAL_RATIO).toBe(0.40);
    expect(CF_5B_MIN_GRAMS).toBe(10);
  });

  it('logs ratio for every completed print regardless of threshold', async () => {
    const logSpy = vi.spyOn(logger, 'info');
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: 30 }],
      emitWarning,
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchJobId: 'd1', divergenceRatio: 0.6 }),
      expect.stringContaining('cf-5b: divergence ratio recorded'),
    );
  });

  it('emits warning when single-color ratio < 0.50', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: 20 }],  // ratio 0.4
      emitWarning,
    });
    expect(emitWarning).toHaveBeenCalledWith(expect.objectContaining({
      dispatchJobId: 'd1', errorCode: 'divergence-detected', protocol: 'forge-cf-5b', severity: 'warning',
    }));
  });

  it('does NOT emit warning when single-color ratio >= 0.50', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: 30 }],  // ratio 0.6
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('emits warning when multi-material aggregate < 0.40', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [
        { slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: 10 },
        { slot_index: 1, material_id: 'm2', estimated_grams: 50, measured_grams: 25 },
      ],  // total 100/35 = ratio 0.35
      emitWarning,
    });
    expect(emitWarning).toHaveBeenCalled();
  });

  it('does NOT emit when multi-material aggregate >= 0.40', async () => {
    /* 2 slots, total 100g estimated, 50g measured, ratio 0.5 — no warning */
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [
        { slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: 25 },
        { slot_index: 1, material_id: 'm2', estimated_grams: 50, measured_grams: 25 },
      ],  // total 100/50 = ratio 0.5 >= 0.40
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('skips when total estimated < CF_5B_MIN_GRAMS', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 5, measured_grams: 0 }],
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('skips when no measured side (all measured_grams null)', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: null }],
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('clamps negative measured_grams to 0 (firmware tare-error edge case)', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 50, measured_grams: -3.2 }],
      emitWarning,
    });
    // Negative clamped to 0 → totalMeasured=0, ratio=0, < 0.50 → emit fires
    // (the warning IS legitimate — printer reported negative consumption, very likely failed print
    //  or sensor fault — but the message must show ratio 0.0, not negative ratio)
    expect(emitWarning).toHaveBeenCalled();
    const call = emitWarning.mock.calls[0]![0];
    expect(call.message).toContain('measured 0.0g');
    expect(call.message).not.toContain('-');  // no negative number in message
  });

  it('skips when materialsUsed is empty', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [],
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('does NOT emit at exact single-color threshold (ratio = 0.50)', async () => {
    const emitWarning = vi.fn();
    await runDivergenceCheck({
      dispatchJobId: 'd1',
      materialsUsed: [{ slot_index: 0, material_id: 'm1', estimated_grams: 100, measured_grams: 50 }],  // ratio 0.50 exactly
      emitWarning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });
});
