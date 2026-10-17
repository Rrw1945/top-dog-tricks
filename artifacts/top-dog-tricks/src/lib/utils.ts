import { twMerge } from 'tailwind-merge';

import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// The generated API client appends this suffix to /api/storage/objects/.
// Submission DTOs instead carry an absolute storage object path.
export function storedObjectRouteSuffix(objectPath: string | null | undefined): string {
  if (!objectPath) return '';
  if (!objectPath.startsWith('/objects/')) throw new Error('Invalid stored object path');
  const suffix = objectPath.slice('/objects/'.length);
  if (!suffix || /[%\\\u0000-\u001f]/.test(suffix) ||
      suffix.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid stored object path');
  }
  return suffix;
}
