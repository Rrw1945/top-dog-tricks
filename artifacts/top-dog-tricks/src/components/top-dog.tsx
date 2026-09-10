import { Check, ChevronDown, FileVideo, Heart, Loader2, LockKeyhole, PawPrint, UploadCloud } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShowcaseEntriesQueryKey, useToggleShowcaseLike } from '@workspace/api-client-react';

export function BrandMark({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="brand-top-dog">
      <div className={`grid h-9 w-9 place-items-center rounded-[13px] rotate-[-7deg] ${dark ? 'bg-accent text-foreground' : 'bg-primary text-primary-foreground'}`}>
        <PawPrint size={19} strokeWidth={2.5} />
      </div>
      <div className={`leading-none ${dark ? 'text-sidebar-foreground' : 'text-foreground'}`}>
        <div className="font-display text-[17px] font-bold tracking-[-.06em]">TOP DOG</div>
        <div className="mono-face mt-1 text-[8px] uppercase tracking-[.26em] opacity-70">tricks / contest</div>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = { pending: 'Needs a look', approved: 'Approved', needs_edit: 'Needs edit', rejected: 'Rejected' };
  const colors: Record<string, string> = {
    pending: 'bg-accent/35 text-foreground',
    approved: 'bg-secondary text-secondary-foreground',
    needs_edit: 'bg-primary/12 text-primary',
    rejected: 'bg-destructive/10 text-destructive',
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${colors[status] ?? 'bg-muted text-muted-foreground'}`} data-testid={`status-pill-${status}`}>{labels[status] ?? status}</span>;
}

export function SectionKicker({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return <div className={`mono-face mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[.2em] ${dark ? 'text-accent' : 'text-primary'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</div>;
}

export function Button({ children, className = '', variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'outline' | 'danger' }) {
  const variants = {
    primary: 'bg-primary text-primary-foreground shadow-[0_7px_0_hsl(var(--primary)/.18)] hover:-translate-y-0.5 hover:shadow-[0_10px_0_hsl(var(--primary)/.18)]',
    quiet: 'bg-muted text-foreground hover:bg-accent',
    outline: 'border border-border bg-card text-foreground hover:border-primary hover:text-primary',
    danger: 'bg-destructive text-destructive-foreground hover:-translate-y-0.5',
  };
  return <button className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`} {...props}>{children}</button>;
}

function browserId(): string {
  const key = 'top-dog-tricks-browser-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

export function LikeButton({ submissionId, likeCount, dark = false }: { submissionId: number; likeCount: number; dark?: boolean }) {
  const queryClient = useQueryClient();
  const [liked, setLiked] = useState(() => window.localStorage.getItem(`top-dog-liked-${submissionId}`) === 'true');
  const [count, setCount] = useState(likeCount);
  const toggle = useToggleShowcaseLike({
    mutation: {
      onSuccess: (result) => {
        setLiked(result.liked);
        setCount(result.likeCount);
        window.localStorage.setItem(`top-dog-liked-${submissionId}`, String(result.liked));
        void queryClient.invalidateQueries({ queryKey: getListShowcaseEntriesQueryKey() });
      },
    },
  });
  return (
    <button
      type="button"
      aria-label={liked ? `Unlike this trick. ${count} likes` : `Like this trick. ${count} likes`}
      aria-pressed={liked}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate({ id: submissionId, data: { browserId: browserId() } })}
      className={`inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-xs font-extrabold transition-transform hover:-translate-y-0.5 disabled:opacity-60 ${liked ? 'bg-primary text-primary-foreground' : dark ? 'bg-white/12 text-white hover:bg-white/20' : 'bg-muted text-foreground hover:bg-accent'}`}
      data-testid={`button-like-${submissionId}`}
    >
      <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
      {liked ? 'Liked' : 'Like this trick'} <span aria-hidden="true">·</span> {count}
    </button>
  );
}

export function FileDrop({ label, hint, file, accept, onChange, disabled = false }: { label: string; hint: string; file: File | null; accept: string; onChange: (file: File | null) => void; disabled?: boolean }) {
  return (
    <label className={`group relative flex min-h-[142px] cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed p-5 text-center transition-colors ${file ? 'border-secondary bg-secondary/30' : 'border-border bg-card hover:border-primary hover:bg-accent/30'} ${disabled ? 'pointer-events-none opacity-60' : ''}`} data-testid={`dropzone-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <input className="sr-only" type="file" accept={accept} disabled={disabled} onChange={(event) => onChange(event.target.files?.[0] ?? null)} data-testid={`input-file-${label.toLowerCase().replace(/\s/g, '-')}`} />
      <div className={`mb-3 grid h-10 w-10 place-items-center rounded-xl ${file ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-primary group-hover:scale-105'}`}>
        {file ? <Check size={19} /> : <UploadCloud size={19} />}
      </div>
      <span className="text-sm font-bold">{file ? file.name : label}</span>
      <span className={`mt-1 max-w-[220px] text-xs ${file ? 'text-muted-foreground' : 'font-bold text-[#55B800]'}`}>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ready to upload` : hint}</span>
    </label>
  );
}

export function SubmitLoader({ text = 'Sending your entry' }: { text?: string }) {
  return <div className="flex items-center gap-2 text-sm font-bold"><Loader2 size={17} className="animate-spin" />{text}<span className="animate-pulse-soft">...</span></div>;
}

export function AdminRail({ onLogout }: { onLogout: () => void }) {
  return (
    <aside className="hidden min-h-[100dvh] w-[248px] shrink-0 flex-col bg-sidebar p-6 text-sidebar-foreground lg:flex">
      <BrandMark dark />
      <div className="mt-16">
        <div className="mono-face mb-3 px-3 text-[10px] uppercase tracking-[.18em] text-sidebar-foreground/45">Workspace</div>
        <div className="flex items-center gap-3 rounded-xl bg-sidebar-accent px-3 py-3 text-sm font-bold text-accent">
          <FileVideo size={17} /> Review queue <span className="ml-auto h-2 w-2 rounded-full bg-accent" />
        </div>
      </div>
      <div className="mt-auto border-t border-sidebar-border pt-5">
        <div className="mb-4 flex items-center gap-3 px-2 text-xs text-sidebar-foreground/55"><LockKeyhole size={15} /> Internal review only</div>
        <button onClick={onLogout} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground" data-testid="button-admin-logout">Sign out <ChevronDown size={15} className="ml-auto rotate-[-90deg]" /></button>
      </div>
    </aside>
  );
}