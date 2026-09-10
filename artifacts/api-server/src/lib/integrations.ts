import { ReplitConnectors } from '@replit/connectors-sdk';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import type { Submission } from '@workspace/db';
import { ObjectStorageService } from './objectStorage';

const AIRTABLE_BASE_ID =
  process.env.AIRTABLE_BASE_ID ?? 'appH2CgL2xfxuBiBS';
const AIRTABLE_CONTESTANTS_TABLE =
  process.env.AIRTABLE_CONTESTANTS_TABLE ?? 'tblB0jKZdC3imM7yp';
const AIRTABLE_SUBMISSIONS_TABLE =
  process.env.AIRTABLE_SUBMISSIONS_TABLE ?? 'tbl9D3hNwDnLxK4MS';
const LEGAL_RELEASES_FOLDER_ID =
  process.env.GOOGLE_DRIVE_LEGAL_RELEASES_FOLDER_ID ??
  '1voHisfdIoFYC8s-ouRpCd3UxRqc8K6Bw';
const SLACK_REVIEW_CHANNEL_ID =
  process.env.SLACK_REVIEW_CHANNEL_ID ?? 'C0BUBL0EEE9';

const objectStorage = new ObjectStorageService();

type AirtableRecord = { id: string };
type AirtableCreateResponse = { records: AirtableRecord[] };
type DriveFile = { id: string; name: string; webViewLink?: string };

async function connectorJson<T>(
  connector: string,
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  const response = await new ReplitConnectors().proxy(connector, path, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${connector} request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function driveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

async function createReleasePdf(submission: Submission): Promise<Buffer> {
  const signatureFile = await objectStorage.getObjectEntityFile(
    submission.signatureObjectPath,
  );
  const [signatureBytes] = await signatureFile.download();
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const heading = await document.embedFont(StandardFonts.HelveticaBold);
  const body = await document.embedFont(StandardFonts.Helvetica);

  page.drawText('TOP DOG TRICKS', {
    x: 56,
    y: 724,
    size: 24,
    font: heading,
    color: rgb(0.86, 0.24, 0.08),
  });
  page.drawText('MEDIA RELEASE & OWNER CERTIFICATION', {
    x: 56,
    y: 696,
    size: 11,
    font: heading,
    color: rgb(0.14, 0.22, 0.27),
  });

  const lines = [
    `Owner: ${submission.ownerName}`,
    `Email: ${submission.email}`,
    `Phone: ${submission.phone}`,
    `Dog: ${submission.dogName}`,
    `Trick: ${submission.trickName}`,
    '',
    'I certify that I own this video and grant Top Dog Tricks full permission',
    'to edit, optimize, and publish this media.',
  ];

  let y = 642;
  for (const line of lines) {
    page.drawText(line, {
      x: 56,
      y,
      size: line.startsWith('I certify') ? 11 : 12,
      font: body,
      color: rgb(0.14, 0.22, 0.27),
    });
    y -= 22;
  }

  const signatureImage = await document.embedPng(signatureBytes);
  const scale = Math.min(430 / signatureImage.width, 150 / signatureImage.height);
  page.drawText('Owner signature', {
    x: 56,
    y: 390,
    size: 10,
    font: heading,
    color: rgb(0.45, 0.5, 0.52),
  });
  page.drawImage(signatureImage, {
    x: 56,
    y: 235,
    width: signatureImage.width * scale,
    height: signatureImage.height * scale,
  });
  page.drawLine({
    start: { x: 56, y: 225 },
    end: { x: 500, y: 225 },
    thickness: 1,
    color: rgb(0.8, 0.82, 0.82),
  });
  page.drawText(`Submitted ${submission.submittedAt.toISOString()}`, {
    x: 56,
    y: 190,
    size: 9,
    font: body,
    color: rgb(0.45, 0.5, 0.52),
  });

  return Buffer.from(await document.save());
}

async function uploadReleaseToDrive(
  submission: Submission,
  pdfBytes: Buffer,
): Promise<DriveFile> {
  const boundary = `top-dog-${submission.id}-${Date.now()}`;
  const metadata = JSON.stringify({
    name: `${submission.dogName}-${submission.id}-legal-release.pdf`,
    parents: [LEGAL_RELEASES_FOLDER_ID],
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    pdfBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return connectorJson<DriveFile>(
    'google-drive',
    '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
}

async function createAirtableRecords(
  submission: Submission,
  release: DriveFile | null,
  publicBaseUrl: string,
): Promise<{ contestantId: string; submissionId: string }> {
  const mediaUrl = `${publicBaseUrl}/api/storage/objects/${submission.videoObjectPath.replace('/objects/', '')}`;
  const releaseUrl = release?.webViewLink ?? (release ? driveDownloadUrl(release.id) : undefined);
  const releaseAttachment = releaseUrl
    ? [{ url: releaseUrl, filename: `${submission.dogName}-${submission.id}-legal-release.pdf` }]
    : undefined;

  const contestant = await connectorJson<AirtableCreateResponse>(
    'airtable',
    `/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CONTESTANTS_TABLE}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          {
            fields: {
              Owner: submission.ownerName,
              Email: submission.email,
              Phone: submission.phone,
              'Dog Name': submission.dogName,
              'Legal Release Status': 'Signed',
              ...(releaseAttachment ? { 'Signed Release PDF': releaseAttachment } : {}),
            },
          },
        ],
        typecast: true,
      }),
    },
  );

  const video = await connectorJson<AirtableCreateResponse>(
    'airtable',
    `/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SUBMISSIONS_TABLE}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          {
            fields: {
              Contestant: `${submission.dogName} — ${submission.ownerName}`,
              'Trick Name': submission.trickName,
              'Trick Description': submission.trickDescription,
              'Pipeline Status': '01 Ingested  06 Rejected',
              'Human Approval': 'Pendimg',
              'Raw Video File': [
                { url: mediaUrl, filename: submission.videoFileName },
              ],
              'Raw Video Drive': mediaUrl,
              'Action start Timestamp': '0',
              'Action End Timestamp': '',
            },
          },
        ],
        typecast: true,
      }),
    },
  );

  const contestantId = contestant.records[0]?.id;
  const submissionId = video.records[0]?.id;
  if (!contestantId || !submissionId) {
    throw new Error('Airtable did not return record IDs for the submission');
  }
  return { contestantId, submissionId };
}

