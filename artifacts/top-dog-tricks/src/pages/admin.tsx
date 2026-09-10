import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, Clock3, FileSignature, FileVideo, Filter, LogIn, MessageSquareText, RefreshCw, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation } from 'wouter';
import {
  getGetAdminSessionQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetStoredObjectQueryKey,
  getGetSubmissionQueryKey,
  getListSubmissionsQueryKey,
  useAdminLogin,
  useAdminLogout,
  useAnalyzeSubmission,
  useGetAdminSession,
  useGetDashboardSummary,
  useGetStoredObject,
  useGetSubmission,
  useListSubmissions,
  useUpdateSubmission,
} from '@workspace/api-client-react';
import type { Submission } from '@workspace/api-client-react';
import { AdminRail, Button, BrandMark, SectionKicker, StatusPill } from '@/components/top-dog';

type FilterValue = 'all' | 'pending' | 'approved' | 'needs_edit' | 'rejected';

const ANALYSIS_LEASE_MS = 20 * 60 * 1_000;
export default function Admin() {
  const session = useGetAdminSession();
  const login = useAdminLogin();
  const logout = useAdminLogout();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterValue>('all');
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('submission');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  });
  const params = useMemo(() => filter === 'all' ? {} : { status: filter }, [filter]);
  const summary = useGetDashboardSummary({ query: { enabled: Boolean(session.data?.authenticated), queryKey: getGetDashboardSummaryQueryKey() } });
  const list = useListSubmissions(params, { query: { enabled: Boolean(session.data?.authenticated), queryKey: getListSubmissionsQueryKey(params) } });
  const detail = useGetSubmission(selectedId ?? 0, { query: { enabled: Boolean(session.data?.authenticated && selectedId), queryKey: getGetSubmissionQueryKey(selectedId ?? 0), refetchInterval: 5_000 } });
  const update = useUpdateSubmission();
  const analyze = useAnalyzeSubmission();
  const [search, setSearch] = useState('');

  function refresh() {
    void summary.refetch();
    void list.refetch();
    if (selectedId) void detail.refetch();
  }

  function handleLogout() {
    logout.mutate(undefined, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getGetAdminSessionQueryKey() }); setSelectedId(null); } });
  }

  if (session.isLoading) return <AdminLoading />;
  if (!session.data?.authenticated) return <LoginScreen mutation={login} />;

  const filtered = (list.data ?? []).filter((entry) => {
    const query = search.trim().toLowerCase();
    return !query || [entry.dogName, entry.ownerName, entry.trickName].some((value) => value.toLowerCase().includes(query));
  });
  const selected = detail.data ?? (list.data ?? []).find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="paper-grain flex min-h-[100dvh] bg-background text-foreground">
      <AdminRail onLogout={handleLogout} />
      <main className="h-[100dvh] min-w-0 flex-1 overflow-y-auto overscroll-contain">
        <header className="flex items-center justify-between border-b border-border px-5 py-5 sm:px-8 lg:px-12">
          <div className="lg:hidden"><BrandMark /></div>
          <div className="hidden lg:block"><SectionKicker>Backstage / review desk</SectionKicker><h1 className="display-face text-4xl font-semibold leading-none">Good eye, good work.</h1></div>
          <div className="flex items-center gap-2">
            {selected && selected.status !== 'approved' && (
              <Button
                onClick={() => {
                  if (!window.confirm(`Approve ${selected.dogName}'s video? This starts final production and publishing.`)) return;
                  update.mutate(
                    { id: selected.id, data: { status: 'approved' } },
                    {
                      onSuccess: (next) => {
                        queryClient.setQueryData(getGetSubmissionQueryKey(next.id), next);
                        void queryClient.invalidateQueries({ queryKey: getListSubmissionsQueryKey(params) });
                        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
                      },
                    },
                  );
                }}
                disabled={update.isPending}
                className="bg-secondary text-secondary-foreground"
                data-testid="button-approve-header"
              >
                <Check size={16} />
                <span className="hidden sm:inline">Approve & publish</span>
                <span className="sm:hidden">Approve</span>
              </Button>
            )}
            <span className="hidden items-center gap-2 text-xs font-bold text-muted-foreground sm:flex"><span className="h-2 w-2 rounded-full bg-secondary-foreground" /> Live queue</span>
            <button onClick={refresh} className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-card hover:border-primary hover:text-primary" data-testid="button-refresh-dashboard"><RefreshCw size={16} className={list.isFetching ? 'animate-spin' : ''} /></button>
          </div>
        </header>
        <div className="px-5 py-7 sm:px-8 lg:px-12 lg:py-10">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="All entries" value={summary.data?.total} accent="bg-primary" icon={<FileVideo size={17} />} loading={summary.isLoading} />
            <SummaryCard label="Needs a look" value={summary.data?.pending} accent="bg-accent" icon={<Clock3 size={17} />} loading={summary.isLoading} />
            <SummaryCard label="Approved" value={summary.data?.approved} accent="bg-secondary" icon={<Check size={17} />} loading={summary.isLoading} />
            <SummaryCard label="Needs edit" value={summary.data?.needsEdit} accent="bg-muted" icon={<MessageSquareText size={17} />} loading={summary.isLoading} />
          </section>
          <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(360px,.82fr)_minmax(480px,1.18fr)]">
            <section className="min-w-0 rounded-2xl border border-border bg-card">
              <div className="border-b border-border p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-extrabold">Review queue</h2><p className="mt-1 text-xs text-muted-foreground">{filtered.length} {filtered.length === 1 ? 'entry' : 'entries'} in this view</p></div><Filter size={17} className="mt-1 text-primary" /></div>
                <div className="relative mt-5"><Search size={16} className="absolute left-3 top-3 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} className="field-shell pl-9" placeholder="Search dog, owner, trick" data-testid="input-search-submissions" /></div>
                <div className="mt-4 flex gap-1 overflow-x-auto pb-1">{(['all', 'pending', 'approved', 'needs_edit', 'rejected'] as FilterValue[]).map((value) => <button key={value} onClick={() => setFilter(value)} className={`whitespace-nowrap rounded-lg px-2.5 py-2 text-[11px] font-extrabold ${filter === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`} data-testid={`button-filter-${value}`}>{value === 'all' ? 'All' : value === 'needs_edit' ? 'Needs edit' : value[0].toUpperCase() + value.slice(1)}</button>)}</div>
              </div>
              <div className="max-h-[calc(100dvh-360px)] overflow-y-auto p-2">
                {list.isLoading ? <QueueSkeleton /> : list.isError ? <ErrorState onRetry={() => void list.refetch()} /> : filtered.length === 0 ? <EmptyQueue filter={filter} /> : filtered.map((entry) => <SubmissionRow key={entry.id} entry={entry} selected={selectedId === entry.id} onClick={() => setSelectedId(entry.id)} />)}
              </div>
            </section>
            <section className="min-w-0 space-y-4">
              {selected ? <>
                <AiReviewPanel submission={selected} analyze={analyze} update={update} onSaved={(next) => { queryClient.setQueryData(getGetSubmissionQueryKey(next.id), next); void queryClient.invalidateQueries({ queryKey: getListSubmissionsQueryKey(params) }); }} />
                <ReviewDetail submission={selected} update={update} onSaved={(next) => { queryClient.setQueryData(getGetSubmissionQueryKey(next.id), next); void queryClient.invalidateQueries({ queryKey: getListSubmissionsQueryKey(params) }); void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); }} />
              </> : <DetailEmpty />}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function AiReviewPanel({ submission, analyze, update, onSaved }: {
  submission: Submission;
  analyze: ReturnType<typeof useAnalyzeSubmission>;
  update: ReturnType<typeof useUpdateSubmission>;
  onSaved: (next: Submission) => void;
}) {
  const [message, setMessage] = useState('');
  const punchlines = useMemo(() => {
    if (!submission.aiPunchlines) return [];
    try {
      const parsed = JSON.parse(submission.aiPunchlines);
      return Array.isArray(parsed) ? parsed.map(String).slice(0, 3) : [];
    } catch {
      return [];
    }
  }, [submission.aiPunchlines]);
  const analysisInterrupted = submission.aiAnalysisStatus === 'analyzing' && (
    !submission.aiAnalysisHeartbeatAt ||
    Date.now() - new Date(submission.aiAnalysisHeartbeatAt).getTime() > ANALYSIS_LEASE_MS
  );
  const busy = analyze.isPending || (submission.aiAnalysisStatus === 'analyzing' && !analysisInterrupted);
  async function applySuggestion(data: { trimStartSeconds?: number | null; trimEndSeconds?: number | null; punchline?: string | null }, successMessage: string) {
    setMessage('');
    try {
      const next = await update.mutateAsync({ id: submission.id, data });
      onSaved(next);
      setMessage(successMessage);
    } catch {
      setMessage('Could not save that suggestion. Please try again.');
    }
  }

  return <div className="rounded-2xl border border-[#76FF03]/45 bg-sidebar p-5 text-sidebar-foreground shadow-[0_10px_30px_hsl(var(--foreground)/.08)]">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><SectionKicker dark>AI edit assistant</SectionKicker><h3 className="display-face text-3xl font-semibold">Find the trick.</h3><p className="mt-2 max-w-xl text-xs leading-5 text-sidebar-foreground/65">Gemini scans the full video in compressed chunks, then suggests the strongest action window and punchlines. You make the final call.</p></div>
      <Button
        onClick={() => analyze.mutate({ id: submission.id }, { onSuccess: onSaved })}
        disabled={busy}
        className="bg-[#76FF03] text-sidebar shadow-none"
        data-testid="button-analyze-video"
      >{busy ? <><RefreshCw size={16} className="animate-spin" /> Analyzing {submission.aiAnalysisChunksTotal ? `${submission.aiAnalysisChunksCompleted ?? 0}/${submission.aiAnalysisChunksTotal}` : 'video'}...</> : <><Sparkles size={16} /> {analysisInterrupted ? 'Retry analysis' : 'Analyze video'}</>}</Button>
    </div>
    {analysisInterrupted && <p className="mt-4 rounded-xl bg-[#76FF03]/10 p-3 text-xs font-bold text-[#76FF03]" data-testid="status-analysis-interrupted">The previous analysis was interrupted and is ready to retry safely.</p>}
    {submission.aiAnalysisError && <p className="mt-4 rounded-xl bg-destructive/15 p-3 text-xs font-bold text-destructive">{submission.aiAnalysisError}</p>}
    {submission.aiAnalysisStatus === 'completed' && <div className="mt-5 grid gap-4 border-t border-sidebar-foreground/10 pt-5">
      <div className="flex flex-wrap items-center gap-3 text-xs"><span className="rounded-full bg-[#76FF03] px-2.5 py-1 font-extrabold text-sidebar">AI confidence {Math.round((submission.aiConfidence ?? 0) * 100)}%</span><span className="text-sidebar-foreground/75">{submission.aiDetectedAction}</span></div>
      <div className="flex flex-wrap items-center gap-3"><span className="mono-face text-[10px] uppercase tracking-[.12em] text-sidebar-foreground/50">Suggested action: {submission.aiTrimStartSeconds?.toFixed(1)}s–{submission.aiTrimEndSeconds?.toFixed(1)}s</span><Button type="button" variant="outline" disabled={update.isPending} onClick={() => void applySuggestion({ trimStartSeconds: submission.aiTrimStartSeconds ?? null, trimEndSeconds: submission.aiTrimEndSeconds ?? null }, 'AI trim saved to the editor controls.')} data-testid="button-use-ai-trim">Use trim</Button></div>
      <div><div className="mono-face mb-2 text-[10px] uppercase tracking-[.12em] text-sidebar-foreground/50">Punchline options</div><div className="flex flex-wrap gap-2">{punchlines.map((line, index) => <button type="button" key={line} onClick={() => void applySuggestion({ punchline: line }, 'Punchline saved to the editor controls.')} disabled={update.isPending} className="rounded-xl border border-sidebar-foreground/15 bg-sidebar-accent px-3 py-2 text-left text-xs font-bold hover:border-[#76FF03] hover:text-[#76FF03]" data-testid={`button-ai-punchline-${index + 1}`}>{line}</button>)}</div></div>
      {message && <p className="text-xs font-bold text-[#76FF03]" data-testid="status-ai-suggestion-saved">{message}</p>}
    </div>}
  </div>;
}

