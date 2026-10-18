import { USAGE } from './cli-usage.mjs';
import { UsageError } from './cli/options.mjs';

export const pipelineCommands = new Set([
  'activity-stats', 'audit-jsonl', 'cluster-problems', 'compact-jsonl',
  'dashboard-complexity', 'discover-workflows', 'doctor', 'hash-payloads',
  'ingest', 'ingest-jsonl', 'issue-status', 'operational-value',
  'prune-dashboard', 'recycle-cache', 'validate-activity-data'
]);

export function pipelineUsage() {
  const commands = USAGE.split('\n').filter((line) =>
    /^  cao /.test(line) && pipelineCommands.has(line.split(' ')[3]));
  return [
    'Usage: ./cao.sh COMMAND [OPTIONS]',
    ...commands.map((line) => line.replace('cao ', './cao.sh ')),
    '  ./cao.sh setup-auth hosted-cli [OPTIONS]',
    '',
    'Operator commands have moved to the compiled Go extension: gh cao --help.',
    'Control-plane validation runs only in Actions: gh workflow run cao-validate.yml.',
    'doctor here checks/repairs SQLite; gh cao doctor diagnoses the installation.',
    'setup-auth is retained only for the hosted-cli App profile.'
  ].join('\n');
}

export function checkPipelineCommand(arguments_) {
  const [command, profile] = arguments_;
  if (!command || ['--help', '-h', 'help'].includes(command)) return pipelineUsage();
  if (pipelineCommands.has(command) || command === 'setup-auth' && profile === 'hosted-cli') {
    if (arguments_.includes('--help') || arguments_.includes('-h')) return pipelineUsage();
    return;
  }
  if (command === 'validate') {
    throw new UsageError('Control-plane validation runs only in Actions; use gh workflow run cao-validate.yml after publishing reviewed changes.');
  }
  const replacement = {
    add: profile === '--repository' ? 'repos add OWNER/REPO' : 'campaigns add CAMPAIGN',
    mode: 'campaigns mode', enable: 'campaigns enable', disable: 'campaigns disable',
    'setup-auth': 'setup auth'
  }[command] ?? command;
  throw new UsageError(`./cao.sh no longer supports ${command}; use gh cao ${replacement}. Run gh cao --help for operator commands or ./cao.sh --help for pipeline tools.`);
}
