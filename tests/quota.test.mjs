import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getQuotaSnapshot, calibrateQuotaGroup, QuotaProvider } from '../src/core/quota.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Quota engine classifies 3 model groups, deducts from calibrated baseline, rolls over after reset, and supports QuotaProvider', () => {
  const root = makeTmpDir('cc-quota-');
  const dataDir = path.join(root, 'data');

  try {
    const tCal = Date.parse('2026-11-22T00:00:00Z');
    const hourMs = 3600 * 1000;

    // Calibrate Gemini group at 80% weekly (10h left) and 90% 5h (120m left)
    calibrateQuotaGroup(
      {
        groupId: 'gemini',
        weeklyPct: 80,
        weeklyHrs: 10,
        h5Pct: 90,
        h5Mins: 120,
        weeklyBudgetTokens: 1_000_000,
        h5BudgetTokens: 200_000,
        nowMs: tCal,
      },
      { dataDir }
    );

    const calls = [
      // Pre-calibration call (should not double-deduct from calibrated baseline)
      {
        model: 'gemini-4-neon-high',
        tsMs: tCal - hourMs,
        inputTokens: 100_000,
        cacheReadTokens: 0,
        outputTokens: 0,
      },
      // Post-calibration Gemini call: 100k fresh in + 0 cache + 0 out = 100k weighted (10% of 1M weekly, 50% of 200K 5h)
      {
        model: 'gemini-4-neon-high',
        tsMs: tCal + hourMs,
        inputTokens: 100_000,
        cacheReadTokens: 200_000, // 20k weighted -> total 120k weighted => -12% weekly, -60% 5h
        outputTokens: 0,
      },
      // Claude call -> claude_gpt group
      {
        model: 'claude-4-sonnet',
        tsMs: tCal + hourMs,
        inputTokens: 80_000,
        cacheReadTokens: 100_000,
        outputTokens: 2_000,
      },
      // Argon call -> argon group (no 5h window)
      {
        model: 'gemini-4-argon',
        tsMs: tCal + hourMs,
        inputTokens: 50_000,
        cacheReadTokens: 0,
        outputTokens: 1_000,
      },
    ];

    // Check 1h after calibration (before 5h & weekly reset)
    const snap1 = getQuotaSnapshot({ calls, nowMs: tCal + hourMs + 1000 }, { dataDir });
    assert.equal(snap1.provider, 'local-calibrated');
    assert.equal(snap1.groups.length, 3);

    const gGem = snap1.groups.find((g) => g.id === 'gemini');
    const gClaude = snap1.groups.find((g) => g.id === 'claude_gpt');
    const gArgon = snap1.groups.find((g) => g.id === 'argon');

    assert.equal(gGem.calibrated, true);
    assert.equal(gGem.weeklyPct, 68); // 80 - 12
    assert.equal(gGem.h5Pct, 30); // 90 - 60
    assert.equal(gGem.weeklyHrs, 9);
    assert.equal(gGem.h5Mins, 60);

    assert.equal(gClaude.localCalls5h, 1);
    assert.equal(gArgon.h5Pct, null);
    assert.equal(gArgon.localCalls7d, 1);
    assert.equal(snap1.weeklyChart.length, 7);
    assert.ok(snap1.savings7d.savedUsd > 0);

    // Check 12h after calibration (past both 5h and 10h weekly reset -> auto-rolled into fresh cycle!)
    const snap2 = getQuotaSnapshot({ calls, nowMs: tCal + 12 * hourMs }, { dataDir });
    const gGemReset = snap2.groups.find((g) => g.id === 'gemini');
    assert.equal(gGemReset.weeklyPct, 100);
    assert.equal(gGemReset.h5Pct, 100);
    assert.equal(gGemReset.calibrated, false);

    // Custom QuotaProvider port
    class MockOfficialProvider extends QuotaProvider {
      constructor() {
        super('official-mock');
      }
      getSnapshot() {
        return { provider: this.name, groups: [], weeklyChart: [], savings7d: { savedUsd: 0, avgCacheHitPct: 0 } };
      }
    }
    const snapCustom = getQuotaSnapshot({ calls }, { dataDir, provider: new MockOfficialProvider() });
    assert.equal(snapCustom.provider, 'official-mock');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
