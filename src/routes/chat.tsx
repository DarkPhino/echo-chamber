import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, MicOff, ArrowLeft, Phone } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import CallOverlay from "@/components/CallOverlay";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

type Msg = { role: "user" | "assistant"; content: string };
type Influencer = {
  id: string;
  name: string;
  photo_url: string | null;
  tagline: string | null;
};

const SUGGESTIONS = [
  "¿Por dónde empiezo en tecnología?",
  "Recomiéndame un libro",
  "¿Cómo organizas tu día?",
  "¿Qué herramientas usas?",
];

const DAILY_LIMIT = 50;
const HISTORY_LIMIT = 50;
const historyKey = (sid: string) => `alterego_chat_${sid}`;

function ChatPage() {
  const [inf, setInf] = useState<Influencer | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [remaining, setRemaining] = useState(DAILY_LIMIT);
  const [listening, setListening] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    supabase
      .from("influencers")
      .select("id,name,photo_url,tagline")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setInf(data as Influencer | null));
  }, []);

  // Load saved chat history from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(historyKey(getSessionId()));
      if (raw) {
        const parsed = JSON.parse(raw) as Msg[];
        if (Array.isArray(parsed)) setMessages(parsed.slice(-HISTORY_LIMIT));
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist chat history (capped) whenever messages change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (messages.length === 0) return;
    try {
      const trimmed = messages.slice(-HISTORY_LIMIT);
      window.localStorage.setItem(
        historyKey(getSessionId()),
        JSON.stringify(trimmed),
      );
    } catch {
      /* ignore */
    }
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [streaming]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streaming]);

  function toggleListening() {
    if (typeof window === "undefined") return;
    const SR: any =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "es-ES";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInput((finalText + interim).trim());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }

  const initials = (inf?.name ?? "AE")
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");

  async function send(text: string) {
    if (!text.trim() || !inf || streaming) return;
    if (remaining <= 0) return;

    const userMsg: Msg = { role: "user", content: text };
    const history = messages;
    setMessages((m) => [...m, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setRemaining((r) => r - 1);

    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            message: text,
            session_id: getSessionId(),
            influencer_id: inf.id,
            history,
          }),
        },
      );

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Error" }));
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: `⚠️ ${err.error ?? "Algo salió mal."}`,
          };
          return copy;
        });
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            if (j.delta) {
              full += j.delta;
              setMessages((m) => {
                const copy = [...m];
                copy[copy.length - 1] = { role: "assistant", content: full };
                return copy;
              });
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setStreaming(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  const showSuggestions = messages.length === 0 && !streaming;
  const hasInput = input.trim().length > 0;

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 border-b border-border bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            to="/"
            className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Avatar className="h-9 w-9">
            {inf?.photo_url ? <AvatarImage src={inf.photo_url} /> : null}
            <AvatarFallback className="bg-primary text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="text-sm font-semibold">{inf?.name ?? "..."}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              En línea
            </div>
          </div>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <Avatar className="mx-auto h-16 w-16">
                {inf?.photo_url ? <AvatarImage src={inf.photo_url} /> : null}
                <AvatarFallback className="bg-primary text-lg text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <p className="mt-4 text-sm text-muted-foreground">
                Empieza una conversación con {inf?.name?.split(" ")[0] ?? "el clon"}.
              </p>
            </div>
          ) : null}

          {messages.map((m, i) => (
            <Bubble key={i} msg={m} inf={inf} initials={initials} streaming={streaming && i === messages.length - 1} />
          ))}

          {showSuggestions ? (
            <div className="flex flex-wrap justify-center gap-2 pt-4">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-primary/40 px-3 py-1.5 text-xs text-foreground transition hover:bg-primary/5"
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border bg-white">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <div className="mb-2 text-center text-[11px] text-muted-foreground">
            {remaining} mensajes restantes hoy
          </div>
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:border-primary/50">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Escríbele a ${inf?.name?.split(" ")[0] ?? "..."}...`}
              rows={1}
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
              disabled={streaming || remaining <= 0}
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={listening ? "default" : "ghost"}
                    size="icon"
                    onClick={toggleListening}
                    className="h-9 w-9 shrink-0 rounded-xl"
                  >
                    {listening ? (
                      <MicOff className="h-4 w-4" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {listening ? "Detener dictado" : "Dictar por voz"}
                </TooltipContent>
              </Tooltip>
              {!hasInput ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setCallOpen(true)}
                      disabled={!inf || remaining <= 0}
                      className="h-9 w-9 shrink-0 rounded-xl"
                    >
                      <Phone className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Llamar — Conversación en tiempo real
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  onClick={() => send(input)}
                  disabled={!input.trim() || streaming || remaining <= 0}
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-xl"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </TooltipProvider>
          </div>
        </div>
      </div>

      {callOpen && inf ? (
        <CallOverlay
          inf={inf}
          initials={initials}
          onClose={() => setCallOpen(false)}
          remaining={remaining}
          setRemaining={setRemaining}
          messagesRef={messages}
          appendMessages={(u, a) =>
            setMessages((m) => [
              ...m,
              { role: "user", content: u },
              { role: "assistant", content: a },
            ])
          }
        />
      ) : null}
    </div>
  );
}

function Bubble({
  msg,
  inf,
  initials,
  streaming,
}: {
  msg: Msg;
  inf: Influencer | null;
  initials: string;
  streaming: boolean;
}) {
  const isUser = msg.role === "user";
  const empty = msg.content.length === 0;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <Avatar className="h-7 w-7 shrink-0">
        {inf?.photo_url ? <AvatarImage src={inf.photo_url} /> : null}
        <AvatarFallback className="bg-primary text-[10px] text-primary-foreground">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm text-foreground",
        )}
      >
        {empty && streaming ? <TypingDots /> : msg.content}
        {!empty && streaming ? <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-primary/60 align-middle" /> : null}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
    </span>
  );
}

