import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Admin from './admin';

const json = (data: unknown) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' },
});
const row = (id: number, dogName: string) => ({
  id, dogName, ownerName: 'Fixture owner', trickName: 'Spin', status: 'pending',
});
let client: QueryClient;
let queueRequests: URL[];
let resolveDetail: (response: Response) => void;

beforeEach(() => {
  window.history.replaceState({}, '', '/admin');
  queueRequests = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://local.test');
    switch (url.pathname) {
      case '/api/admin/session': return json({ authenticated: true });
      case '/api/dashboard/summary': return json({ total: 2, pending: 2, approved: 0, needsEdit: 0 });
      case '/api/admin/newsletter-funnel': return json(null);
      case '/api/admin/deferred-confirmations': return json(null);
      case '/api/submissions':
        queueRequests.push(url);
        return json(url.searchParams.has('cursor')
          ? { records: [row(50, 'Second page dog')], nextCursor: null }
          : { records: [row(100, 'First page dog')], nextCursor: 90 });
      case '/api/submissions/100':
        return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      default: throw new Error(`Unexpected fixture route: ${url.pathname}`);
    }
  }));
  render(<QueryClientProvider client={client}><Admin /></QueryClientProvider>);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

describe('older admin compatibility with the paginated API', () => {
  it('reads records, pages in both directions, and searches the server from the first page', async () => {
    await screen.findByTestId('button-submission-100');
    fireEvent.click(screen.getByTestId('button-queue-next'));
    await screen.findByTestId('button-submission-50');
    expect(queueRequests.at(-1)?.searchParams.get('cursor')).toBe('90');
    expect(screen.getByTestId('button-queue-next')).toBeDisabled();

    fireEvent.click(screen.getByTestId('button-queue-previous'));
    await screen.findByTestId('button-submission-100');
    fireEvent.change(screen.getByTestId('input-search-submissions'), { target: { value: 'dog' } });
    await waitFor(() => expect(queueRequests.at(-1)?.searchParams.get('search')).toBe('dog'));
    expect(queueRequests.at(-1)?.searchParams.has('cursor')).toBe(false);
    expect(screen.getByTestId('button-queue-previous')).toBeDisabled();

    fireEvent.change(screen.getByTestId('input-search-submissions'), { target: { value: 'do' } });
    await screen.findByText('Enter at least 3 characters, or clear the search to browse entries.');
    expect(queueRequests.some((url) => url.searchParams.get('search') === 'do')).toBe(false);
  });

  it('loads the complete detail before exposing approval or private fields', async () => {
    fireEvent.click(await screen.findByTestId('button-submission-100'));
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    expect(screen.queryByTestId('button-approve-header')).not.toBeInTheDocument();
    await act(async () => resolveDetail(json({
      ...row(100, 'First page dog'),
      email: 'fixture@example.com', phone: '', trickDescription: 'Full detail fixture',
      videoObjectPath: '', signatureObjectPath: '', videoFileName: 'fixture.mp4',
      videoContentType: 'video/mp4', processingStatus: 'pending', aiAnalysisStatus: 'pending',
      submittedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    })));
    await screen.findByText('Full detail fixture');
    expect(screen.getByTestId('button-approve-header')).toBeEnabled();
  });
});