export async function syncSubmissionToExternalSystems(
  submission: Submission,
  publicBaseUrl: string,
): Promise<{
  driveReleaseFileId: string | null;
  driveReleaseUrl: string | null;
  airtableContestantId: string | null;
  airtableSubmissionId: string | null;
  errors: string[];
}> {
  let release: DriveFile | null = null;
  const errors: string[] = [];

  try {
    const pdfBytes = await createReleasePdf(submission);
    release = await uploadReleaseToDrive(submission, pdfBytes);
  } catch (error) {
    errors.push(`Google Drive: ${error instanceof Error ? error.message : 'upload failed'}`);
  }

  try {
    const records = await createAirtableRecords(submission, release, publicBaseUrl);
    return {
      driveReleaseFileId: release?.id ?? null,
      driveReleaseUrl: release?.webViewLink ?? null,
      airtableContestantId: records.contestantId,
      airtableSubmissionId: records.submissionId,
      errors,
    };
  } catch (error) {
    errors.push(`Airtable: ${error instanceof Error ? error.message : 'sync failed'}`);
    return {
      driveReleaseFileId: release?.id ?? null,
      driveReleaseUrl: release?.webViewLink ?? null,
      airtableContestantId: null,
      airtableSubmissionId: null,
      errors,
    };
  }
}

