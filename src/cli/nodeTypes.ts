import { nodeTypeReferenceLines } from '../registry/index.js';

export function cmdNodeTypes(): void {
  for (const line of nodeTypeReferenceLines()) console.log(line);
}
