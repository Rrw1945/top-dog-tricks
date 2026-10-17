import { describe, expect, it } from 'vitest';
import { getGetStoredObjectQueryKey, getGetStoredObjectUrl } from '@workspace/api-client-react';
import { storedObjectRouteSuffix } from './utils';

describe('stored object URLs', () => {
  it('passes only the canonical suffix to the generated client on showcase and admin', () => {
    for (const objectPath of ['/objects/automation/processed.mp4', '/objects/uploads/original']) {
      const suffix = storedObjectRouteSuffix(objectPath);
      const url = getGetStoredObjectUrl(suffix);
      expect(url).toBe(`/api/storage/objects/${objectPath.slice('/objects/'.length)}`);
      expect(getGetStoredObjectQueryKey(suffix)).toEqual([url]);
      expect(url).not.toContain('/objects//objects/');
    }
    expect(storedObjectRouteSuffix(null)).toBe('');
  });

  it('rejects encoded, noncanonical and traversal paths instead of building unsafe URLs', () => {
    for (const path of ['/objects//objects/automation/video.mp4', '/objects/../private',
      '/objects/%2e%2e/private', '/objects/a\\b', '/storage/public-objects/file']) {
      expect(() => storedObjectRouteSuffix(path)).toThrow('Invalid stored object path');
    }
  });
});