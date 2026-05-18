import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Simulated YouTube ingest pipeline for MVP.
 * Streams SSE progress events that the dashboard renders as a progress bar.
 * Inserts mocked video rows so the dashboard table populates.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const { youtube_channel_url, influencer_id } = await req.json();
  if (!youtube_channel_url || !influencer_id) {
    return new Response(JSON.stringify({ error: "Missing fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const encoder = new TextEncoder();
  const totalVideos = 87;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        send({ stage: "list", message: "Obteniendo lista de videos...", progress: 5 });
        await new Promise((r) => setTimeout(r, 800));

        send({
          stage: "transcribe",
          message: `Extrayendo transcripciones (0/${totalVideos} videos)...`,
          progress: 15,
        });

        // Simulate transcript extraction and seed mock video rows.
        const mockRows = Array.from({ length: 10 }).map((_, i) => ({
          influencer_id,
          youtube_id: `mock_${Date.now()}_${i}`,
          title: `Video de ejemplo #${i + 1} sobre productividad`,
          duration_seconds: 600 + i * 30,
          status: "done",
          processed_at: new Date().toISOString(),
        }));
        await supabase.from("videos").insert(mockRows);

        for (let i = 1; i <= 10; i++) {
          await new Promise((r) => setTimeout(r, 200));
          send({
            stage: "transcribe",
            message: `Extrayendo transcripciones (${Math.round(
              (i / 10) * totalVideos,
            )}/${totalVideos} videos)...`,
            progress: 15 + Math.round((i / 10) * 40),
          });
        }

        send({ stage: "embed", message: "Generando embeddings...", progress: 70 });
        await new Promise((r) => setTimeout(r, 800));

        send({ stage: "save", message: "Guardando en base de datos...", progress: 88 });
        await new Promise((r) => setTimeout(r, 600));

        send({
          stage: "done",
          message: `Completado: ${totalVideos} videos procesados, 4,320 fragmentos indexados`,
          progress: 100,
          total_videos: totalVideos,
          total_chunks: 4320,
        });
      } catch (e) {
        console.error(e);
        send({ stage: "error", message: "Error en el procesamiento", progress: 0 });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});