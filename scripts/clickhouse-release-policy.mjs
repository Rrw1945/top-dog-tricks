import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifestPath = resolve(
  repositoryRoot,
  'artifacts/top-dog-tricks/clickhouse-releases.json',
);
const documentationPath = resolve(
  repositoryRoot,
  'artifacts/top-dog-tricks/docs/newsletter-confirmation-funnel.md',
);
const workflowPath = resolve(
  repositoryRoot,
  '.github/workflows/newsletter-funnel-clickhouse.yml',
);
const checkOnly = process.argv.includes('--check');
const allowedArguments = new Set(['--check']);

for (const argument of process.argv.slice(2)) {
  if (!allowedArguments.has(argument)) {
    throw new Error(`Unknown argument: ${argument}\nUsage: node scripts/clickhouse-release-policy.mjs [--check]`);
  }
}

const DOCUMENTATION_BEGIN = '<!-- BEGIN GENERATED CLICKHOUSE RELEASE POLICY -->';
const DOCUMENTATION_END = '<!-- END GENERATED CLICKHOUSE RELEASE POLICY -->';
const WORKFLOW_BEGIN = '        # BEGIN GENERATED CLICKHOUSE RELEASE MATRIX';
const WORKFLOW_END = '        # END GENERATED CLICKHOUSE RELEASE MATRIX';
const IMAGE_PATTERN =
  /^clickhouse\/clickhouse-server:(?<version>\d+\.\d+)@sha256:(?<digest>[a-f0-9]{64})$/;

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !manifest
    || typeof manifest !== 'object'
    || typeof manifest.defaultVersion !== 'string'
    || !Array.isArray(manifest.releases)
    || manifest.releases.length === 0
  ) {
    throw new Error(
      'The release manifest must contain a defaultVersion and a non-empty releases array.',
    );
  }

  const seenVersions = new Set();
  const seenDigests = new Set();
  for (const release of manifest.releases) {
    if (
      !release
      || typeof release.version !== 'string'
      || typeof release.image !== 'string'
      || seenVersions.has(release.version)
    ) {
      throw new Error('Each release must have a unique version and an immutable image.');
    }

    const match = release.image.match(IMAGE_PATTERN);
    if (!match || match.groups?.version !== release.version) {
      throw new Error(
        `ClickHouse ${release.version} must use an immutable image whose tag matches its version and whose digest is 64 lowercase hex characters.`,
      );
    }
    if (seenDigests.has(match.groups.digest)) {
      throw new Error(`The ClickHouse image digest for ${release.version} is duplicated.`);
    }

    seenVersions.add(release.version);
    seenDigests.add(match.groups.digest);
  }

  if (!seenVersions.has(manifest.defaultVersion)) {
    throw new Error(
      `defaultVersion ${manifest.defaultVersion} is not in the supported releases.`,
    );
  }

  return manifest;
}

function documentationBlock(manifest) {
  const versions = manifest.releases.map(({ version }) => version);
  return [
    DOCUMENTATION_BEGIN,
    `The supported ClickHouse release set for this fixture is **${versions.join(' and ')}**.`,
    'Every supported release must use an immutable `sha256` image reference.',
    'The release label, image tag, and digest are maintained once in',
    '`artifacts/top-dog-tricks/clickhouse-releases.json` and rendered here and',
    'into the CI matrix.',
    '',
    '| ClickHouse release | Immutable image reference |',
    '| --- | --- |',
    ...manifest.releases.map(
      ({ version, image }) => `| \`${version}\` | \`${image}\` |`,
    ),
    DOCUMENTATION_END,
  ].join('\n');
}

function workflowBlock(manifest) {
  return [
    WORKFLOW_BEGIN,
    '        include:',
    ...manifest.releases.flatMap(({ version, image }) => [
      `          - version: "${version}"`,
      `            image: "${image}"`,
    ]),
    WORKFLOW_END,
  ].join('\n');
}

function replaceGeneratedSection(source, beginMarker, endMarker, generatedBlock, filePath) {
  const beginIndex = source.indexOf(beginMarker);
  const endIndex = source.indexOf(endMarker);
  if (
    beginIndex === -1
    || endIndex === -1
    || beginIndex >= endIndex
    || source.indexOf(beginMarker, beginIndex + beginMarker.length) !== -1
    || source.indexOf(endMarker, endIndex + endMarker.length) !== -1
  ) {
    throw new Error(
      `Generated-section markers are missing, duplicated, or out of order in ${filePath}. Restore the BEGIN/END markers, then run pnpm run generate:clickhouse-release-policy.`,
    );
  }

  const endAfterMarker = endIndex + endMarker.length;
  return (
    source.slice(0, beginIndex)
    + generatedBlock
    + source.slice(endAfterMarker)
  );
}

function lineDiff(actual, expected, label) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const lcs = Array.from(
    { length: actualLines.length + 1 },
    () => new Uint32Array(expectedLines.length + 1),
  );

  for (let i = actualLines.length - 1; i >= 0; i -= 1) {
    for (let j = expectedLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = actualLines[i] === expectedLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const changes = [`--- checked in: ${label}`, `+++ expected from manifest: ${label}`, '@@ generated section @@'];
  let i = 0;
  let j = 0;
  while (i < actualLines.length || j < expectedLines.length) {
    if (
      i < actualLines.length
      && j < expectedLines.length
      && actualLines[i] === expectedLines[j]
    ) {
      changes.push(` ${actualLines[i]}`);
      i += 1;
      j += 1;
    } else if (
      i < actualLines.length
      && (j === expectedLines.length || lcs[i + 1][j] >= lcs[i][j + 1])
    ) {
      changes.push(`-${actualLines[i]}`);
      i += 1;
    } else {
      changes.push(`+${expectedLines[j]}`);
      j += 1;
    }
  }

  return changes.join('\n');
}

const manifest = readManifest();
const targets = [
  {
    path: documentationPath,
    label: 'artifacts/top-dog-tricks/docs/newsletter-confirmation-funnel.md',
    begin: DOCUMENTATION_BEGIN,
    end: DOCUMENTATION_END,
    generatedBlock: documentationBlock(manifest),
  },
  {
    path: workflowPath,
    label: '.github/workflows/newsletter-funnel-clickhouse.yml',
    begin: WORKFLOW_BEGIN,
    end: WORKFLOW_END,
    generatedBlock: workflowBlock(manifest),
  },
];

let stale = false;
for (const target of targets) {
  const current = readFileSync(target.path, 'utf8');
  const expected = replaceGeneratedSection(
    current,
    target.begin,
    target.end,
    target.generatedBlock,
    target.label,
  );

  if (current === expected) {
    continue;
  }

  stale = true;
  if (checkOnly) {
    const start = current.indexOf(target.begin);
    const end = current.indexOf(target.end) + target.end.length;
    const actualBlock = current.slice(start, end);
    console.error(lineDiff(actualBlock, target.generatedBlock, target.label));
  } else {
    writeFileSync(target.path, expected);
    console.log(`Updated ${target.label}`);
  }
}

if (checkOnly && stale) {
  console.error(
    '\nClickHouse release policy output is stale. Run pnpm run generate:clickhouse-release-policy and review the generated diff.',
  );
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('ClickHouse release policy outputs match the manifest.');
}
