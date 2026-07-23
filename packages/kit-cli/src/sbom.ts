import { createHash } from 'node:crypto';

import { encodeKitId } from '@itharbors/kit-core';

import { canonicalJson, sha256File } from './checksums.js';
import type { ValidatedKitProject } from './kit-project.js';

export interface SpdxPackage {
  name: string;
  SPDXID: string;
  downloadLocation: 'NOASSERTION';
  filesAnalyzed: false;
  licenseConcluded: 'NOASSERTION';
  licenseDeclared: 'NOASSERTION';
  copyrightText: 'NOASSERTION';
}

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: '1980-01-01T00:00:00Z';
    creators: ['Tool: harbors-kit'];
  };
  packages: SpdxPackage[];
}

export async function buildSpdx(project: ValidatedKitProject): Promise<SpdxDocument> {
  const payloadEntries = await Promise.all(project.payload.map(async (file) => ({
    path: file.archivePath,
    sha256: await sha256File(file.absolutePath),
    size: file.size,
  })));
  const payloadDigest = createHash('sha256')
    .update(canonicalJson(payloadEntries))
    .digest('hex');
  const packages = [...project.packageNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name, index): SpdxPackage => ({
      name,
      SPDXID: `SPDXRef-Package-${index + 1}`,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    }));

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${project.manifest.id}@${project.manifest.version}`,
    documentNamespace: `https://itharbors.dev/spdx/${encodeKitId(project.manifest.id)}/${project.manifest.version}/${payloadDigest}`,
    creationInfo: {
      created: '1980-01-01T00:00:00Z',
      creators: ['Tool: harbors-kit'],
    },
    packages,
  };
}
