import { listNodeTypes } from '../registry/index.js';

export function cmdNodeTypes(): void {
  for (const type of listNodeTypes()) {
    console.log(`${type.id}  (${type.displayName})`);
    console.log(`  ${type.description}`);
    console.log(`  capabilities: ${type.capabilities.length > 0 ? type.capabilities.join(', ') : '(none)'}`);
    console.log(
      `  agent session: ${type.agentDriven ? 'yes' : 'no'}` +
        (type.agentDriven ? ` · interactive: ${type.interactive ? 'yes' : 'no'}` : ''),
    );
    console.log(`  config: ${type.configSummary}`);
    console.log(`  output: ${type.outputSummary}`);
    if (type.failsWhen) {
      console.log('  fails on: its own output verdict (a `fail` verdict errors the node)');
    }
    if (type.contextTransparent) {
      console.log("  context: transparent — forwards its dependencies' outputs downstream");
    }
    console.log('');
  }
}
