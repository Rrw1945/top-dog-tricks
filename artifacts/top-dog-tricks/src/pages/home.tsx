import { ArrowRight, CheckCircle2, CircleHelp, Film, Mail, Play, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { getGetStoredObjectQueryKey, getListShowcaseEntriesQueryKey, useCreateSubscriber, useCreateSubmission, useGetStoredObject, useListShowcaseEntries, useRequestUploadUrl, useResendSubscriberConfirmation } from '@workspace/api-client-react';
import type { ShowcaseEntry } from '@workspace/api-client-react';
import { Button, BrandMark, FileDrop, LikeButton, SectionKicker, SubmitLoader } from '@/components/top-dog';
import {
  trackCompletedSubscriptionFromUrl,
  trackEvent,
} from '@/lib/analytics';

const schema = z.object({
  ownerName: z.string().min(1, 'Tell us your name'),
  email: z.string().email('Use a valid email'),
  dogName: z.string().min(1, 'Every star needs a name'),
  trickDescription: z.string().min(1, 'Give the judges a little context'),
});
type FormValues = z.infer<typeof schema>;

const SUBSCRIBER_RESEND_COOLDOWN_MS = 15 * 60 * 1_000;
const SUBSCRIBER_RESEND_STATE_KEY = 'top-dog-tricks:subscriber-resend';

type SubscriberResendState = {
  email: string;
  cooldownEndsAt: number;
};

export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [signature, setSignature] = useState<File | null>(null);
  const [sent, setSent] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const requestUpload = useRequestUploadUrl();
  const createSubmission = useCreateSubmission();
  const spotlight = useListShowcaseEntries({ query: { queryKey: getListShowcaseEntriesQueryKey(), refetchInterval: 30_000 } });
  const form = useForm<FormValues>({ resolver: zod4Resolver(schema), defaultValues: { ownerName: '', email: '', dogName: '', trickDescription: '' } });

  async function upload(file: File) {
    const response = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type } });
    const result = await fetch(response.uploadURL, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!result.ok) throw new Error(`Upload failed (${result.status})`);
    return response.objectPath;
  }

  async function onSubmit(values: FormValues) {
    if (!video || !signature) {
      setUploadError('Add both your trick video and your signature to finish.');
      return;
    }
    setUploadError('');
    try {
      const [videoObjectPath, signatureObjectPath] = await Promise.all([upload(video), upload(signature)]);
      createSubmission.mutate({ data: { ...values, videoObjectPath, videoFileName: video.name, videoContentType: video.type, signatureObjectPath } }, { onSuccess: () => setSent(true), onError: () => setUploadError('Something interrupted the upload. Please try again.') });
    } catch {
      setUploadError('We could not upload those files. Check your connection and try again.');
    }
  }

  if (sent) return <SuccessState />;

  return (
    <main className="paper-grain min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <BrandMark />
         <div className="hidden items-center gap-5 sm:flex"><a href="/showcase" className="text-sm font-bold text-muted-foreground hover:text-primary">See the spotlight</a><a href="#entry" className="text-sm font-bold text-muted-foreground hover:text-primary" data-testid="link-jump-entry">Enter the contest <ArrowRight className="ml-1 inline" size={15} /></a></div>
      </nav>

      <section className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 pb-16 pt-10 sm:px-8 lg:grid-cols-[1.08fr_.92fr] lg:gap-20 lg:pb-28 lg:pt-20">
        <div className="relative z-10 animate-rise-in">
          <SectionKicker>Open call · season 04</SectionKicker>
          <h1 className="display-face max-w-[720px] text-[clamp(3.8rem,8vw,7.8rem)] font-semibold leading-[.86]">Big tricks.<br /><span className="text-primary">Bigger</span> character.</h1>
          <p className="mt-8 max-w-lg text-lg leading-8 text-muted-foreground">The internet’s friendliest dog trick contest. Show us the odd, the brilliant, the wonderfully overcommitted thing your dog does best.</p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a href="#entry" className="inline-flex min-h-12 items-center gap-3 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-[0_7px_0_hsl(var(--primary)/.18)] hover:-translate-y-0.5" data-testid="link-enter-contest">Put your dog in the spotlight <ArrowRight size={17} /></a>
            <span className="mono-face text-[10px] uppercase tracking-[.14em] text-muted-foreground">No perfect dogs required</span>
          </div>
        </div>
        <div className="relative min-h-[330px] animate-rise-in delay-1 lg:min-h-[480px]">
          <div className="absolute right-4 top-5 h-[82%] w-[73%] rotate-[4deg] rounded-[38px] bg-secondary shadow-[0_18px_0_hsl(var(--secondary-foreground)/.12)]" />
          <div className="absolute bottom-3 left-3 h-[68%] w-[63%] rotate-[-7deg] rounded-[32px] bg-[#76FF03] shadow-[0_18px_0_hsl(var(--accent-foreground)/.12)]" />
          <div className="animate-float-slow absolute inset-x-8 top-9 mx-auto flex h-[78%] w-[76%] rotate-[-4deg] items-end overflow-hidden rounded-[32px] bg-primary p-7 text-primary-foreground sm:inset-x-14">
            <div className="absolute right-[-12%] top-[-15%] h-48 w-48 rounded-full border-[24px] border-primary-foreground/10" />
            <div className="absolute bottom-0 right-[-2%] text-[180px] font-black leading-[.65] opacity-20">04</div>
            <div className="relative">
              <div className="mono-face mb-3 text-[10px] uppercase tracking-[.2em] text-primary-foreground/70">The stage is yours</div>
              <div className="display-face max-w-[270px] text-5xl font-semibold leading-[.9]">Let them see what makes your dog, your dog.</div>
            </div>
          </div>
          <div className="absolute right-0 top-0 grid h-16 w-16 rotate-12 place-items-center rounded-2xl bg-card text-primary shadow-xl"><Sparkles size={27} /></div>
        </div>
      </section>

      <Spotlight entries={spotlight.data ?? []} loading={spotlight.isLoading} error={spotlight.isError} onRetry={() => void spotlight.refetch()} />

      <section className="border-y border-border bg-card/60">
        <div className="mx-auto grid max-w-7xl gap-0 sm:grid-cols-3">
          {[['01', 'Film the moment', 'A phone video is perfect. The more personality, the better.'], ['02', 'Tell us the story', 'Give the judges the tiny detail that makes it yours.'], ['03', 'Take the stage', 'Our team reviews every entry with serious joy.']].map(([num, title, copy], index) => <div className={`border-border px-5 py-8 sm:px-8 ${index < 2 ? 'sm:border-r' : ''}`} key={num}><div className="mono-face mb-8 text-xs text-primary">{num}</div><h2 className="text-base font-extrabold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p></div>)}
        </div>
      </section>

      <section id="entry" className="mx-auto max-w-7xl scroll-mt-4 px-5 py-20 sm:px-8 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-[.65fr_1.35fr] lg:gap-24">
          <div className="lg:sticky lg:top-8 lg:self-start">
            <SectionKicker>Your entry</SectionKicker>
            <h2 className="display-face text-5xl font-semibold leading-[.93] sm:text-6xl">A little info.<br /><span className="text-primary">A lot of heart.</span></h2>
            <p className="mt-6 max-w-sm text-sm leading-7 text-muted-foreground">Entries are open to every dog, every breed, every gloriously specific personality. One video per entry.</p>
            <div className="mt-9 space-y-4 text-xs font-bold text-foreground/70"><div className="flex items-center gap-3"><ShieldCheck className="text-secondary-foreground" size={18} />Your files stay with the review team</div><div className="flex items-center gap-3"><CircleHelp className="text-primary" size={18} />Questions? hello@topdogtricks.com</div></div>
          </div>
          <form onSubmit={form.handleSubmit(onSubmit)} className="animate-rise-in relative space-y-10 rounded-[28px] border border-[#76FF03]/55 bg-card/65 p-5 shadow-[0_18px_60px_rgba(118,255,3,.10)] sm:p-8" data-testid="form-submission">
            <div className="absolute -top-4 left-6 rounded-full bg-primary px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.14em] text-primary-foreground shadow-[0_6px_0_hsl(var(--primary)/.18)]">Quick entry · four details</div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Your name" error={form.formState.errors.ownerName?.message}><input className="field-shell" placeholder="Maya Chen" {...form.register('ownerName')} data-testid="input-owner-name" /></Field>
              <Field label="Email" error={form.formState.errors.email?.message}><input className="field-shell" type="email" placeholder="maya@example.com" {...form.register('email')} data-testid="input-email" /></Field>
              <Field label="Dog's name" error={form.formState.errors.dogName?.message}><input className="field-shell" placeholder="Biscuit" {...form.register('dogName')} data-testid="input-dog-name" /></Field>
              <Field label="What does your dog do?" error={form.formState.errors.trickDescription?.message} className="sm:col-span-2"><textarea className="field-shell min-h-28 resize-y" placeholder="Tell us what happens and what the judges should notice." {...form.register('trickDescription')} data-testid="input-trick-description" /></Field>
            </div>
            <div className="border-t border-border pt-9">
              <SectionKicker>Upload the evidence</SectionKicker>
              <div className="grid gap-4 sm:grid-cols-2">
                <FileDrop label="Add your video" hint="MP4 or MOV · up to 500 MB" accept="video/mp4,video/quicktime,video/*" file={video} onChange={setVideo} disabled={createSubmission.isPending} />
                <SignaturePad onChange={setSignature} disabled={createSubmission.isPending} />
              </div>
              {uploadError && <p className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert" data-testid="status-submission-error">{uploadError}</p>}
            </div>
            <div className="flex flex-col items-start justify-between gap-5 border-t border-border pt-7 sm:flex-row sm:items-center">
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">By entering, you confirm you have permission to share this video and your dog is being treated kindly.</p>
              <Button type="submit" disabled={createSubmission.isPending || requestUpload.isPending}>{createSubmission.isPending || requestUpload.isPending ? <SubmitLoader text="Uploading entry" /> : <>Submit entry <ArrowRight size={17} /></>}</Button>
            </div>
          </form>
        </div>
      </section>

      <NewsletterSignup />
      <footer className="bg-sidebar px-5 py-9 text-sidebar-foreground sm:px-8"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 sm:flex-row sm:items-center"><BrandMark dark /><span className="mono-face text-[10px] uppercase tracking-[.18em] text-sidebar-foreground/50">Made for the dogs who make us laugh</span></div></footer>
    </main>
  );
}

function Spotlight({ entries, loading, error, onRetry }: { entries: ShowcaseEntry[]; loading: boolean; error: boolean; onRetry: () => void }) {
  const newest = useMemo(() => [...entries].filter((entry) => Boolean(entry.processedVideoObjectPath)).sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()).slice(0, 3), [entries]);
  return <section className="border-y border-border bg-sidebar px-5 py-14 text-sidebar-foreground sm:px-8 lg:py-20" data-testid="section-spotlight">
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div><SectionKicker dark>Fresh from the stage</SectionKicker><h2 className="display-face text-5xl font-semibold leading-[.9] sm:text-7xl">Three spots.<br /><span className="text-[#76FF03]">Big energy.</span></h2></div>
        <a href="/showcase" className="inline-flex items-center gap-2 text-sm font-bold text-[#76FF03] hover:translate-x-1" data-testid="link-spotlight-all">See all the tricks <ArrowRight size={16} /></a>
      </div>
      {error ? <div className="mt-8 flex items-center justify-between rounded-2xl border border-sidebar-foreground/15 bg-sidebar-accent p-5 text-sm"><span>The spotlight missed a beat.</span><button onClick={onRetry} className="font-bold text-accent underline" data-testid="button-retry-spotlight">Try again</button></div> : <div className="mt-9 grid gap-4 sm:grid-cols-3">
        {loading ? [0, 1, 2].map((slot) => <div key={slot} className="skeleton aspect-[4/5] rounded-2xl opacity-20" data-testid={`spotlight-loading-${slot}`} />) : [0, 1, 2].map((slot) => newest[slot] ? <SpotlightCard key={`${slot}-${newest[slot].id}`} entry={newest[slot]} position={slot + 1} /> : <div key={slot} className="flex aspect-[4/5] flex-col justify-between rounded-2xl border border-dashed border-sidebar-foreground/20 p-5 text-sidebar-foreground/45" data-testid={`spotlight-empty-${slot + 1}`}><span className="mono-face text-[10px] uppercase tracking-[.15em]">Position 0{slot + 1}</span><span className="display-face text-4xl leading-[.9]">Your dog could be here.</span></div>)}
      </div>}
    </div>
  </section>;
}

function SpotlightCard({ entry, position }: { entry: ShowcaseEntry; position: number }) {
  const path = entry.processedVideoObjectPath || entry.videoObjectPath;
  const media = useStoredMedia(path);
  return <article className="group relative overflow-hidden rounded-2xl bg-card text-foreground" data-testid={`spotlight-card-${entry.id}`}>
    <div className="aspect-[4/5] overflow-hidden bg-muted">{media.url ? <video className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" src={media.url} controls preload="metadata" data-testid={`video-spotlight-${entry.id}`} /> : media.loading ? <div className="grid h-full place-items-center"><Play className="animate-pulse text-primary" /></div> : <div className="grid h-full place-items-center"><Film className="text-muted-foreground" /></div>}</div>
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/90 via-foreground/55 to-transparent p-4 pt-16 text-background"><div className="mono-face text-[9px] uppercase tracking-[.14em] text-accent">0{position} · {entry.trickName}</div><h3 className="display-face mt-1 text-3xl font-semibold leading-[.9]">{entry.dogName}</h3><div className="mt-3"><LikeButton submissionId={entry.id} likeCount={entry.likeCount} dark /></div></div>
  </article>;
}

export function NewsletterSignup() {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [cooldownEndsAt, setCooldownEndsAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (trackCompletedSubscriptionFromUrl()) {
      setMessage('You’re subscribed. New tricks and contest updates will now land in your inbox.');
    }
  }, []);

  function beginResendCooldown(nextEmail: string) {
    const state: SubscriberResendState = {
      email: nextEmail.trim().toLowerCase(),
      cooldownEndsAt: Date.now() + SUBSCRIBER_RESEND_COOLDOWN_MS,
    };
    try {
      localStorage.setItem(SUBSCRIBER_RESEND_STATE_KEY, JSON.stringify(state));
    } catch {
      // Keep the cooldown active for this page view when storage is unavailable.
    }
    setPendingEmail(state.email);
    setCooldownEndsAt(state.cooldownEndsAt);
    setNow(Date.now());
  }

  useEffect(() => {
    function clearStoredResendState() {
      try {
        localStorage.removeItem(SUBSCRIBER_RESEND_STATE_KEY);
      } catch {
        // Storage cleanup is best-effort in restricted browser modes.
      }
    }

    try {
      const stored = localStorage.getItem(SUBSCRIBER_RESEND_STATE_KEY);
      if (!stored) return;
      const state = JSON.parse(stored) as Partial<SubscriberResendState>;
      if (typeof state.email !== 'string' || typeof state.cooldownEndsAt !== 'number') {
        clearStoredResendState();
        return;
      }
      setPendingEmail(state.email);
      setCooldownEndsAt(state.cooldownEndsAt);
    } catch {
      clearStoredResendState();
    }
  }, []);

  useEffect(() => {
    if (cooldownEndsAt <= now) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [cooldownEndsAt, now]);

  const cooldownRemainingMs = Math.max(0, cooldownEndsAt - now);
  const cooldownRemainingSeconds = Math.ceil(cooldownRemainingMs / 1_000);
  const cooldownMinutes = Math.floor(cooldownRemainingSeconds / 60);
  const cooldownSeconds = cooldownRemainingSeconds % 60;
  const cooldownActive = cooldownRemainingMs > 0;
  const cooldownLabel = `${cooldownMinutes}:${cooldownSeconds.toString().padStart(2, '0')}`;

  const subscribe = useCreateSubscriber({
    mutation: {
       onSuccess: (result, variables) => {
        setMessage(result.message);
        beginResendCooldown(variables.data.email);
        setEmail('');
        setConsent(false);
        trackEvent('subscription_confirmation_requested', {
          location: 'homepage_newsletter',
          request_type: 'initial',
          cohort: result.cohort,
        });
      },
      onError: () => setMessage('We could not start your subscription. Please try again.'),
    },
  });
  const resend = useResendSubscriberConfirmation({
    mutation: {
      onSuccess: (result) => {
        setMessage(result.message);
        beginResendCooldown(pendingEmail);
        trackEvent('subscription_confirmation_replacement_requested', {
          location: 'homepage_newsletter',
          request_type: 'replacement',
          cohort: result.cohort,
        });
      },
      onError: () => setMessage('We could not request another confirmation. Please try again.'),
    },
  });
  return (
    <section id="newsletter" className="border-t border-sidebar-foreground/10 bg-sidebar px-5 py-14 text-sidebar-foreground sm:px-8" aria-labelledby="newsletter-title">
      <div className="mx-auto grid max-w-7xl gap-8 rounded-[28px] border border-[#76FF03]/35 bg-white/[.04] p-6 sm:p-9 lg:grid-cols-[.8fr_1.2fr] lg:items-center">
        <div><div className="mono-face text-[10px] uppercase tracking-[.18em] text-[#76FF03]">Stay in the loop</div><h2 id="newsletter-title" className="display-face mt-3 text-4xl font-semibold leading-[.9]">Get new tricks<br />by email.</h2><p className="mt-4 max-w-sm text-sm leading-6 text-sidebar-foreground/65">New videos and contest updates. No spam.</p></div>
        <form onSubmit={(event) => { event.preventDefault(); setMessage(''); subscribe.mutate({ data: { email, consent } }); }} className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row"><label className="sr-only" htmlFor="subscriber-email">Email address</label><input id="subscriber-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="min-h-12 flex-1 rounded-xl border border-white/15 bg-white/10 px-4 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#76FF03]" data-testid="input-subscriber-email" /><Button type="submit" disabled={subscribe.isPending || !consent}><Mail size={17} />{subscribe.isPending ? 'Sending…' : 'Subscribe'}</Button></div>
          <label className="flex cursor-pointer items-start gap-3 text-xs leading-5 text-sidebar-foreground/65"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-[#76FF03]" data-testid="checkbox-subscriber-consent" /><span>Yes, email me new tricks and contest updates. I can unsubscribe anytime.</span></label>
          {message && <p className="text-sm font-bold text-[#76FF03]" role="status" data-testid="status-subscriber">{message}</p>}
          {pendingEmail && <div className="flex flex-wrap items-center gap-3 text-xs text-sidebar-foreground/65"><span aria-live="polite">{cooldownActive ? `You can request another email in ${cooldownLabel}.` : 'Didn’t receive it? You can request another email now.'}</span><button type="button" disabled={resend.isPending || cooldownActive} onClick={() => resend.mutate({ data: { email: pendingEmail } })} className="font-bold text-[#76FF03] underline decoration-[#76FF03]/50 underline-offset-4 disabled:opacity-50" data-testid="button-resend-subscriber-confirmation">{resend.isPending ? 'Requesting…' : cooldownActive ? `Request another email (${cooldownLabel})` : 'Request another email'}</button></div>}
        </form>
      </div>
    </section>
  );
}

function useStoredMedia(path: string) {
  const result = useGetStoredObject(path, { query: { queryKey: getGetStoredObjectQueryKey(path), enabled: Boolean(path) } });
  const [url, setUrl] = useState('');
  useEffect(() => { if (!result.data) return; const next = URL.createObjectURL(result.data); setUrl(next); return () => URL.revokeObjectURL(next); }, [result.data]);
  return { url, loading: result.isLoading };
}

function zod4Resolver(schema: z.ZodType<FormValues>): Resolver<FormValues> {
  return async (values) => {
    const result = schema.safeParse(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors = result.error.issues.reduce<Record<string, { type: string; message: string }>>(
      (fieldErrors, issue) => {
        const path = issue.path.join('.');
        if (path && !fieldErrors[path]) {
          fieldErrors[path] = { type: issue.code, message: issue.message };
        }
        return fieldErrors;
      },
      {},
    );

    return { values: {}, errors: errors as FieldErrors<FormValues> };
  };
}

function Field({ label, error, className = '', children }: { label: string; error?: string; className?: string; children: React.ReactNode }) {
  return <label className={`block ${className}`}><span className="mb-2 block text-xs font-extrabold uppercase tracking-[.07em] text-foreground/70">{label}</span>{children}{error && <span className="mt-1.5 block text-xs font-bold text-destructive">{error}</span>}</label>;
}

function SignaturePad({ onChange, disabled }: { onChange: (file: File | null) => void; disabled?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInkRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(180 * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 2.2;
    context.strokeStyle = '#243844';
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    drawing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y);
    context.stroke();
    hasInkRef.current = true;
    setHasInk(true);
  }

  function finishDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const canvas = canvasRef.current;
    if (!canvas || !hasInkRef.current) return;
    canvas.toBlob((blob) => {
      if (blob) onChange(new File([blob], 'signature.png', { type: 'image/png' }));
    }, 'image/png');
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="block text-xs font-extrabold uppercase tracking-[.07em] text-foreground/70">Your digital signature</span>
        <button type="button" onClick={clear} disabled={disabled || !hasInk} className="text-xs font-bold text-muted-foreground hover:text-primary disabled:opacity-40">Clear</button>
      </div>
      <div className="mb-4 rounded-xl border border-accent-foreground/15 bg-accent/35 px-4 py-3 text-xs font-bold leading-5 text-foreground/80">
        By signing, I certify that I own this video and grant Top Dog Tricks full permission to edit, optimize, and publish this media.
      </div>
      <div className="rounded-2xl border border-primary/30 bg-card p-2 shadow-[0_6px_0_hsl(var(--primary)/.08)]">
        <canvas
          ref={canvasRef}
          className="h-[180px] w-full cursor-crosshair touch-none rounded-xl bg-background"
          onPointerDown={startDrawing}
          onPointerMove={draw}
          onPointerUp={finishDrawing}
          onPointerCancel={finishDrawing}
          aria-label="Digital signature canvas"
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">Sign with your mouse or finger. Your signature is saved as an image with this entry.</p>
    </div>
  );
}

function SuccessState() {
  return <main className="paper-grain grid min-h-[100dvh] place-items-center bg-background px-5"><div className="w-full max-w-xl text-center animate-rise-in"><div className="mx-auto mb-7 grid h-20 w-20 rotate-[-6deg] place-items-center rounded-[26px] bg-secondary text-secondary-foreground shadow-[0_10px_0_hsl(var(--secondary-foreground)/.12)]"><CheckCircle2 size={38} /></div><SectionKicker>Entry received</SectionKicker><h1 className="display-face text-6xl font-semibold leading-[.9] sm:text-8xl">That was<br /><span className="text-primary">top dog.</span></h1><p className="mx-auto mt-7 max-w-md text-base leading-7 text-muted-foreground">Your entry is safely with the review team. Keep an eye on your inbox; we will be in touch when the judges have had their say.</p><a href="/" className="mt-9 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-bold hover:border-primary hover:text-primary" data-testid="link-submit-another"><Film size={16} /> Submit another entry</a></div></main>;
}