type CallState = "idle" | "listening" | "thinking" | "speaking";

function CallOverlay({
  inf,
  initials,
  onClose,
  remaining,
  setRemaining,
  messagesRef,
  appendMessages,
}: {
  inf: Influencer;
  initials: string;
  onClose: () => void;
  remaining: number;
  setRemaining: React.Dispatch<React.SetStateAction<number>>;
  messagesRef: Msg[];
  appendMessages: (user: string, assistant: string) => void;
}) {
  const [state, setState] = useState<CallState>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  const speakQueueRef = useRef<string[]>([]);
  const speakingRef = useRef(false);
  const closedRef = useRef(false);
  const historyRef = useRef<Msg[]>(messagesRef);

  // Speak queued sentences via SpeechSynthesis, one at a time.
  const flushSpeech = useCallback(() => {
    if (speakingRef.current) return;
    const next = speakQueueRef.current.shift();
    if (!next) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(next);
    u.lang = "es-ES";
    u.rate = 1.05;
    u.pitch = 1;
    speakingRef.current = true;
    u.onend = () => {
      speakingRef.current = false;
      flushSpeech();
    };
    u.onerror = () => {
      speakingRef.current = false;
      flushSpeech();
    };
    window.speechSynthesis.speak(u);
  }, []);

  const enqueueSpeech = useCallback(
    (chunk: string) => {
      if (!chunk.trim()) return;
      speakQueueRef.current.push(chunk.trim());
      flushSpeech();
    },
    [flushSpeech],
  );

  const startListening = useCallback(() => {
    if (closedRef.current) return;
    const SR: any =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Tu navegador no soporta reconocimiento de voz.");
      return;
    }
    const rec = new SR();
    rec.lang = "es-ES";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      finalText = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setTranscript((finalText + interim).trim());
    };
    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(`Mic: ${e.error}`);
    };
    rec.onend = () => {
      const said = finalText.trim();
      if (closedRef.current) return;
      if (said.length > 0) {
        void respond(said);
      } else {
        // restart listening
        if (state !== "speaking") setTimeout(startListening, 250);
      }
    };
    recRef.current = rec;
    setTranscript("");
    setState("listening");
    try {
      rec.start();
    } catch {
      /* already started */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const respond = useCallback(
    async (userText: string) => {
      if (closedRef.current) return;
      if (remaining <= 0) {
        setError("Has alcanzado el límite diario.");
        return;
      }
      setState("thinking");
      setReply("");
      setRemaining((r) => r - 1);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
            },
            body: JSON.stringify({
              message: userText,
              session_id: getSessionId(),
              influencer_id: inf.id,
              history: historyRef.current,
            }),
          },
        );

        if (!res.ok || !res.body) {
          setError("No pude responder ahora.");
          setState("listening");
          startListening();
          return;
        }

        setState("speaking");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let full = "";
        let speakBuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              if (j.delta) {
                full += j.delta;
                speakBuf += j.delta;
                setReply(full);
                // flush complete sentences for low-latency TTS
                const match = speakBuf.match(/^([\s\S]*?[\.\!\?\n])/);
                if (match) {
                  enqueueSpeech(match[1]);
                  speakBuf = speakBuf.slice(match[1].length);
                }
              }
            } catch {
              /* ignore */
            }
          }
        }
        if (speakBuf.trim()) enqueueSpeech(speakBuf);

        // persist to parent chat list
        historyRef.current = [
          ...historyRef.current,
          { role: "user", content: userText },
          { role: "assistant", content: full },
        ];
        appendMessages(userText, full);

        // wait until TTS finishes, then listen again
        const waitDone = () =>
          new Promise<void>((resolve) => {
            const tick = () => {
              if (
                closedRef.current ||
                (speakQueueRef.current.length === 0 && !speakingRef.current)
              ) {
                resolve();
              } else {
                setTimeout(tick, 200);
              }
            };
            tick();
          });
        await waitDone();
        if (!closedRef.current) startListening();
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError("Error de red.");
        if (!closedRef.current) startListening();
      }
    },
    [inf.id, remaining, setRemaining, startListening, enqueueSpeech, appendMessages],
  );

  // Auto-start on open
  useEffect(() => {
    closedRef.current = false;
    startListening();
    return () => {
      closedRef.current = true;
      try {
        recRef.current?.stop();
      } catch {}
      try {
        abortRef.current?.abort();
      } catch {}
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      speakQueueRef.current = [];
      speakingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hangup() {
    closedRef.current = true;
    try {
      recRef.current?.stop();
    } catch {}
    try {
      abortRef.current?.abort();
    } catch {}
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    onClose();
  }

  const statusLabel =
    state === "listening"
      ? "Escuchando…"
      : state === "thinking"
        ? "Pensando…"
        : state === "speaking"
          ? "Hablando…"
          : "Conectando…";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-primary/90 to-primary px-6 py-12 text-primary-foreground">
      <div className="text-center">
        <div className="text-xs uppercase tracking-widest opacity-70">
          Llamada en vivo
        </div>
        <div className="mt-1 text-sm opacity-80">{statusLabel}</div>
      </div>

      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          <Avatar
            className={cn(
              "h-36 w-36 ring-4 ring-white/30 transition",
              state === "speaking" && "animate-pulse",
            )}
          >
            {inf.photo_url ? <AvatarImage src={inf.photo_url} /> : null}
            <AvatarFallback className="bg-white/20 text-3xl text-white">
              {initials}
            </AvatarFallback>
          </Avatar>
          {state === "listening" ? (
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white">
              <Mic className="h-3 w-3 text-white" />
            </span>
          ) : null}
          {state === "thinking" ? (
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-white text-primary ring-2 ring-white">
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          ) : null}
        </div>

        <div className="text-xl font-semibold tracking-tight">{inf.name}</div>

        <div className="min-h-[80px] max-w-md text-center text-sm opacity-90">
          {state === "speaking" || state === "thinking"
            ? reply || "…"
            : transcript || "Empieza a hablar…"}
        </div>

        {error ? (
          <div className="rounded-md bg-red-500/20 px-3 py-1 text-xs">
            {error}
          </div>
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