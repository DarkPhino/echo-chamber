import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Loader2, PhoneOff } from "lucide-react";
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

  const fetchToken = useServerFn(getLiveToken);
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const closedRef = useRef(false);
  const reconnectsRef = useRef(0);

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

    let tokenInfo: Awaited<ReturnType<typeof fetchToken>>;
    try {
      tokenInfo = await fetchToken({ data: { influencerId } });
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "No se pudo iniciar la llamada.");
      setStatus("error");
      return;
    }
    if (closedRef.current) return;

    // Set up audio player (24 kHz PCM out from Gemini).
    const player = new AudioPlayer(24000);
    player.onIdle(() => {
      if (!closedRef.current) setStatus("listening");
    });
    playerRef.current = player;

    // Set up WS client.
    const client = new GeminiLiveClient(
      tokenInfo.token,
      {
        model: tokenInfo.model,
        voice: tokenInfo.voice,
        systemInstruction: tokenInfo.systemInstruction,
        languageCode: "es-ES",
      },
      {
        onOpen: async () => {
          if (closedRef.current) return;
          reconnectsRef.current = 0;
          // Start mic capture only after WS is ready.
          try {
            const mic = new MicCapture((b64) => {
              clientRef.current?.sendAudio(b64);
            });
            await mic.start();
            if (closedRef.current) {
              await mic.stop();
              return;
            }
            micRef.current = mic;
            setStatus("listening");
          } catch (e: any) {
            console.error(e);
            setError(
              e?.name === "NotAllowedError"
                ? "Permiso de micrófono denegado."
                : "No pude acceder al micrófono.",
            );
            setStatus("error");
          }
        },
        onAudio: (b64) => {
          if (closedRef.current) return;
          setStatus("speaking");
          playerRef.current?.enqueue(b64);
        },
        onInterrupted: () => {
          playerRef.current?.interrupt();
          if (!closedRef.current) setStatus("listening");
        },
        onTurnComplete: () => {
          // Player.onIdle will flip back to "listening" when buffers drain.
        },
        onError: (msg) => {
          console.warn("live error:", msg);
        },
        onClose: (code) => {
          if (closedRef.current) return;
          // 1000 = normal. Anything else → try to reconnect.
          if (code !== 1000 && reconnectsRef.current < MAX_RECONNECTS) {
            const attempt = ++reconnectsRef.current;
            const delay = Math.min(1000 * 2 ** (attempt - 1), 4000);
            setStatus("reconnecting");
            setError(null);
            setTimeout(() => {
              if (closedRef.current) return;
              // Recreate everything (token may have been single-use).
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
  }, [fetchToken, influencerId, teardown]);

  useEffect(() => {
    closedRef.current = false;
    void connect();
    return () => {
      closedRef.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          ? "Escuchando…"
          : status === "speaking"
            ? "Hablando…"
            : "Error";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-primary/90 to-primary px-6 py-12 text-primary-foreground">
      <div className="text-center">
        <div className="text-xs uppercase tracking-widest opacity-70">
          Llamada en vivo · Gemini Live
        </div>
        <div className="mt-1 text-sm opacity-80">{statusLabel}</div>
      </div>

      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          {status === "listening" ? (
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
          {status === "listening" ? (
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white">
              <Mic className="h-3 w-3 text-white" />
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
            ? "Habla, te estoy escuchando…"
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

      <div className="flex items-center gap-6">
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