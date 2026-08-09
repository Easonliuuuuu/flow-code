import { defaultSkillRoots, discoverSkills } from '../skills/discover.js';
import { formatSkillsListing } from '../skills/report.js';
import { repoRootFromCwd } from './context.js';

export async function cmdSkills(): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const skills = discoverSkills(defaultSkillRoots(repoRoot));
  for (const line of formatSkillsListing(skills, repoRoot)) console.log(line);
}
