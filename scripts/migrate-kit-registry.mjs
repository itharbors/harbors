#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) {
    throw new Error('usage: migrate-kit-registry.mjs --output <directory>');
  }
  return path.resolve(argv[1]);
}

async function currentCommit() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Could not resolve the Framework source Commit');
  return commit;
}

async function createSnapshot(output) {
  if (await lstat(output).catch(() => null)) {
    throw new Error(`output directory already exists: ${output}`);
  }
  await mkdir(path.join(output, '.github', 'workflows'), { recursive: true });
  try {
    await cp(
      path.join(repository, '.github', 'kit-templates', 'registry-pages.yml'),
      path.join(output, '.github', 'workflows', 'registry-pages.yml'),
    );
    await cp(path.join(repository, 'registry'), path.join(output, 'registry'), { recursive: true });
    await writeFile(
      path.join(output, '.harbors-registry.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sourceFrameworkCommit: await currentCommit(),
      }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(output, '.gitignore'), 'index.v1.json\n.harbors-toolchain/\n', 'utf8');
    await writeFile(
      path.join(output, 'README.md'),
      '# Harbors Kit Registry\n\n此分支只保存经过审核的 Kit 元数据和吊销记录。`registry/entries/` 下每个条目必须能与对应 GitHub Release 对账；推送到 `kit-registry` 后，工作流才会生成 `index.v1.json` 并部署到 GitHub Pages。\n\n发布工具链来自受保护的 `kit-publish-v1` 引用，本分支不保存或执行 Kit 制品。\n',
      'utf8',
    );
    await writeFile(
      path.join(output, 'AGENTS.md'),
      '# Harbors Kit Registry branch instructions\n\nThis repository history is the `kit-registry` product index. Stable entry changes must arrive through a reviewed pull request; preview automation may only update preview metadata. Never add Kit executables or source archives.\n\nCommit titles must use exactly one of `[Init]`, `[Feature]`, `[Bug]`, `[Docs]`, `[Refactor]`, `[Optimize]`, `[Test]`, or `[Chore]`, followed by a concise Chinese summary without a trailing period. `[Init]` is initialization-only.\n',
      'utf8',
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return output;
}

try {
  const output = await createSnapshot(parseArgs(process.argv.slice(2)));
  process.stdout.write(`REGISTRY_DIRECTORY=${output}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
