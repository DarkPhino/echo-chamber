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
                    <span>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled
                        className="h-9 w-9 shrink-0 rounded-xl"
                      >
                        <Phone className="h-4 w-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Próximamente — Conversación en tiempo real
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