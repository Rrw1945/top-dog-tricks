import { ArrowLeft, ArrowRight, Film, Play, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  getGetStoredObjectQueryKey,
  useGetStoredObject,
  useListShowcaseEntries,
} from '@workspace/api-client-react';
import type { ShowcaseEntry } from '@workspace/api-client-react';
import { BrandMark, LikeButton, SectionKicker } from '@/components/top-dog';

export default function Showcase() {
  const entries = useListShowcaseEntries();

  return (
    <main className="paper-grain min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <a href="/"><BrandMark /></a>
        <a href="/" className="text-sm font-bold text-muted-foreground hover:text-primary"><ArrowLeft className="mr-1 inline" size={15} /> Enter your dog</a>
      </nav>
      <section className="mx-auto max-w-7xl px-5 pb-16 pt-16 sm:px-8 lg:pb-24 lg:pt-24">
        <SectionKicker>The spotlight</SectionKicker>
        <div className="mt-3 flex flex-col justify-between gap-7 lg:flex-row lg:items-end">
          <h1 className="display-face max-w-3xl text-6xl font-semibold leading-[.88] sm:text-8xl">The tricks<br /><span className="text-primary">that made it.</span></h1>
          <p className="max-w-sm text-sm leading-7 text-muted-foreground">Approved moments from the Top Dog Tricks stage. Every dog has a little magic in them.</p>
        </div>
      </section>
      <section className="border-y border-border bg-card/45">
        <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:py-14">
          {entries.isLoading ? <ShowcaseSkeleton /> : entries.isError ? <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-sm font-bold text-destructive">The spotlight is taking a beat. Please refresh and try again.</div> : entries.data?.length ? <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{entries.data.map((entry) => <ShowcaseCard key={entry.id} entry={entry} />)}</div> : <EmptyShowcase />}
        </div>
      </section>
      <footer className="bg-sidebar px-5 py-10 text-sidebar-foreground sm:px-8"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 sm:flex-row sm:items-center"><BrandMark dark /><a href="/" className="inline-flex items-center gap-2 text-sm font-bold text-sidebar-foreground hover:text-accent">Put your dog in the spotlight <ArrowRight size={16} /></a></div></footer>
    </main>
  );
}

function ShowcaseCard({ entry }: { entry: ShowcaseEntry }) {
  const objectPath = entry.processedVideoObjectPath || entry.videoObjectPath;
  const media = useStoredObjectUrl(objectPath);

  return <article className="group overflow-hidden rounded-3xl border border-border bg-card shadow-[0_10px_0_hsl(var(--foreground)/.04)]"><div className="relative aspect-[4/5] overflow-hidden bg-sidebar">{media.url ? <video className="h-full w-full object-cover" controls preload="metadata" src={media.url} data-testid={`video-showcase-${entry.id}`} /> : media.loading ? <div className="grid h-full place-items-center text-sidebar-foreground/70"><Play className="animate-pulse" /></div> : <div className="grid h-full place-items-center text-sidebar-foreground/70"><Film /></div>}<div className="pointer-events-none absolute left-4 top-4 rounded-full bg-accent px-3 py-1 text-[10px] font-extrabold uppercase tracking-[.12em] text-accent-foreground">Approved</div></div><div className="p-5"><div className="mono-face text-[10px] uppercase tracking-[.13em] text-primary">{entry.trickName}</div><h2 className="display-face mt-2 text-4xl font-semibold leading-[.9]">{entry.dogName}</h2>{entry.punchline && <p className="mt-4 text-sm font-bold leading-6 text-foreground/80">“{entry.punchline}”</p>}<p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{entry.trickDescription}</p><div className="mt-5"><LikeButton submissionId={entry.id} likeCount={entry.likeCount} /></div></div></article>;
}

function useStoredObjectUrl(objectPath: string) {
  const result = useGetStoredObject(objectPath, { query: { queryKey: getGetStoredObjectQueryKey(objectPath), enabled: Boolean(objectPath) } });
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!result.data) return;
    const next = URL.createObjectURL(result.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result.data]);
  return { url, loading: result.isLoading };
}

function EmptyShowcase() {
  return <div className="mx-auto max-w-xl py-20 text-center"><div className="mx-auto mb-6 grid h-16 w-16 rotate-[-6deg] place-items-center rounded-2xl bg-secondary text-secondary-foreground"><Sparkles size={25} /></div><h2 className="display-face text-5xl font-semibold leading-[.9]">The stage is<br /><span className="text-primary">warming up.</span></h2><p className="mx-auto mt-5 max-w-sm text-sm leading-7 text-muted-foreground">The first approved tricks will appear here. Have a star in the family? Enter them next.</p><a href="/" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">Enter the contest <ArrowRight size={16} /></a></div>;
}

function ShowcaseSkeleton() {
  return <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{[1, 2, 3].map((item) => <div className="overflow-hidden rounded-3xl border border-border bg-card" key={item}><div className="skeleton aspect-[4/5]" /><div className="space-y-3 p-5"><div className="skeleton h-3 w-24 rounded" /><div className="skeleton h-9 w-32 rounded" /><div className="skeleton h-12 w-full rounded" /></div></div>)}</div>;
}