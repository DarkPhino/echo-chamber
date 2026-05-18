import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DAILY_LIMIT = 20;

async function hashIp(ip: string) {
  const data = new TextEncoder().encode(ip + "alterego-salt");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, session_id, influencer_id, history = [] } = await req.json();
    if (!message || !session_id || !influencer_id) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Rate limit by IP (ad-hoc, MVP)
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const ipHash = await hashIp(ip);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);

    if ((count ?? 0) >= DAILY_LIMIT) {
      return new Response(
        JSON.stringify({ error: "Has alcanzado el límite diario de mensajes." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Load influencer
    const { data: influencer, error: infErr } = await supabase
      .from("influencers")
      .select("*")
      .eq("id", influencer_id)
      .maybeSingle();
    if (infErr || !influencer) {
      return new Response(JSON.stringify({ error: "Influencer no encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RAG retrieval (optional — skip if no chunks)
    let contextSnippets = "";
    const queryEmbedding = await embed(message);
    if (queryEmbedding) {
      const { data: matches } = await supabase.rpc("match_chunks", {
        query_embedding: queryEmbedding,
        match_influencer_id: influencer_id,
        match_count: 5,
      });
      if (matches && matches.length > 0) {
        contextSnippets = matches
          .map((m: { content: string }, i: number) => `[${i + 1}] ${m.content}`)
          .join("\n\n");
      }
    }

    const systemPrompt = `${influencer.system_prompt ?? `Eres ${influencer.name}.`}\n\n${
      contextSnippets
        ? `Contexto relevante extraído de tus videos:\n${contextSnippets}\n\nUsa este contexto cuando aplique, pero responde siempre en tu personaje y tono natural.`
        : "Aún no tienes videos indexados. Responde con tu personalidad general y, si te preguntan algo muy específico, dilo con honestidad."
    }`;

    const recentHistory = (history as { role: string; content: string }[]).slice(-8);
    const messages = [
      { role: "system", content: systemPrompt },
      ...recentHistory,
      { role: "user", content: message },
    ];

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5",
        messages,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      if (upstream.status === 429) {
        return new Response(
          JSON.stringify({ error: "Demasiadas solicitudes, intenta en un momento." }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (upstream.status === 402) {
        return new Response(
          JSON.stringify({ error: "Sin créditos de IA. Agrega créditos al workspace." }),
          {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pipe SSE through and capture full text for persistence
    let fullText = "";
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                continue;
              }
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
                  );
                }
              } catch {
                /* ignore */
              }
            }
          }
        } catch (e) {
          console.error("stream error", e);
        } finally {
          controller.close();

          // Persist conversation (fire-and-forget)
          const newMessages = [
            ...recentHistory,
            { role: "user", content: message },
            { role: "assistant", content: fullText },
          ];
          const { data: existing } = await supabase
            .from("conversations")
            .select("id, messages")
            .eq("session_id", session_id)
            .eq("influencer_id", influencer_id)
            .maybeSingle();
          if (existing) {
            const all = [
              ...((existing.messages as unknown[]) || []),
              { role: "user", content: message },
              { role: "assistant", content: fullText },
            ];
            await supabase
              .from("conversations")
              .update({ messages: all, updated_at: new Date().toISOString() })
              .eq("id", existing.id);
          } else {
            await supabase.from("conversations").insert({
              session_id,
              influencer_id,
              ip_hash: ipHash,
              messages: newMessages,
            });
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});