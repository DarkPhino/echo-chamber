import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, User, Youtube, BarChart3, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});

type Influencer = {
  id: string;
  name: string;
  photo_url: string | null;
  tagline: string | null;
  bio: string | null;
  accent_color: string | null;
  voice: string | null;
};
type Video = {
  id: string;
  title: string | null;
  duration_seconds: number | null;
  status: string;
};

const SECTIONS = [
  { id: "profile", label: "Perfil del Influencer", icon: User },
  { id: "ingest", label: "Ingesta de YouTube", icon: Youtube },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
] as const;

function Dashboard() {
  const [section, setSection] =
    useState<(typeof SECTIONS)[number]["id"]>("profile");
  const [inf, setInf] = useState<Influencer | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [conversationsCount, setConversationsCount] = useState(0);
  const [messagesToday, setMessagesToday] = useState(0);
  const [uniqueUsers, setUniqueUsers] = useState(0);
  const [topQuestions, setTopQuestions] = useState<
    { question: string; count: number }[]
  >([]);

  async function load() {
    const { data: i } = await supabase
      .from("influencers")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    setInf(i as Influencer | null);
    if (i) {
      const { data: v } = await supabase
        .from("videos")
        .select("id,title,duration_seconds,status")
        .eq("influencer_id", (i as Influencer).id)
        .order("processed_at", { ascending: false });
      setVideos((v ?? []) as Video[]);

      const { count: cc } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("influencer_id", (i as Influencer).id);
      setConversationsCount(cc ?? 0);

      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const { data: today } = await supabase
        .from("conversations")
        .select("messages")
        .eq("influencer_id", (i as Influencer).id)
        .gte("updated_at", since.toISOString());
      const total = (today ?? []).reduce(
        (acc: number, row: { messages: unknown }) =>
          acc + (Array.isArray(row.messages) ? row.messages.length : 0),
        0,
      );
      setMessagesToday(total);

      // Unique users = distinct session_ids
      const { data: sessions } = await supabase
        .from("conversations")
        .select("session_id")
        .eq("influencer_id", (i as Influencer).id);
      const uniq = new Set(
        (sessions ?? []).map((r: { session_id: string }) => r.session_id),
      );
      setUniqueUsers(uniq.size);

      // Top questions = most frequent user messages across all conversations
      const { data: convs } = await supabase
        .from("conversations")
        .select("messages")
        .eq("influencer_id", (i as Influencer).id)
        .order("updated_at", { ascending: false })
        .limit(200);
      const freq = new Map<string, number>();
      for (const row of convs ?? []) {
        const msgs = (row as { messages: unknown }).messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs as { role: string; content: string }[]) {
          if (m.role !== "user" || typeof m.content !== "string") continue;
          const q = m.content.trim();
          if (q.length < 4 || q.length > 140) continue;
          const key = q.toLowerCase();
          freq.set(key, (freq.get(key) ?? 0) + 1);
        }
      }
      const top = Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([question, count]) => ({ question, count }));
      setTopQuestions(top);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="min-h-screen bg-[#F9FAFB]">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="text-sm font-semibold">Dashboard · AlterEgo</div>
          </div>
          <Link to="/chat" className="text-sm text-muted-foreground hover:text-foreground">
            Ver chat público →
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 md:grid md:grid-cols-[220px_1fr]">
        <aside className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition md:w-full md:text-left",
                section === s.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
            </button>
          ))}
        </aside>

        <main className="min-w-0">
          {section === "profile" && (
            <ProfileSection inf={inf} onSaved={load} />
          )}
          {section === "ingest" && (
            <IngestSection influencerId={inf?.id} videos={videos} onDone={load} />
          )}
          {section === "analytics" && (
            <AnalyticsSection
              conversationsCount={conversationsCount}
              messagesToday={messagesToday}
              uniqueUsers={uniqueUsers}
              topQuestions={topQuestions}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function ProfileSection({
  inf,
  onSaved,
}: {
  inf: Influencer | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Influencer | null>(inf);
  useEffect(() => setForm(inf), [inf]);
  const [saving, setSaving] = useState(false);

  if (!form) return <div className="text-muted-foreground">Cargando...</div>;

  async function save() {
    if (!form) return;
    setSaving(true);
    const { error } = await supabase
      .from("influencers")
      .update({
        name: form.name,
        photo_url: form.photo_url,
        tagline: form.tagline,
        bio: form.bio,
        accent_color: form.accent_color,
        voice: form.voice ?? "Aoede",
      })
      .eq("id", form.id);
    setSaving(false);
    if (error) {
      toast.error("No se pudo guardar");
      return;
    }
    toast.success("Cambios guardados");
    onSaved();
  }

  return (
    <Card title="Perfil del Influencer">
      <div className="grid gap-4">
        <Field label="Nombre">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Foto (URL)">
          <Input
            value={form.photo_url ?? ""}
            onChange={(e) => setForm({ ...form, photo_url: e.target.value })}
            placeholder="https://..."
          />
        </Field>
        <Field label="Frase característica">
          <Input
            value={form.tagline ?? ""}
            onChange={(e) => setForm({ ...form, tagline: e.target.value })}
          />
        </Field>
        <Field label="Bio corta">
          <Textarea
            value={form.bio ?? ""}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
            rows={3}
          />
        </Field>
        <Field label="Color acento">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.accent_color ?? "#6C47FF"}
              onChange={(e) =>
                setForm({ ...form, accent_color: e.target.value })
              }
              className="h-10 w-14 cursor-pointer rounded-lg border border-border bg-transparent"
            />
            <span className="text-sm text-muted-foreground">
              {form.accent_color}
            </span>
          </div>
        </Field>
        <Field label="Voz para llamadas en tiempo real (Gemini Live)">
          <select
            value={form.voice ?? "Aoede"}
            onChange={(e) => setForm({ ...form, voice: e.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="Aoede">Aoede — femenina cálida</option>
            <option value="Kore">Kore — femenina neutral</option>
            <option value="Leda">Leda — femenina suave</option>
            <option value="Zephyr">Zephyr — femenina enérgica</option>
            <option value="Puck">Puck — masculina enérgica</option>
            <option value="Charon">Charon — masculina grave</option>
            <option value="Fenrir">Fenrir — masculina firme</option>
            <option value="Orus">Orus — masculina cálida</option>
          </select>
        </Field>
        <div>
          <Button onClick={save} disabled={saving} className="rounded-xl">
            {saving ? "Guardando..." : "Guardar cambios"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function IngestSection({
  influencerId,
  videos,
  onDone,
}: {
  influencerId?: string;
  videos: Video[];
  onDone: () => void;
}) {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>("");

  async function run() {
    if (!url.trim() || !influencerId) return;
    setRunning(true);
    setProgress(0);
    setStage("Iniciando...");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            youtube_channel_url: url,
            influencer_id: influencerId,
          }),
        },
      );
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          try {
            const j = JSON.parse(t.slice(5).trim());
            if (typeof j.progress === "number") setProgress(j.progress);
            if (j.message) setStage(j.message);
          } catch {
            /* ignore */
          }
        }
      }
      toast.success("Canal procesado");
      onDone();
    } catch (e) {
      console.error(e);
      toast.error("Error en el procesamiento");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Card title="Procesar canal de YouTube">
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/@canal"
            disabled={running}
          />
          <Button onClick={run} disabled={running || !url.trim()} className="rounded-xl">
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Procesando
              </>
            ) : (
              "Procesar canal"
            )}
          </Button>
        </div>
        {(running || progress > 0) && (
          <div className="mt-4 space-y-2">
            <Progress value={progress} />
            <div className="text-sm text-muted-foreground">{stage}</div>
          </div>
        )}
      </Card>

      <Card title="Videos procesados">
        {videos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no se ha procesado ningún canal.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Título</th>
                  <th className="px-4 py-2 font-medium">Duración</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {videos.slice(0, 20).map((v) => (
                  <tr key={v.id} className="border-t border-border">
                    <td className="px-4 py-2">{v.title}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {formatDuration(v.duration_seconds ?? 0)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={v.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    done: { label: "Procesado", cls: "bg-emerald-100 text-emerald-700" },
    pending: { label: "Pendiente", cls: "bg-amber-100 text-amber-700" },
    processing: { label: "Procesando", cls: "bg-blue-100 text-blue-700" },
    error: { label: "Error", cls: "bg-red-100 text-red-700" },
  };
  const v = map[status] ?? map.pending;
  return (
    <Badge variant="secondary" className={cn("rounded-full font-medium", v.cls)}>
      {v.label}
    </Badge>
  );
}

function AnalyticsSection({
  conversationsCount,
  messagesToday,
  uniqueUsers,
  topQuestions,
}: {
  conversationsCount: number;
  messagesToday: number;
  uniqueUsers: number;
  topQuestions: { question: string; count: number }[];
}) {
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Metric label="Conversaciones totales" value={conversationsCount.toString()} />
        <Metric label="Mensajes hoy" value={messagesToday.toString()} />
        <Metric label="Usuarios únicos" value={uniqueUsers.toString()} />
      </div>
      <Card title="Preguntas más frecuentes">
        {topQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay suficientes conversaciones para mostrar tendencias.
          </p>
        ) : (
          <ul className="space-y-2 text-sm text-muted-foreground">
            {topQuestions.map((q) => (
              <li key={q.question} className="flex items-start justify-between gap-3">
                <span>· {q.question}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                  ×{q.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}