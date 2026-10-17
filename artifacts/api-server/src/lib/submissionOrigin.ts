import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';

// Confirmed by the owner, not inferred from PUBLIC_APP_URL or request headers.
// An unrecognized preview must never silently become the main preview.
export const MAIN_PREVIEW_HOST =
  '39e6427c-2934-4c24-aaf8-22edf2995a79-00-216itt8ks1i3r-h48djzh5.reed.replit.dev';

const processIdentity = randomUUID();
const originSchema = z.object({
  version: z.literal(1),
  environment: z.enum(['production', 'main-preview', 'other-preview', 'unknown']),
  sourceId: z.string().regex(/^(?:host|project)-[a-f0-9]{64}$|^process-[a-f0-9-]{36}$/),
  receiptId: z.uuid(),
  receivedAt: z.iso.datetime(),
}).strict();

function fingerprint(kind: 'host' | 'project', value: string): string {
  return `${kind}-${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Read only documented, non-secret runtime identifiers. Never inspect or hash
 * DATABASE_URL, credentials, request headers, or PUBLIC_APP_URL.
 * Other previews include isolated tasks; there is no verified runtime task
 * marker, so we deliberately do not assert that every other preview is a task.
 */
export function captureSubmissionOrigin(
  runtime: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const host = runtime.REPLIT_DEV_DOMAIN?.toLowerCase();
  const validHost = host && host.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.replit\.dev$/.test(host);
  const project = runtime.REPL_ID;
  const validProject = project && z.uuid().safeParse(project).success;
  const production = runtime.REPLIT_DEPLOYMENT === '1';
  return JSON.stringify(originSchema.parse({
    version: 1,
    environment: production ? 'production'
      : validHost ? (host === MAIN_PREVIEW_HOST ? 'main-preview' : 'other-preview')
      : 'unknown',
    sourceId: production
      ? (validProject ? fingerprint('project', project) : `process-${processIdentity}`)
      : validHost ? fingerprint('host', host) : `process-${processIdentity}`,
    receiptId: randomUUID(),
    receivedAt: new Date().toISOString(),
  }));
}

/** Reuse the receipt saved at insertion, including after a database is copied. */
export function websiteOriginField(
  storedOrigin: string | null | undefined,
  submissionId: number,
): Record<string, string> {
  // Historical records have no receipt. Do not backfill from today's runtime.
  if (storedOrigin == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedOrigin);
  } catch {
    throw new Error('Invalid stored website origin');
  }
  const result = originSchema.safeParse(parsed);
  if (!result.success || !Number.isSafeInteger(submissionId) || submissionId < 1) {
    // Never include the invalid payload or validation details in an error.
    throw new Error('Invalid stored website origin');
  }
  return {
    'Website Origin': JSON.stringify({ ...result.data, websiteSubmissionId: submissionId }),
  };
}
