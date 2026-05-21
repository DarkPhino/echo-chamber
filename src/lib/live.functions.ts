import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// Gemini Live native-audio preview model. Voice + system instruction
// are baked into the ephemeral token, so the client cannot tamper with them.
const MODEL = "models/gemini-2.5-flash-native-audio-preview-09-2025";
const BREVITY = `Reglas de estilo (obligatorio):
- Estás en una llamada de voz en tiempo real, responde como una persona real.
- Máximo 2 o 3 frases por respuesta, breve y conversacional.
- Si te interrumpen, deja de hablar y escucha.
- Tono natural, cercano y directo. Sin introducciones formales.`;

const VALID_VOICES = new Set([
  "Aoede",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Zephyr",
]);

export const getLiveToken = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ influencerId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY no configurada en el servidor.");
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: inf, error } = await supabase
      .from("influencers")
      .select("id,name,bio,system_prompt,voice")
      .eq("id", data.influencerId)
      .maybeSingle();
    if (error || !inf) throw new Error("Influencer no encontrado.");

    const voice = VALID_VOICES.has(inf.voice as string)
      ? (inf.voice as string)
      : "Aoede";

    const systemInstruction = [
      inf.system_prompt?.trim() || `Eres ${inf.name}.`,
      inf.bio ? `\nContexto sobre ti: ${inf.bio}` : "",
      `\n\n${BREVITY}`,
    ].join("");

    // Mint single-session ephemeral token (~30 min validity, 1 min to start
    // a new session). Voice + model + system prompt are locked in.
    const now = Date.now();
    const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();

    const tokenRes = await fetch(
      `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            uses: 1,
            expireTime,
            newSessionExpireTime,
            bidiGenerateContentSetup: {
              model: MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                  },
                  languageCode: "es-ES",
                },
              },
              systemInstruction: { parts: [{ text: systemInstruction }] },
            },
            lockAdditionalFields: [],
          },
        }),
      },
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("auth_tokens error", tokenRes.status, errText);
      throw new Error(
        `No se pudo iniciar la llamada (Google ${tokenRes.status}).`,
      );
    }
    const tokenJson = (await tokenRes.json()) as { name?: string };
    if (!tokenJson.name) throw new Error("Token sin nombre.");

    return {
      token: tokenJson.name,
      model: MODEL,
      voice,
      systemInstruction,
      influencerName: inf.name as string,
    };
  });