import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Sparkles, Video, MessageCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export const Route = createFileRoute("/")({
  component: Index,
});

type Influencer = {
  id: string;
  name: string;
  slug: string;
  photo_url: string | null;
  tagline: string | null;
  bio: string | null;
  accent_color: string | null;
};

function Index() {
  const [inf, setInf] = useState<Influencer | null>(null);
  const [loading, setLoading] = useState(true);
  const [videoCount, setVideoCount] = useState<number | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("influencers")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const i = data as Influencer | null;
      setInf(i);
      setLoading(false);
      if (i) {
        const [{ count: vc }, { count: cc }] = await Promise.all([
          supabase
            .from("videos")
            .select("id", { count: "exact", head: true })
            .eq("influencer_id", i.id),
          supabase
            .from("chunks")
            .select("id", { count: "exact", head: true })
            .eq("influencer_id", i.id),
        ]);
        if (cancelled) return;
        setVideoCount(vc ?? 0);
        setChunkCount(cc ?? 0);
      } else {
        setVideoCount(0);
        setChunkCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const initials = (inf?.name ?? "AE")
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");

  function fmt(n: number | null) {
    if (n === null) return "…";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-white">
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, rgba(108,71,255,0.08) 0%, rgba(108,71,255,0) 70%)",
        }}
      />

      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="inline-block h-2 w-2 rounded-full bg-primary" />
          AlterEgo
        </div>
        <Link
          to="/dashboard"
          className="text-sm text-muted-foreground transition hover:text-foreground"
        >
          Dashboard
        </Link>
      </nav>

      <main className="mx-auto max-w-2xl px-6 pb-24 pt-16 text-center">
        {loading ? (
          <>
            <div className="mx-auto h-28 w-28 animate-pulse rounded-full bg-muted" />
            <div className="mx-auto mt-8 h-12 w-2/3 animate-pulse rounded-lg bg-muted" />
            <div className="mx-auto mt-4 h-5 w-1/2 animate-pulse rounded-md bg-muted" />
            <div className="mt-10">
              <div className="mx-auto h-12 w-56 animate-pulse rounded-xl bg-muted" />
            </div>
            <div className="mx-auto mt-16 max-w-xl space-y-2">
              <div className="h-4 w-full animate-pulse rounded bg-muted" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            </div>
          </>
        ) : (
          <>
            <Avatar className="mx-auto h-28 w-28 ring-4 ring-primary/10">
              {inf?.photo_url ? <AvatarImage src={inf.photo_url} alt={inf.name} /> : null}
              <AvatarFallback className="bg-primary text-2xl font-semibold text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>

            <h1 className="mt-8 text-5xl font-bold tracking-tight text-foreground sm:text-6xl">
              {inf?.name ?? "AlterEgo"}
            </h1>

            {inf?.tagline ? (
              <p className="mt-4 text-lg italic text-muted-foreground">"{inf.tagline}"</p>
            ) : null}

            <div className="mt-10">
              <Link to="/chat">
                <Button size="lg" className="h-12 gap-2 rounded-xl px-6 text-base">
                  Hablar con {inf?.name?.split(" ")[0] ?? "el clon"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>

            {inf?.bio ? (
              <p className="mx-auto mt-16 max-w-xl text-base leading-relaxed text-muted-foreground">
                {inf.bio}
              </p>
            ) : null}
          </>
        )}

        <div className="mx-auto mt-12 grid max-w-xl grid-cols-3 gap-4">
          <Stat icon={<Video className="h-4 w-4" />} value={fmt(videoCount)} label="Videos" />
          <Stat
            icon={<Sparkles className="h-4 w-4" />}
            value={fmt(chunkCount)}
            label="Fragmentos"
          />
          <Stat
            icon={<MessageCircle className="h-4 w-4" />}
            value="24/7"
            label="Disponible"
          />
        </div>
      </main>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-left shadow-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}
