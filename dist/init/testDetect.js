import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Script names npm/yarn/pnpm conventionally use for a project's test suite(s). */
const TEST_SCRIPT_PATTERN = /^test(:.+)?$/;
/** Excluded even if they match — these don't run to completion unattended. */
const SKIP_SCRIPT_PATTERN = /watch/i;
const NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1';
function detectFromPackageJson(repoRoot) {
    const path = join(repoRoot, 'package.json');
    if (!existsSync(path))
        return [];
    try {
        const pkg = JSON.parse(readFileSync(path, 'utf8'));
        const scripts = pkg.scripts ?? {};
        const runner = existsSync(join(repoRoot, 'pnpm-lock.yaml'))
            ? 'pnpm'
            : existsSync(join(repoRoot, 'yarn.lock'))
                ? 'yarn'
                : 'npm run';
        return Object.keys(scripts)
            .filter((name) => TEST_SCRIPT_PATTERN.test(name) && !SKIP_SCRIPT_PATTERN.test(name))
            .filter((name) => scripts[name].trim() !== NPM_PLACEHOLDER_TEST)
            .sort()
            .map((name) => (name === 'test' ? (runner === 'npm run' ? 'npm test' : `${runner} test`) : `${runner} ${name}`));
    }
    catch {
        return [];
    }
}
function detectFromMakefile(repoRoot) {
    const path = join(repoRoot, 'Makefile');
    if (!existsSync(path))
        return [];
    try {
        const targets = new Set();
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const match = /^(test(?:[-_].+)?):/.exec(line);
            if (match)
                targets.add(match[1]);
        }
        return [...targets].sort().map((t) => `make ${t}`);
    }
    catch {
        return [];
    }
}
function detectPytest(repoRoot) {
    const markers = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'];
    const hasMarkerFile = markers.some((f) => existsSync(join(repoRoot, f)));
    const testsDir = join(repoRoot, 'tests');
    const hasTestsDir = existsSync(testsDir) &&
        (() => {
            try {
                return readdirSync(testsDir).some((f) => f.endsWith('.py'));
            }
            catch {
                return false;
            }
        })();
    return hasMarkerFile || hasTestsDir ? ['pytest'] : [];
}
function detectGoTest(repoRoot) {
    return existsSync(join(repoRoot, 'go.mod')) ? ['go test ./...'] : [];
}
function detectCargoTest(repoRoot) {
    return existsSync(join(repoRoot, 'Cargo.toml')) ? ['cargo test'] : [];
}
/**
 * Best-effort scan for how this project runs its tests, so `flow-code init`
 * can suggest commands instead of leaving a placeholder. Cheap, file-presence
 * based; never runs anything. A project with none of these markers (a brand
 * new repo, or a stack we don't recognize) just gets an empty list back —
 * the caller treats that as "nothing to suggest," not an error.
 */
export function detectTestCommands(repoRoot) {
    return [
        ...detectFromPackageJson(repoRoot),
        ...detectFromMakefile(repoRoot),
        ...detectPytest(repoRoot),
        ...detectGoTest(repoRoot),
        ...detectCargoTest(repoRoot),
    ];
}
//# sourceMappingURL=testDetect.js.map