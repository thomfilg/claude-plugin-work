#!/usr/bin/env node
/**
 * Get current JIRA ticket ID from worktree path or git branch.
 *
 * Usage: node ~/.claude/scripts/get-ticket-id.js
 * Output: APPSUPEN-XXX or empty string if not found
 */

const { execSync } = require('child_process');

function getCurrentTaskId(cwd = process.cwd()) {
  // Try to get from worktree folder name (e.g., app-services-monitoring-APPSUPEN-857)
  const worktreeMatch = cwd.match(/APPSUPEN-(\d+)/i);
  if (worktreeMatch) {
    return `APPSUPEN-${worktreeMatch[1]}`;
  }

  // Try to get from git branch name
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const branchMatch = branch.match(/APPSUPEN-(\d+)/i);
    if (branchMatch) {
      return `APPSUPEN-${branchMatch[1]}`;
    }
  } catch {
    // Ignore git errors
  }

  return '';
}

// When run directly, output the ticket ID
if (require.main === module) {
  console.log(getCurrentTaskId());
}

module.exports = { getCurrentTaskId };
