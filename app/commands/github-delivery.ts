import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GithubDelivery } from '../../domains/github-delivery/index.js';
export async function githubDeliveryCommand(
  action: string,
  options: { path?: string; id?: string; input?: string; resolution?: string },
): Promise<void> {
  const service = new GithubDelivery(path.resolve(options.path ?? '.'));
  const input: unknown = options.input ? JSON.parse(await readFile(options.input, 'utf8')) : {};
  if (
    options.resolution !== undefined &&
    options.resolution !== 'full' &&
    options.resolution !== 'partial'
  )
    throw new Error('resolution must be full or partial');
  const resolution = options.resolution === 'partial' ? 'partial' : 'full';
  let result: unknown;
  if (action === 'bind') result = service.bind(input);
  else if (action === 'list') result = service.store.records();
  else {
    if (!options.id) throw new Error('--id is required');
    if (action === 'status') result = service.store.read(options.id);
    else if (['scope', 'grant', 'verify', 'review', 'carry'].includes(action))
      result = service.local(options.id, action, input);
    else if (action === 'inspect-issue') result = service.inspectIssue(options.id, input);
    else if (action === 'issue') result = service.issue(options.id, input);
    else if (action === 'sync-issue') result = service.syncIssue(options.id, input);
    else if (action === 'preflight') result = service.check(options.id, resolution);
    else if (action === 'push') result = service.push(options.id, resolution);
    else if (action === 'pr') result = service.pr(options.id, resolution);
    else if (action === 'observe') result = service.observe(options.id);
    else throw new Error(`Unknown delivery action: ${action}`);
  }
  console.log(JSON.stringify({ status: 'success', action, result }, null, 2));
}
