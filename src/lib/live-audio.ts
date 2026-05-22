// Mic capture (16 kHz PCM16) and audio playback (24 kHz PCM16) helpers
// for Gemini Live API. Browser-only.

function int16ToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  for (let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
  return new Int16Array(buf);
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private muted = false;

  constructor(private onChunk: (b64: string) => void) {}

  setOnChunk(cb: (b64: string) => void) {
    this.onChunk = cb;
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Use native sample rate; worklet resamples to 16k internally.
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-worklet");
    this.node.port.onmessage = (e) => {
      if (this.muted) return;
      this.onChunk(int16ToBase64(e.data as ArrayBuffer));
    };
    this.source.connect(this.node);
    // Don't connect node to destination — we don't want to play mic back.
  }

  async stop() {
    try {
      this.node?.port.close();
      this.node?.disconnect();
    } catch {}
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      await this.ctx?.close();
    } catch {}
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

// Plays a continuous stream of PCM16 24kHz chunks by scheduling them
// back-to-back on an AudioContext timeline. Calling interrupt() stops
// all queued buffers immediately (used for barge-in).
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private active: AudioBufferSourceNode[] = [];
  private onEndCb: (() => void) | null = null;
  private pending = 0;

  constructor(private sampleRate = 24000) {}

  private ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.nextStart = this.ctx.currentTime;
    }
    return this.ctx;
  }

  onIdle(cb: () => void) {
    this.onEndCb = cb;
  }

  enqueue(b64: string) {
    const ctx = this.ensure();
    const pcm = base64ToInt16(b64);
    if (pcm.length === 0) return;
    const buf = ctx.createBuffer(1, pcm.length, this.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(this.nextStart, ctx.currentTime);
    src.start(startAt);
    this.nextStart = startAt + buf.duration;
    this.active.push(src);
    this.pending++;
    src.onended = () => {
      this.active = this.active.filter((s) => s !== src);
      this.pending--;
      if (this.pending <= 0) this.onEndCb?.();
    };
  }

  interrupt() {
    for (const s of this.active) {
      try {
        s.onended = null;
        s.stop();
      } catch {}
    }
    this.active = [];
    this.pending = 0;
    if (this.ctx) this.nextStart = this.ctx.currentTime;
  }

  async close() {
    this.interrupt();
    try {
      await this.ctx?.close();
    } catch {}
    this.ctx = null;
  }
}