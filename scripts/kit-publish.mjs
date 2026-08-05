#!/usr/bin/env node

import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildSpdx,
  canonicalJson,
  inspectKit,
  packKit,
  validateKit,
} from '@itharbors/kit-cli';

import {
  createKitPublicationMetadata,
  deriveArtifactName,
} from './lib/kit-publish/metadata.mjs';
import { aggregateKitRegistry } from './lib/kit-publish/registry.mjs';
import { readEmbeddedSpdx } from './lib/kit-publish/archive-metadata.mjs';
import { createKitProvenancePredicate } from './lib/kit-publish/provenance.mjs';
import { GitHubArtifactAttestationVerifier } from './lib/kit-registry/github-attestation.mjs';

const USAGE = [
  'Usage:',
  '  node scripts/kit-publish.mjs prepare \\',
  '    --kit-artifact <file> --output-directory <directory> \\',
  '    --kit-id <id> --kit-version <version> --kit-channel <channel> \\',
  '    --repository <owner/repo> --commit <sha> --workflow <workflow@ref> \\',
  '    --signer-workflow <workflow@ref> \\',
  '    --ref <refs/...> --tag <tag> --label <label> --summary <summary>',
  '  node scripts/kit-publish.mjs provenance \\',
  '    --release-manifest <release.json> --output <provenance.json>',
  '  node scripts/kit-publish.mjs prepare \\',
  '    --kit-directory <directory> --output-directory <directory> \\',
  '    --repository <owner/repo> --commit <sha> --workflow <workflow@ref> \\',
  '    --signer-workflow <workflow@ref> \\',
  '    --ref <refs/...> --tag <tag> --label <label> --summary <summary>',
  '  node scripts/kit-publish.mjs aggregate \\',
  '    --repository-root <directory> --repository <owner/repo> --policy-file <file> \\',
  '    --revocations-file <file> \\',
  '    --output <index.v1.json> --generated-at <ISO-8601 UTC>',
  '',
].join('\n');

const PREPARE_ARTIFACT_OPTIONS = [
  'kit-artifact',
  'output-directory',
  'kit-id',
  'kit-version',
  'kit-channel',
  'repository',
  'commit',
  'workflow',
  'signer-workflow',
  'ref',
  'tag',
  'label',
  'summary',
];

const PREPARE_DIRECTORY_OPTIONS = [
  'kit-directory',
  'output-directory',
  'repository',
  'commit',
  'workflow',
  'signer-workflow',
  'ref',
  'tag',
  'label',
  'summary',
];

const AGGREGATE_OPTIONS = [
  'repository-root',
  'repository',
  'policy-file',
  'revocations-file',
  'output',
  'generated-at',
];

const PROVENANCE_OPTIONS = ['release-manifest', 'output'];

function parseOptions(args, allowed) {
  if (args.length !== allowed.length * 2) return null;
  const values = Object.create(null);
  const allowedSet = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      typeof option !== 'string'
      || !option.startsWith('--')
      || !allowedSet.has(option.slice(2))
      || Object.hasOwn(values, option.slice(2))
      || typeof value !== 'string'
      || value.length === 0
    ) return null;
    values[option.slice(2)] = value;
  }
  return allowed.every((name) => Object.hasOwn(values, name)) ? values : null;
}

async function prepare(options) {
  if (options['kit-directory']) return prepareDirectory(options);
  return prepareArtifact(options);
}

async function provenance(options) {
  const release = JSON.parse(await readFile(path.resolve(options['release-manifest']), 'utf8'));
  const predicate = createKitProvenancePredicate(release);
  await writeFile(
    path.resolve(options.output),
    canonicalJson(predicate),
    { flag: 'wx', mode: 0o600 },
  );
  return { PREDICATE: path.basename(options.output) };
}

