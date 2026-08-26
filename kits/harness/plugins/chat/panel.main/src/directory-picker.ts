export type DirectoryRequest = (owner: string, name: string, ...args: unknown[]) => Promise<unknown>;

export async function validateKnownProject(request: DirectoryRequest, project: string): Promise<string> {
  const result = await request('agent', 'listDirectory', project);
  if (!result || typeof result !== 'object') throw new Error('项目目录验证返回无效结果');
  const path = (result as { path?: unknown }).path;
  if (typeof path !== 'string' || !path) throw new Error('项目目录验证返回无效结果');
  return path;
}
