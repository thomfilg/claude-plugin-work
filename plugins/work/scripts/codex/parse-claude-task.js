#!/usr/bin/env node

const {
  ClaudeDelegateParseError,
  parseClaudeTask,
  parseClaudeTasks,
  toCodexAgentDelegate,
} = require('./parse-claude-delegates');

module.exports = {
  ClaudeTaskParseError: ClaudeDelegateParseError,
  parseClaudeTask,
  parseClaudeTasks,
  toCodexAgentDelegate,
};

if (require.main === module) {
  require('./parse-claude-delegates');
}