async function prepareArtifact(options) {
  const kitArtifact = path.resolve(options['kit-artifact']);
  const inspected = await inspectKit({ archive: kitArtifact });
  const artifactName = deriveArtifactName(inspected.manifest);
  if (path.basename(kitArtifact) !== artifactName) {
    throw new Error(`Kit artifact must use canonical artifact name ${artifactName}`);
  }
  for (const [field, actual, expected] of [
    ['id', inspected.manifest.id, options['kit-id']],
    ['version', inspected.manifest.version, options['kit-version']],
    ['channel', inspected.manifest.channel, options['kit-channel']],
  ]) {
    if (actual !== expected) {
      throw new Error(`Kit artifact ${field} does not match expected ${field}`);
    }
  }
  const spdx = await readEmbeddedSpdx(kitArtifact);
  const metadata = createKitPublicationMetadata({
    manifest: inspected.manifest,
    sha256: inspected.sha256,
    size: inspected.compressedSize,
    repository: options.repository,
    commit: options.commit,
    workflow: options.workflow,
    signerWorkflow: options['signer-workflow'],
    ref: options.ref,
    tag: options.tag,
    label: options.label,
    summary: options.summary,
  });
  if (metadata.artifactName !== artifactName) {
    throw new Error('Inspected artifact identity changed during metadata creation');
  }
  const outputDirectory = path.resolve(options['output-directory']);
  let ownsOutputDirectory = false;
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
    ownsOutputDirectory = true;
    const artifactPath = path.join(outputDirectory, artifactName);
    await copyFile(kitArtifact, artifactPath, fsConstants.COPYFILE_EXCL);
    await Promise.all([
      writeFile(
        path.join(outputDirectory, 'release.json'),
        canonicalJson(metadata.release),
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        path.join(outputDirectory, 'registry-entry.json'),
        canonicalJson(metadata.registryEntry),
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        path.join(outputDirectory, 'sbom.spdx.json'),
        canonicalJson(spdx),
        { flag: 'wx', mode: 0o600 },
      ),
    ]);
    return {
      CHANNEL: inspected.manifest.channel,
      VERSION: inspected.manifest.version,
      TAG: options.tag,
      ARTIFACT_NAME: artifactName,
      ARTIFACT_SHA256: inspected.sha256,
      RELEASE_MANIFEST: 'release.json',
      REGISTRY_ENTRY: 'registry-entry.json',
      SBOM: 'sbom.spdx.json',
    };
  } catch (error) {
    if (ownsOutputDirectory) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function prepareDirectory(options) {
  const project = await validateKit(options['kit-directory']);
  const artifactName = deriveArtifactName(project.manifest);
  const outputDirectory = path.resolve(options['output-directory']);
  let ownsOutputDirectory = false;
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
    ownsOutputDirectory = true;
    const artifactPath = path.join(outputDirectory, artifactName);
    await packKit({ directory: project.directory, output: artifactPath });
    const inspected = await inspectKit({ archive: artifactPath });
    const metadata = createKitPublicationMetadata({
      manifest: inspected.manifest,
      sha256: inspected.sha256,
      size: inspected.compressedSize,
      repository: options.repository,
      commit: options.commit,
      workflow: options.workflow,
      signerWorkflow: options['signer-workflow'],
      ref: options.ref,
      tag: options.tag,
      label: options.label,
      summary: options.summary,
    });
    if (metadata.artifactName !== artifactName) {
      throw new Error('Packed artifact identity changed during inspection');
    }
    await Promise.all([
      writeFile(
        path.join(outputDirectory, 'release.json'),
        canonicalJson(metadata.release),
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        path.join(outputDirectory, 'registry-entry.json'),
        canonicalJson(metadata.registryEntry),
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        path.join(outputDirectory, 'sbom.spdx.json'),
        canonicalJson(await buildSpdx(project)),
        { flag: 'wx', mode: 0o600 },
      ),
    ]);
    return {
      CHANNEL: inspected.manifest.channel,
      VERSION: inspected.manifest.version,
      TAG: options.tag,
      ARTIFACT_NAME: artifactName,
      ARTIFACT_SHA256: inspected.sha256,
      RELEASE_MANIFEST: 'release.json',
      REGISTRY_ENTRY: 'registry-entry.json',
      SBOM: 'sbom.spdx.json',
    };
  } catch (error) {
    if (ownsOutputDirectory) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function createDefaultProvenanceVerifier({ githubToken }) {
  return new GitHubArtifactAttestationVerifier({ githubToken });
}

async function aggregate(options, implementation, environment, createProvenanceVerifier) {
  const githubToken = environment.GITHUB_TOKEN;
  if (typeof githubToken !== 'string' || githubToken.length === 0) {
    throw new Error('GitHub token is required');
  }
  const provenanceVerifier = createProvenanceVerifier({ githubToken });
  const index = await implementation({
    repositoryRoot: options['repository-root'],
    repository: options.repository,
    policyFile: options['policy-file'],
    revocationsFile: options['revocations-file'],
    generatedAt: options['generated-at'],
    githubToken,
    provenanceVerifier,
  });
  await writeFile(path.resolve(options.output), canonicalJson(index), { flag: 'wx', mode: 0o600 });
  return {
    INDEX: 'index.v1.json',
    KITS: index.kits.length,
    REVOCATIONS: index.revocations.length,
  };
}

export async function runKitPublishCli(
  args,
  io = process,
  dependencies = {},
) {
  const [command, ...rest] = args;
  const allowed = command === 'prepare'
    ? [PREPARE_ARTIFACT_OPTIONS, PREPARE_DIRECTORY_OPTIONS]
    : command === 'provenance'
      ? [PROVENANCE_OPTIONS]
      : command === 'aggregate'
        ? [AGGREGATE_OPTIONS]
        : null;
  if (!allowed) {
    io.stderr.write(USAGE);
    return 2;
  }
  const options = allowed?.map((candidate) => parseOptions(rest, candidate)).find(Boolean);
  if (!options) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const aggregateImplementation = dependencies.aggregateKitRegistry ?? aggregateKitRegistry;
    const environment = dependencies.env ?? process.env;
    const createProvenanceVerifier = dependencies.createProvenanceVerifier
      ?? createDefaultProvenanceVerifier;
    const outputs = command === 'prepare'
      ? await prepare(options)
      : command === 'provenance'
        ? await provenance(options)
        : await aggregate(
          options,
          aggregateImplementation,
          environment,
          createProvenanceVerifier,
        );
    io.stdout.write(`${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`ERROR=${message.replace(/[\r\n]+/gu, ' ')}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runKitPublishCli(process.argv.slice(2));
}
