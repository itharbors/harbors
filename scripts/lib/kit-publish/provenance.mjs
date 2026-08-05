import { parseReleaseManifest } from '@itharbors/kit-core';

const PUBLISH_SIGNER_WORKFLOW = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';
const PRODUCT_WORKFLOW_PATTERN = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\/(\.github\/workflows\/publish-kit\.yml)@(refs\/tags\/kit\/[a-z0-9]+(?:-[a-z0-9]+)*\/v[0-9A-Za-z.-]+)$/u;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createKitProvenancePredicate(rawRelease) {
  const release = parseReleaseManifest(rawRelease);
  if (release.source.signerWorkflow !== PUBLISH_SIGNER_WORKFLOW) {
    throw new Error(`Kit provenance signerWorkflow must equal ${PUBLISH_SIGNER_WORKFLOW}`);
  }
  const match = PRODUCT_WORKFLOW_PATTERN.exec(release.source.workflow);
  if (!match || match[1] !== release.source.repository) {
    throw new Error('Kit provenance requires the canonical product Tag workflow');
  }
  const [, repository, workflowPath, ref] = match;
  return deepFreeze({
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          repository: `https://github.com/${repository}`,
          path: workflowPath,
          ref,
        },
      },
      internalParameters: {},
      resolvedDependencies: [{
        uri: `git+https://github.com/${repository}@${ref}`,
        digest: { gitCommit: release.source.commit },
      }],
    },
    runDetails: {
      builder: { id: `https://github.com/${release.source.signerWorkflow}` },
      metadata: {},
    },
  });
}