function LoginScreen({ mutation }: { mutation: ReturnType<typeof useAdminLogin> }) {
  const queryClient = useQueryClient();
  const form = useForm<{ password: string }>({ defaultValues: { password: '' } });
   return <main className="paper-grain grid min-h-[100dvh] place-items-center bg-background px-5"><div className="w-full max-w-[440px] animate-rise-in"><BrandMark /><div className="mt-16 rounded-3xl border border-border bg-card p-7 shadow-[0_20px_60px_hsl(var(--foreground)/.07)] sm:p-9"><div className="mb-8 grid h-12 w-12 place-items-center rounded-2xl bg-sidebar text-accent"><ShieldCheck size={22} /></div><SectionKicker>Private workspace</SectionKicker><h1 className="display-face text-5xl font-semibold leading-[.92]">The dogs are<br />waiting on you.</h1><p className="mt-5 text-sm leading-6 text-muted-foreground">Sign in to review entries, give notes, and send the very best tricks to the spotlight.</p><form className="mt-8 space-y-4" onSubmit={form.handleSubmit((values) => mutation.mutate({ data: values }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getGetAdminSessionQueryKey() }); } }))}><label className="block"><span className="mb-2 block text-xs font-extrabold uppercase tracking-[.07em]">Team password</span><input autoFocus autoComplete="current-password" type="password" className="field-shell" placeholder="Enter password" {...form.register('password', { required: true })} data-testid="input-admin-password" /></label>{mutation.isError && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive" data-testid="status-login-error">That password did not open the desk. Try again.</p>}<Button className="w-full" type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Opening the desk...' : <><LogIn size={16} /> Enter review desk</>}</Button></form></div><p className="mono-face mt-6 text-center text-[10px] uppercase tracking-[.16em] text-muted-foreground">Top Dog Tricks · internal</p></div></main>;
}

