import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2, PhoneOff, MessageSquare, X } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { getLiveToken } from "@/lib/live.functions";
import { MicCapture, AudioPlayer } from "@/lib/live-audio";
import { GeminiLiveClient } from "@/lib/live-client";

type Props = {
  influencerId: string;
  name: string;
  photoUrl: string | null;
  initials: string;
  onClose: () => void;
};

type Status =
  | "connecting"
  | "listening"
  | "speaking"
  | "error"
  | "reconnecting";

type Turn = { role: "user" | "assistant"; text: string };

const MAX_RECONNECTS = 3;

export default function CallOverlay({
  influencerId,
  name,
  photoUrl,
  initials,
  onClose,
}: Props) {
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);

  const fetchToken = useServerFn(getLiveToken);
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const closedRef = useRef(false);
  const reconnectsRef = useRef(0);
  const lastUserRef = useRef<"open" | "closed">("closed");
  const lastModelRef = useRef<"open" | "closed">("closed");

  // Append streaming transcript chunks into the current turn for each role.
  const appendTranscript = useCallback(
    (role: "user" | "assistant", text: string) => {
      setTurns((prev) => {
        const next = [...prev];
        const lastRef = role === "user" ? lastUserRef : lastModelRef;
        if (lastRef.current === "open" && next.length > 0) {
          // Try to append to the most recent same-role turn at the tail.
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === role) {
              next[i] = { role, text: next[i].text + text };
              return next;
            }
            // A turn from the other role broke the streak → start a new one.
            break;
          }
        }
        next.push({ role, text });
        lastRef.current = "open";
        return next;
      });
    },
    [],
  );

  const teardown = useCallback(() => {
    try {
      clientRef.current?.close();
    } catch {}
    clientRef.current = null;
    void micRef.current?.stop();
    micRef.current = null;
    void playerRef.current?.close();
    playerRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    if (closedRef.current) return;
    setStatus("connecting");
    setError(null);

    // 1) Acquire mic FIRST, inside the same gesture-rooted call stack as
    //    the click that opened the overlay. Browsers (Safari especially)
    //    will block getUserMedia if it happens after several awaits.
    let mic: MicCapture;
    try {
      mic = new MicCapture(() => {
        /* no-op until WS is ready */
      });
      await mic.start();
      if (closedRef.current) {
        await mic.stop();
        return;
      }
      mic.setMuted(muted);
      micRef.current = mic;
    } catch (e: any) {
      console.error("mic error", e);
      setError(
        e?.name === "NotAllowedError"
          ? "Permiso de micrófono denegado. Habilítalo en el navegador."
          : e?.name === "NotFoundError"
            ? "No encontré ningún micrófono."
            : "No pude acceder al micrófono.",
      );
      setStatus("error");
      return;
    }

    // 2) Mint an ephemeral token via the server function.
    let tokenInfo: Awaited<ReturnType<typeof fetchToken>>;
    try {
      tokenInfo = await fetchToken({ data: { influencerId } });
    } catch (e: any) {
      console.error("token error", e);
      setError(e?.message ?? "No se pudo iniciar la llamada.");
      setStatus("error");
      return;
    }
    if (closedRef.current) return;

    // 3) Audio player for the 24 kHz PCM coming back from Gemini.
    const player = new AudioPlayer(24000);
    player.onIdle(() => {
      if (!closedRef.current) setStatus("listening");
    });
    playerRef.current = player;

    // 4) Open the WebSocket and wire mic chunks to it.
    const client = new GeminiLiveClient(
      tokenInfo.token,
      {
        model: tokenInfo.model,
        voice: tokenInfo.voice,
        systemInstruction: tokenInfo.systemInstruction,
        languageCode: "es-ES",
      },
      {
        onOpen: () => {
          if (closedRef.current) return;
          reconnectsRef.current = 0;
          micRef.current?.setOnChunk((b64) =>
            clientRef.current?.sendAudio(b64),
          );
          setStatus("listening");
        },
        onAudio: (b64) => {
          if (closedRef.current) return;
          setStatus("speaking");
          playerRef.current?.enqueue(b64);
        },
        onInterrupted: () => {
          playerRef.current?.interrupt();
          lastModelRef.current = "closed";
          if (!closedRef.current) setStatus("listening");
        },
        onUserTranscript: (t) => {
          lastModelRef.current = "closed";
          appendTranscript("user", t);
        },
        onModelTranscript: (t) => {
          lastUserRef.current = "closed";
          appendTranscript("assistant", t);
        },
        onTurnComplete: () => {
          lastUserRef.current = "closed";
          lastModelRef.current = "closed";
        },
        onError: (msg) => {
          console.warn("live error:", msg);
        },
        onClose: (code) => {
          if (closedRef.current) return;
          if (code !== 1000 && reconnectsRef.current < MAX_RECONNECTS) {
            const attempt = ++reconnectsRef.current;
            const delay = Math.min(1000 * 2 ** (attempt - 1), 4000);
            setStatus("reconnecting");
            setError(null);
            setTimeout(() => {
              if (closedRef.current) return;
              teardown();
              void connect();
            }, delay);
          } else if (code !== 1000) {
            setError("Conexión perdida.");
            setStatus("error");
          }
        },
      },
    );
    clientRef.current = client;
    client.connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchToken, influencerId, teardown, appendTranscript]);

  useEffect(() => {
    closedRef.current = false;
    void connect();
    return () => {
      closedRef.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    micRef.current?.setMuted(muted);
  }, [muted]);

  function hangup() {
    closedRef.current = true;
    teardown();
    onClose();
  }

  const statusLabel =
    status === "connecting"
      ? "Conectando…"
      : status === "reconnecting"
        ? "Reconectando…"
        : status === "listening"
          ? muted
            ? "Micrófono silenciado"
            : "Escuchando…"
          : status === "speaking"
            ? "Hablando…"
            : "Error";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-primary/90 to-primary px-6 py-10 text-primary-foreground">
      <div className="flex w-full items-start justify-between gap-4">
        <div className="text-left">
          <div className="text-xs uppercase tracking-widest opacity-70">
            Llamada en vivo · Gemini Live
          </div>
          <div className="mt-1 text-sm opacity-80">{statusLabel}</div>
        </div>
        <button
          onClick={() => setShowTranscript((v) => !v)}
          className="flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3 text-xs hover:bg-white/25"
          aria-label="Mostrar transcripción"
        >
          {showTranscript ? <X className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
          {showTranscript ? "Ocultar" : "Transcripción"}
        </button>
      </div>

      {showTranscript ? (
        <div className="flex w-full max-w-md flex-1 flex-col gap-2 overflow-y-auto rounded-2xl bg-black/20 p-4 text-sm">
          {turns.length === 0 ? (
            <div className="text-center opacity-60">
              Aquí aparecerá la conversación.
            </div>
          ) : (
            turns.map((t, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 leading-snug",
                  t.role === "user"
                    ? "self-end bg-white/20"
                    : "self-start bg-white/10",
                )}
              >
                {t.text}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            {status === "listening" && !muted ? (
              <span className="absolute inset-0 -m-3 animate-ping rounded-full bg-emerald-400/30" />
            ) : null}
            {status === "speaking" ? (
              <span className="absolute inset-0 -m-3 animate-pulse rounded-full bg-white/20" />
            ) : null}
            <Avatar
              className={cn(
                "relative h-36 w-36 ring-4 ring-white/30 transition",
                status === "speaking" && "scale-105",
              )}
            >
              {photoUrl ? <AvatarImage src={photoUrl} /> : null}
              <AvatarFallback className="bg-white/20 text-3xl text-white">
                {initials}
              </AvatarFallback>
            </Avatar>
            {status === "listening" && !muted ? (
              <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white">
                <Mic className="h-3 w-3 text-white" />
              </span>
            ) : null}
            {muted ? (
              <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 ring-2 ring-white">
                <MicOff className="h-3 w-3 text-white" />
              </span>
            ) : null}
            {(status === "connecting" || status === "reconnecting") ? (
              <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-white text-primary ring-2 ring-white">
                <Loader2 className="h-3 w-3 animate-spin" />
              </span>
            ) : null}
          </div>

          <div className="text-xl font-semibold tracking-tight">{name}</div>

          <div className="min-h-[40px] max-w-md text-center text-sm opacity-90">
            {status === "listening"
              ? muted
                ? "Toca el micrófono para reanudar."
                : "Habla, te estoy escuchando…"
              : status === "speaking"
                ? "…"
                : status === "error"
                  ? error ?? "Algo salió mal."
                  : ""}
          </div>

          {status === "error" ? (
            <button
              onClick={() => {
                reconnectsRef.current = 0;
                teardown();
                void connect();
              }}
              className="rounded-full bg-white/20 px-4 py-2 text-sm hover:bg-white/30"
            >
              Reintentar
            </button>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-6">
        <button
          onClick={() => setMuted((m) => !m)}
          disabled={status === "error" || status === "connecting"}
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition",
            muted
              ? "bg-red-500 hover:bg-red-600"
              : "bg-white/20 hover:bg-white/30",
          )}
          aria-label={muted ? "Activar micrófono" : "Silenciar micrófono"}
        >
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          onClick={hangup}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition hover:bg-red-600"
          aria-label="Colgar"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}