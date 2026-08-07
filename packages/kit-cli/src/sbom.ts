import { createHash } from 'node:crypto';

import { encodeKitId } from '@itharbors/kit-core';

import { canonicalJson, sha256File } from './checksums.js';
import type { SoftwareComponent, ValidatedKitProject } from './kit-project.js';

export interface SpdxPackage {
  name: string;
  SPDXID: string;
  versionInfo: string;
  downloadLocation: 'NOASSERTION';
  filesAnalyzed: true;
  licenseConcluded: 'NOASSERTION';
  licenseDeclared: string;
  copyrightText: 'NOASSERTION';
  externalRefs: Array<{
    referenceCategory: 'PACKAGE-MANAGER';
    referenceType: 'purl';
    referenceLocator: string;
  }>;
}

export interface SpdxFile {
  fileName: string;
  SPDXID: string;
  checksums: Array<{ algorithm: 'SHA256'; checksumValue: string }>;
  licenseConcluded: 'NOASSERTION';
  copyrightText: 'NOASSERTION';
}

export interface SpdxRelationship {
  spdxElementId: string;
  relationshipType: 'CONTAINS' | 'DEPENDS_ON' | 'DESCRIBES';
  relatedSpdxElement: string;
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
  files: SpdxFile[];
  relationships: SpdxRelationship[];
}

function stableId(prefix: string, value: string): string {
  return `SPDXRef-${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function packageUrl(component: SoftwareComponent): string {
  const encodedName = component.name.startsWith('@')
    ? `${encodeURIComponent(component.name.split('/')[0]!)}/${encodeURIComponent(component.name.split('/')[1]!)}`
    : encodeURIComponent(component.name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(component.version)}`;
}

function ownsFile(component: SoftwareComponent, archivePath: string): boolean {
  if (component.archiveDirectory === '') {
    return !archivePath.startsWith('plugins/') && !archivePath.startsWith('node_modules/');
  }
  return archivePath.startsWith(`${component.archiveDirectory}/`);
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
  const componentIds = new Map(project.components.map((component) => [
    component.name,
    stableId('Package', `${component.name}@${component.version}`),
  ]));
  const packages = project.components.map((component): SpdxPackage => ({
    name: component.name,
    SPDXID: componentIds.get(component.name)!,
    versionInfo: component.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: true,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: component.license ?? 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    externalRefs: [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: packageUrl(component),
    }],
  }));
  const files = payloadEntries.map((entry): SpdxFile => ({
    fileName: `./${entry.path}`,
    SPDXID: stableId('File', entry.path),
    checksums: [{ algorithm: 'SHA256', checksumValue: entry.sha256 }],
    licenseConcluded: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  }));
  const relationships: SpdxRelationship[] = [];
  for (const component of project.components) {
    const componentId = componentIds.get(component.name)!;
    relationships.push({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: componentId,
    });
    for (const dependency of component.dependencies) {
      const dependencyId = componentIds.get(dependency);
      if (dependencyId) relationships.push({
        spdxElementId: componentId,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: dependencyId,
      });
    }
    for (const entry of payloadEntries.filter(({ path }) => ownsFile(component, path))) {
      relationships.push({
        spdxElementId: componentId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: stableId('File', entry.path),
      });
    }
  }

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
    files,
    relationships,
  };
}