function SummaryCard({ label, value, accent, icon, loading }: { label: string; value?: number; accent: string; icon: React.ReactNode; loading: boolean }) {
  return <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5"><div className={`absolute right-0 top-0 h-1.5 w-20 ${accent}`} /><div className="flex items-center justify-between text-muted-foreground"><span className="text-xs font-bold">{label}</span><span>{icon}</span></div>{loading ? <div className="skeleton mt-4 h-9 w-16 rounded-lg" /> : <div className="mt-3 text-4xl font-extrabold tracking-[-.06em]" data-testid={`text-summary-${label.toLowerCase().replace(/\s/g, '-')}`}>{value ?? 0}</div>}</div>;
}

function SubmissionRow({ entry, selected, onClick }: { entry: Submission; selected: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`group flex w-full items-center gap-3 rounded-xl p-3 text-left ${selected ? 'bg-accent/55' : 'hover:bg-muted/70'}`} data-testid={`button-submission-${entry.id}`}><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-extrabold ${selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}>{entry.dogName.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-extrabold">{entry.dogName}</span><StatusPill status={entry.status} /></div><div className="mt-1 truncate text-xs text-muted-foreground">{entry.trickName} · {entry.ownerName}</div></div><ChevronRight size={16} className={`shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 ${selected ? 'text-primary' : ''}`} /></button>;
}

function ReviewDetail({ submission, update, onSaved }: { submission: Submission; update: ReturnType<typeof useUpdateSubmission>; onSaved: (next: Submission) => void }) {
  const punchlineForm = useForm<{ punchline: string }>({ defaultValues: { punchline: submission.punchline ?? '' } });
  const trimForm = useForm<{ trimStartSeconds: string; trimEndSeconds: string }>({ defaultValues: { trimStartSeconds: submission.trimStartSeconds == null ? '' : String(submission.trimStartSeconds), trimEndSeconds: submission.trimEndSeconds == null ? '' : String(submission.trimEndSeconds) } });
  const [message, setMessage] = useState('');
  const video = useStoredObjectUrl(submission.videoObjectPath);
  const signature = useStoredObjectUrl(submission.signatureObjectPath);
  const processedVideo = useStoredObjectUrl(submission.processedVideoObjectPath);
  const voiceover = useStoredObjectUrl(submission.voiceoverObjectPath);
  useEffect(() => { punchlineForm.reset({ punchline: submission.punchline ?? '' }); trimForm.reset({ trimStartSeconds: submission.trimStartSeconds == null ? '' : String(submission.trimStartSeconds), trimEndSeconds: submission.trimEndSeconds == null ? '' : String(submission.trimEndSeconds) }); setMessage(''); }, [submission.id, submission.punchline, submission.trimStartSeconds, submission.trimEndSeconds]);
  function save(data: { punchline?: string | null; status?: 'pending' | 'approved' | 'needs_edit' | 'rejected'; trimStartSeconds?: number | null; trimEndSeconds?: number | null }) {
    update.mutate({ id: submission.id, data }, { onSuccess: (next) => { onSaved(next); setMessage(data.status ? (data.status === 'approved' ? 'Approved. Final production is now running.' : `Marked ${data.status === 'needs_edit' ? 'needs edit' : data.status}.`) : data.trimStartSeconds !== undefined || data.trimEndSeconds !== undefined ? 'Trim saved.' : 'Punchline saved.'); } });
  }
   return <div className="animate-rise-in rounded-2xl border border-border bg-card"><div className="border-b border-border p-5 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><SectionKicker>Entry #{String(submission.id).padStart(4, '0')}</SectionKicker><StatusPill status={submission.status} /></div><h2 className="display-face mt-1 text-5xl font-semibold leading-[.9]">{submission.dogName}</h2><p className="mt-3 text-sm text-muted-foreground">{submission.ownerName} · {submission.email}</p></div><div className="text-right text-xs text-muted-foreground"><div className="mono-face text-[10px] uppercase tracking-[.12em]">Submitted</div><div className="mt-1 font-bold">{formatDate(submission.submittedAt)}</div></div></div></div><div className="grid gap-6 p-5 sm:p-7"><div className="grid gap-4 sm:grid-cols-2"><MediaPreview label="Raw submission" url={video.url} loading={video.loading} testId="video-submission-preview" /><MediaPreview label="Processed preview" url={processedVideo.url} loading={processedVideo.loading} testId="video-processed-preview" /></div><div className="grid gap-5 sm:grid-cols-2"><InfoBlock label="The trick" value={submission.trickName} /><InfoBlock label="Breed or mix" value={submission.breedBio || 'Not provided'} /><div className="sm:col-span-2"><InfoBlock label="Owner's description" value={submission.trickDescription} /></div></div><div className="rounded-2xl border border-primary/20 bg-accent/30 p-4"><div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[.08em]"><FileVideo size={15} className="text-primary" /> Optional trim</div><p className="mt-2 text-xs leading-5 text-muted-foreground">Set the clean opening and closing moments. Leave either field blank to keep the original edge.</p><form onSubmit={trimForm.handleSubmit((data) => save({ trimStartSeconds: data.trimStartSeconds === '' ? null : Number(data.trimStartSeconds), trimEndSeconds: data.trimEndSeconds === '' ? null : Number(data.trimEndSeconds) }))} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="text-xs font-bold">Start (seconds)<input min="0" step="0.1" type="number" className="field-shell mt-1 bg-card" placeholder="0" {...trimForm.register('trimStartSeconds')} data-testid="input-trim-start" /></label><label className="text-xs font-bold">End (seconds)<input min="0" step="0.1" type="number" className="field-shell mt-1 bg-card" placeholder="Original end" {...trimForm.register('trimEndSeconds')} data-testid="input-trim-end" /></label><Button type="submit" variant="outline" disabled={update.isPending}>Save trim</Button></form></div><div className="rounded-2xl bg-muted/70 p-4"><div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[.08em]"><Sparkles size={15} className="text-primary" /> Punchline</div><span className="text-[11px] text-muted-foreground">Optional editorial note</span></div><form onSubmit={punchlineForm.handleSubmit((data) => save({ punchline: data.punchline || null }))} className="flex flex-col gap-3 sm:flex-row"><input className="field-shell bg-card" placeholder="The trick that stole the room..." {...punchlineForm.register('punchline')} data-testid="input-punchline" /><Button type="submit" variant="outline" disabled={update.isPending}>Save line</Button></form></div><div className="rounded-2xl border border-border bg-background p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[.08em]"><FileVideo size={15} className="text-primary" /> Processing</div><span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[.08em]">{submission.processingStatus}</span></div>{submission.processingError && <p className="mt-3 whitespace-pre-line text-xs leading-5 text-destructive">{submission.processingError}</p>}{voiceover.url && <audio className="mt-3 h-9 w-full" controls src={voiceover.url} data-testid="audio-voiceover-preview" />}</div><div className="rounded-2xl border border-secondary/40 bg-secondary/20 p-4"><div className="flex items-start gap-3"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-secondary-foreground" /><div><p className="text-sm font-extrabold">Approval starts final production and publishing</p><p className="mt-1 text-xs leading-5 text-foreground/70">Only approve when the trim and editorial notes are ready. This sends the entry into the final showcase workflow.</p></div></div><div className="mt-4 flex flex-col gap-3 border-t border-secondary-foreground/15 pt-4 sm:flex-row sm:items-center"><div className="flex flex-wrap gap-2"><Button onClick={() => { if (window.confirm('Approve this entry? Approval starts final production and publishing.')) save({ status: 'approved' }); }} disabled={update.isPending} className="bg-secondary text-secondary-foreground shadow-[0_7px_0_hsl(var(--secondary-foreground)/.14)] hover:shadow-[0_10px_0_hsl(var(--secondary-foreground)/.14)]"><Check size={16} /> Approve & publish</Button><Button onClick={() => save({ status: 'needs_edit' })} disabled={update.isPending} variant="quiet"><MessageSquareText size={16} /> Request edit</Button><Button onClick={() => save({ status: 'rejected' })} disabled={update.isPending} variant="danger"><X size={16} /> Reject</Button></div>{message && <span className="text-xs font-bold text-secondary-foreground" data-testid="status-review-success">{message}</span>}</div></div><div className="flex flex-wrap items-center gap-4 border-t border-border pt-4 text-xs text-muted-foreground"><span className="flex items-center gap-2"><FileSignature size={14} /> Signature file {signature.url ? <a className="font-bold text-primary hover:underline" href={signature.url} target="_blank" rel="noreferrer" data-testid="link-signature-preview">View</a> : 'loading'}</span><span>Phone: {submission.phone}</span><span>Video: {submission.videoFileName}</span>{submission.driveReleaseUrl && <a className="font-bold text-primary hover:underline" href={submission.driveReleaseUrl} target="_blank" rel="noreferrer">Legal release in Drive</a>}</div></div></div>;
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return <div><div className="mono-face mb-1.5 text-[10px] uppercase tracking-[.13em] text-muted-foreground">{label}</div><p className="text-sm font-bold leading-6">{value}</p></div>;
}

function DetailEmpty() {
  return <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center"><div><div className="mx-auto mb-5 grid h-14 w-14 rotate-[-7deg] place-items-center rounded-2xl bg-accent text-foreground"><FileVideo size={24} /></div><h2 className="display-face text-4xl font-semibold">Pick an entry.</h2><p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">Your review desk is ready. Select a dog from the queue to see their moment.</p></div></div>;
}

function QueueSkeleton() {
  return <div className="space-y-2 p-1">{[1, 2, 3, 4, 5].map((item) => <div className="flex gap-3 rounded-xl p-3" key={item}><div className="skeleton h-11 w-11 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-3/5 rounded" /><div className="skeleton mt-2 h-3 w-4/5 rounded" /></div></div>)}</div>;
}

function EmptyQueue({ filter }: { filter: FilterValue }) {
  return <div className="px-5 py-14 text-center"><div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-secondary text-secondary-foreground"><Check size={20} /></div><p className="text-sm font-extrabold">{filter === 'all' ? 'The queue is clear.' : 'No entries here.'}</p><p className="mt-1 text-xs text-muted-foreground">A very good sign.</p></div>;
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="px-5 py-14 text-center"><p className="text-sm font-extrabold">The queue missed a beat.</p><p className="mt-1 text-xs text-muted-foreground">Try refreshing the review desk.</p><button onClick={onRetry} className="mt-4 text-xs font-extrabold text-primary hover:underline" data-testid="button-retry-queue">Try again</button></div>;
}

function AdminLoading() {
  return <main className="min-h-[100dvh] bg-background p-6"><div className="skeleton h-9 w-36 rounded-xl" /><div className="mx-auto mt-20 max-w-6xl"><div className="skeleton h-14 w-80 rounded-xl" /><div className="mt-8 grid gap-4 sm:grid-cols-4">{[1, 2, 3, 4].map((item) => <div className="skeleton h-28 rounded-2xl" key={item} />)}</div></div></main>;
}

function useStoredObjectUrl(objectPath?: string | null) {
  const path = objectPath ?? '';
  const result = useGetStoredObject(path, { query: { queryKey: getGetStoredObjectQueryKey(path), enabled: Boolean(path) } });
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!result.data) return;
    const next = URL.createObjectURL(result.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result.data]);
  return { url, loading: result.isLoading, error: result.isError };
}

function formatDate(value: string) {
  try { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)); } catch { return value; }
}

function MediaPreview({ label, url, loading, testId }: { label: string; url: string; loading: boolean; testId: string }) {
  return <div className="overflow-hidden rounded-2xl bg-sidebar"><div className="flex items-center justify-between border-b border-sidebar-foreground/10 px-4 py-3 text-[10px] font-extrabold uppercase tracking-[.12em] text-sidebar-foreground/70"><span>{label}</span>{loading && <RefreshCw size={13} className="animate-spin" />}</div><div className="flex aspect-video items-center justify-center">{url ? <video className="h-full w-full object-contain" controls src={url} data-testid={testId} /> : loading ? <div className="text-center text-sidebar-foreground/70"><FileVideo className="mx-auto mb-2 animate-pulse" /><span className="text-xs">Processing media</span></div> : <div className="px-5 text-center text-sidebar-foreground/70"><FileVideo className="mx-auto mb-2" /><span className="text-xs">No processed asset yet</span></div>}</div></div>;
}
