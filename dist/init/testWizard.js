import { readFileSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument } from 'yaml';
import { confirm, promptText } from './prompts.js';
import { detectTestCommands } from './testDetect.js';
/** Writes `commands` into the `test` node's config, preserving the rest of the file (comments included). */
export function writeTestCommands(workflowPath, commands) {
    const doc = parseDocument(readFileSync(workflowPath, 'utf8'));
    const nodes = doc.get('nodes');
    if (!isSeq(nodes))
        return;
    for (const item of nodes.items) {
        if (isMap(item) && item.get('id') === 'test') {
            item.setIn(['config', 'commands'], commands);
        }
    }
    writeFileSync(workflowPath, String(doc));
}
/**
 * Walks the user through the Test node's command(s) right after scaffolding
 * `.flow-code/workflow.yaml`: shows anything auto-detected (package.json
 * scripts, a Makefile target, pytest/go/cargo) for them to accept or skip,
 * then offers to add more by hand — useful for a second test level
 * (integration/e2e) detection won't have found, or a project with no test
 * command yet, which just leaves the scaffolded placeholder untouched.
 */
export async function runTestSetupWizard(repoRoot, workflowPath) {
    console.log('\nflow-code: set up the command(s) the Test node runs.\n');
    const detected = detectTestCommands(repoRoot);
    const chosen = [];
    if (detected.length > 0) {
        console.log(`  Detected ${detected.length} possible test command${detected.length > 1 ? 's' : ''}:`);
        for (const command of detected) {
            if (await confirm(`  Include \`${command}\`?`, { defaultAnswer: true }))
                chosen.push(command);
        }
    }
    else {
        console.log('  No test command detected — fine for a new project with nothing to test yet.');
    }
    for (;;) {
        const prompt = chosen.length === 0 ? '  Add a test command?' : '  Add another test command?';
        if (!(await confirm(prompt)))
            break;
        const command = await promptText('  Command: ');
        if (command)
            chosen.push(command);
    }
    if (chosen.length === 0) {
        console.log('  Skipped — leaving the placeholder in .flow-code/workflow.yaml; edit `nodes: test: config: commands` whenever you have one.');
        return;
    }
    writeTestCommands(workflowPath, chosen);
    console.log(`  Saved ${chosen.length} test command${chosen.length > 1 ? 's' : ''} to .flow-code/workflow.yaml.`);
}
//# sourceMappingURL=testWizard.js.map