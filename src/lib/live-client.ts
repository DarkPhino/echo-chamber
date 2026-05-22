// Thin wrapper over the Gemini Live BidiGenerateContent WebSocket.
// Uses an ephemeral access token issued by the backend so the real
// GEMINI_API_KEY is never shipped to the browser.

export type LiveEvents = {
  onOpen?: () => void;
  onAudio?: (b64: string) => void;
  onInterrupted?: () => void;
  onTurnComplete?: () => void;
  onUserTranscript?: (text: string) => void;
  onModelTranscript?: (text: string) => void;
  onError?: (msg: string) => void;
  onClose?: (code: number) => void;
};

export type LiveSetup = {
  model: string; // e.g. "models/gemini-2.5-flash-native-audio-preview-09-2025"
  voice: string; // e.g. "Aoede"
  systemInstruction: string;
  languageCode?: string; // e.g. "es-ES"
};

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private opened = false;

  constructor(
    private token: string,
    private setup: LiveSetup,
    private events: LiveEvents,
  ) {}

  connect() {
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=" +
      encodeURIComponent(this.token);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      const setupMsg = {
        setup: {
          model: this.setup.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: this.setup.voice },
              },
              languageCode: this.setup.languageCode ?? "es-ES",
            },
          },
          systemInstruction: {
            parts: [{ text: this.setup.systemInstruction }],
          },
          // Let Gemini handle voice activity detection automatically.
          realtimeInputConfig: {
            automaticActivityDetection: {},
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      };
      ws.send(JSON.stringify(setupMsg));
    };

    ws.onmessage = async (ev) => {
      let text: string;
      if (typeof ev.data === "string") text = ev.data;
      else if (ev.data instanceof ArrayBuffer)
        text = new TextDecoder().decode(ev.data);
      else if (ev.data instanceof Blob) text = await ev.data.text();
      else return;

      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.setupComplete) {
        this.opened = true;
        this.events.onOpen?.();
        return;
      }

      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.interrupted) {
        this.events.onInterrupted?.();
      }

      const parts: any[] = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        const inline = p.inlineData;
        if (
          inline?.data &&
          typeof inline.mimeType === "string" &&
          inline.mimeType.startsWith("audio/")
        ) {
          this.events.onAudio?.(inline.data);
        }
      }

      if (sc.inputTranscription?.text) {
        this.events.onUserTranscript?.(sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        this.events.onModelTranscript?.(sc.outputTranscription.text);
      }

      if (sc.turnComplete) {
        this.events.onTurnComplete?.();
      }
    };

    ws.onerror = () => {
      this.events.onError?.("Conexión con Gemini Live falló");
    };

    ws.onclose = (e) => {
      this.opened = false;
      this.events.onClose?.(e.code);
    };
  }

  sendAudio(b64: string) {
    if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
        },
      }),
    );
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.opened = false;
  }
}