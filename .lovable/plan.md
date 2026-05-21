
## Resumen

Reemplazo completo del modo "Llamada en tiempo real" en `src/routes/chat.tsx`. Pasamos de un hack con Web Speech API (STT + TTS del navegador + LLM por texto) a **Gemini Live API nativa**: audio↔audio en una sola sesión WebSocket, con barge-in real, latencia <500ms y voz natural.

## Arquitectura

```
┌──────────────┐      WSS       ┌──────────────────┐    HTTPS    ┌─────────────┐
│  React       │ ◄────────────► │  Gemini Live API │             │  Supabase   │
│  (CallOverlay│  audio PCM 16k │  (Google direct) │             │  influencers│
│   + AudioCtx)│                └──────────────────┘             └─────────────┘
└──────┬───────┘                        ▲
       │ 1. POST /api/live-token        │ token efímero
       ▼                                │
┌──────────────────┐                    │
│ TanStack         │────────────────────┘
│ createServerFn   │  usa GEMINI_API_KEY (server-only)
│ getLiveToken     │  + carga influencer + arma systemPrompt
└──────────────────┘
```

**Flujo:**
1. Usuario pulsa "Llamar" → frontend pide token al server.
2. Server (createServerFn) lee `GEMINI_API_KEY`, carga el influencer, construye `systemInstruction` (name + bio + system_prompt + brevityRule) y crea un **ephemeral token** vía `auth_tokens.create` con `config` precargado (modelo, voz, idioma).
3. Frontend abre WebSocket directo a `wss://generativelanguage.googleapis.com/.../BidiGenerateContent` con el token efímero. La API key real **nunca** sale del servidor.
4. `AudioWorklet` captura mic a 16kHz PCM mono → envía como `realtimeInput.audio` (chunks de ~100ms).
5. Recibe `serverContent.modelTurn.parts[].inlineData` (PCM 24kHz) → reproduce vía `AudioContext` con cola de buffers.
6. Barge-in: la API emite `serverContent.interrupted` cuando detecta voz del usuario → frontend vacía la cola de reproducción inmediatamente.
7. Reconexión automática con backoff exponencial (1s, 2s, 4s, max 3 intentos).

## Cambios en archivos

### Nuevos
- **`src/lib/live.functions.ts`** — `getLiveToken({ influencerId })`: createServerFn que devuelve `{ token, model, voice, systemInstruction }`. Llama a `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens` con `GEMINI_API_KEY`, TTL 30min, single-use.
- **`src/lib/live-audio.ts`** — utilidades cliente: `MicCapture` (getUserMedia + AudioWorklet → PCM16 16k base64), `AudioPlayer` (cola de AudioBufferSourceNode 24k, método `interrupt()`).
- **`src/lib/live-client.ts`** — `GeminiLiveClient`: wrapper del WebSocket con eventos (`onOpen`, `onAudio`, `onInterrupted`, `onClose`, `onError`), reconexión, envío de `setup` inicial y `realtimeInput`.
- **`src/components/CallOverlay.tsx`** — extraído de chat.tsx, reescrito para Live. Estados visuales: `connecting`, `listening` (anillo verde pulsante), `speaking` (anillo morado animado), `error` (rojo con mensaje + reintentar). Botón colgar.
- **`public/pcm-worklet.js`** — AudioWorkletProcessor que downsamplea a 16kHz Int16.

### Modificados
- **`src/routes/chat.tsx`** — elimina toda la lógica Web Speech API del CallOverlay (~200 líneas). Sustituye por `<CallOverlay influencerId={...} onClose={...} />`. El chat de texto sigue intacto.
- **Migración DB**: añadir columna `voice text default 'Aoede'` a `influencers` para que cada influencer tenga voz (Aoede, Puck, Charon, Kore, Fenrir).
- **`src/routes/dashboard.tsx`** — select de voz en "Perfil del Influencer".

### Sin tocar
- Edge function `chat/index.ts` (chat por texto sigue igual).
- RAG / chunks / conversations.

## Variables de entorno

Te pediré vía `add_secret`:
- **`GEMINI_API_KEY`** — Google AI Studio → "Get API key" → copiar. Solo server-side (`process.env`). Nunca expuesta al cliente.

## Decisiones técnicas clave

| Decisión | Por qué |
|---|---|
| Token efímero, no proxy WS | Latencia mínima. Proxy WS desde Cloudflare Worker añade ~150ms y complica reconexión. Los ephemeral tokens son la pauta oficial de Google para clientes browser. |
| Modelo `gemini-2.5-flash-native-audio-preview-09-2025` | Audio nativo (no cascada STT→LLM→TTS) → voz mucho más natural y latencia ~300ms. |
| Voz por influencer | Respuesta a la pregunta 2. Columna `voice` en DB con default Aoede. Dashboard permite cambiarla. |
| System prompt al iniciar | Respuesta pregunta 3. Se inyecta una vez en `setup.systemInstruction`. Sin RAG por turno → mínima latencia. |
| AudioWorklet (no ScriptProcessor) | ScriptProcessor está deprecado y bloquea el main thread. |
| PCM crudo (no Opus) | Gemini Live espera PCM 16-bit 16kHz mono. Sin transcodificación. |

## Manejo de errores

- **Permiso de mic denegado** → toast + cierra overlay.
- **Token expirado/inválido** → pide uno nuevo y reconecta.
- **WS cerrado inesperado** → backoff exponencial (max 3 intentos) y luego muestra "Conexión perdida, reintentar".
- **Sin créditos / 429** → toast con mensaje claro.

## Pasos de implementación

1. Migración DB: añadir `voice` a `influencers`.
2. Pedir `GEMINI_API_KEY` vía add_secret.
3. Crear `live.functions.ts` (server) + registrar en start.ts si hace falta.
4. Crear utilidades cliente (`live-audio.ts`, `live-client.ts`, worklet).
5. Refactorizar `CallOverlay` en componente propio.
6. Integrar en `chat.tsx` (reemplazo del overlay viejo).
7. Añadir selector de voz en dashboard.
8. Verificar build + probar llamada end-to-end en preview.

## Notas

- Gemini Live es **preview**. La SDK puede cambiar; uso la API REST/WS directa (más estable que `@google/genai` que aún no soporta bien Live en browser puro sin Node).
- Coste: ~$3 input / $12 output por millón de tokens de audio. Avisaremos al usuario en el dashboard.
- No se persiste el audio. Sólo guardamos la transcripción del turno (Gemini Live emite `serverContent.outputTranscription` y `inputTranscription` opcionalmente) en `conversations` si lo quieres en una iteración futura.
