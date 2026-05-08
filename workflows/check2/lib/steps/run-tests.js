/**
 * Step: 4_run_tests — Run automated tests inline (deterministic).
 * If tests fail, returns blocked so work-next.js can transition back to implement.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Run quality gate and return { output, exitCode, tier }.
 */
function runQualityGate(checkHooksDir) {
  // Tier 1: pnpm dev:check
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts['dev:check']) {
      try {
        const output = execSync('pnpm dev:check 2>&1', { encoding: 'utf8', timeout: 120000 });
        return { output, exitCode: 0, tier: 'pnpm dev:check' };
      } catch (err) {
        return {
          output: (err.stdout || '') + (err.stderr || ''),
          exitCode: err.status || 1,
          tier: 'pnpm dev:check',
        };
      }
    }
  } catch {
    /* no package.json */
  }

  // Tier 2: bundled dev-check script
  const devCheckScript = path.join(
    checkHooksDir,
    '..',
    '..',
    'scripts',
    'dev-check',
    'dev-check.sh'
  );
  if (fs.existsSync(devCheckScript)) {
    try {
      const output = execSync(`bash "${devCheckScript}" 2>&1`, {
        encoding: 'utf8',
        timeout: 120000,
      });
      return { output, exitCode: 0, tier: 'dev-check.sh' };
    } catch (err) {
      return {
        output: (err.stdout || '') + (err.stderr || ''),
        exitCode: err.status || 1,
        tier: 'dev-check.sh',
      };
    }
  }

  // Tier 3: pnpm test or node --test
  try {
    const output = execSync('pnpm test 2>&1 || node --test 2>&1', {
      encoding: 'utf8',
      timeout: 120000,
    });
    return { output, exitCode: 0, tier: 'pnpm test' };
  } catch (err) {
    return {
      output: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status || 1,
      tier: 'pnpm test',
    };
  }
}

module.exports = function registerRunTests(register) {
  register('4_run_tests', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';
    const reportPath = path.join(reportFolder, 'tests.check.md');

    const result = runQualityGate(ctx.checkHooksDir);

    // Parse counts
    const passMatch = result.output.match(/pass\s+(\d+)/i);
    const failMatch = result.output.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? passMatch[1] : '?';
    const failCount = failMatch ? failMatch[1] : '?';
    const status = result.exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    // Write report
    const report = [
      `**Changes Hash:** ${changesHash}`,
      '',
      `Status: ${status}`,
      '',
      '# Test Results Report',
      '',
      `**Runner:** ${result.tier}`,
      `**Exit code:** ${result.exitCode}`,
      `**Pass:** ${passCount} | **Fail:** ${failCount}`,
      '',
      '## Output',
      '```',
      result.output.substring(0, 5000),
      '```',
      '',
      '## Verdict',
      `**${status}**${result.exitCode === 0 ? ' - All tests pass' : ` - ${failCount} test(s) failing`}`,
    ].join('\n');

    fs.writeFileSync(reportPath, report);

    if (result.exitCode !== 0) {
      // Tests failed — signal back to work-next.js to transition to implement
      state.testsFailed = true;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '4_run_tests', progress: '4/9' },
        reason: `Tests failed (${failCount} failing). Needs fix in implement step.`,
        report: reportPath,
      };
    }

    return null; // auto-advance
  });
};