export async function updateAirtableSubmission(
  submission: Submission,
): Promise<void> {
  if (!submission.airtableSubmissionId) return;
  const pipeline =
    submission.status === 'approved'
      ? '04 Approved'
      : submission.status === 'rejected'
        ? '06 Rejected'
        : '03 Awaiting Human Approval,';
  const approval =
    submission.status === 'approved'
      ? 'Approval'
      : submission.status === 'needs_edit'
        ? 'Needs Edit'
        : 'Pendimg';

  await connectorJson(
    'airtable',
    `/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SUBMISSIONS_TABLE}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          {
            id: submission.airtableSubmissionId,
            fields: {
              'Pipeline Status': pipeline,
              'Human Approval': approval,
              ...(submission.punchline
                ? { 'Generated Punchline': submission.punchline }
                : {}),
            },
          },
        ],
        typecast: true,
      }),
    },
  );
}

export async function updateAirtableProcessedMedia(
  submission: Submission,
  publicBaseUrl: string,
): Promise<void> {
  if (!submission.airtableSubmissionId || !submission.processedVideoObjectPath) {
    return;
  }
  const mediaUrl = `${publicBaseUrl}/api/storage/objects/${submission.processedVideoObjectPath.replace('/objects/', '')}`;
  await connectorJson(
    'airtable',
    `/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SUBMISSIONS_TABLE}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          {
            id: submission.airtableSubmissionId,
            fields: {
              'Processed Video Asset': [
                {
                  url: mediaUrl,
                  filename: `${submission.dogName}-${submission.id}-processed.mp4`,
                },
              ],
              'Generated Punchline':
                submission.punchline ??
                `${submission.dogName} is ready for the spotlight: ${submission.trickName}.`,
            },
          },
        ],
        typecast: true,
      }),
    },
  );
}

export async function sendSlackPreview(
  submission: Submission,
  publicBaseUrl: string,
): Promise<void> {
  const objectPath =
    submission.processedVideoObjectPath ?? submission.videoObjectPath;
  const file = await objectStorage.getObjectEntityFile(objectPath);
  const [videoBytes] = await file.download();
  const filename = `${submission.dogName}-${submission.id}-preview.mp4`;
  const upload = await connectorJson<{
    ok: boolean;
    upload_url?: string;
    file_id?: string;
    error?: string;
  }>('slack', '/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, length: videoBytes.length }),
  });
  if (!upload.ok || !upload.upload_url || !upload.file_id) {
    throw new Error(
      `Slack upload URL failed: ${upload.error ?? 'missing upload details'}`,
    );
  }

  const uploaded = await fetch(upload.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: videoBytes,
  });
  if (!uploaded.ok) {
    throw new Error(`Slack media upload failed (${uploaded.status})`);
  }

  const completed = await connectorJson<{ ok: boolean; error?: string }>(
    'slack',
    '/files.completeUploadExternal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: filename }],
        channel_id: SLACK_REVIEW_CHANNEL_ID,
      }),
    },
  );
  if (!completed.ok) {
    throw new Error(
      `Slack file completion failed: ${completed.error ?? 'unknown error'}`,
    );
  }

  const proposedCaption =
    submission.punchline ??
    `${submission.dogName} is ready for the spotlight: ${submission.trickName}.`;
  const posted = await connectorJson<{ ok: boolean; error?: string }>(
    'slack',
    '/chat.postMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: SLACK_REVIEW_CHANNEL_ID,
        text: `Review ${submission.dogName}'s trick: ${proposedCaption}`,
        unfurl_links: false,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'New Top Dog Tricks preview' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Dog:*\n${submission.dogName}` },
              { type: 'mrkdwn', text: `*Trick:*\n${submission.trickName}` },
            ],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Proposed caption:*\n${proposedCaption}` },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Review & approve' },
                url: `${publicBaseUrl}/admin?submission=${submission.id}`,
                action_id: `review_submission_${submission.id}`,
              },
            ],
          },
        ],
      }),
    },
  );
  if (!posted.ok) {
    throw new Error(
      `Slack preview post failed: ${posted.error ?? 'unknown error'}`,
    );
  }
}

export function getPublicBaseUrl(host: string | undefined): string {
  const configured =
    process.env.PUBLIC_APP_URL?.trim() ?? 'https://topdogtricks.com';
  if (configured) return configured.replace(/\/+$/, '');
  if (!host) throw new Error('PUBLIC_APP_URL or request host is required for media links');
  return `https://${host}`;
}