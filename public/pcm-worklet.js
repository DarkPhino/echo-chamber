// AudioWorklet that downsamples mic input to 16kHz mono PCM16
// and posts ~100ms chunks (1600 samples) as ArrayBuffers to the main thread.
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // e.g. 48000/16000 = 3
    this.acc = []; // accumulated resampled Float32 samples
    this.chunkSize = 1600; // 100ms at 16kHz
    this._pos = 0; // fractional position for resampling
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0]; // Float32Array @ sampleRate

    // Simple linear downsample
    let i = this._pos;
    while (i < ch.length) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const s0 = ch[idx] ?? 0;
      const s1 = ch[idx + 1] ?? s0;
      this.acc.push(s0 + (s1 - s0) * frac);
      i += this.ratio;
    }
    this._pos = i - ch.length;

    // Emit fixed-size chunks
    while (this.acc.length >= this.chunkSize) {
      const slice = this.acc.splice(0, this.chunkSize);
      const pcm = new Int16Array(this.chunkSize);
      for (let k = 0; k < this.chunkSize; k++) {
        let s = slice[k];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);