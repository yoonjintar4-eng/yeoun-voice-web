class Recorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffers = []; this.length = 0; this.active = true;
    this.port.onmessage = ({data}) => {
      if (data === 'stop') { this.active = false; this.flush(); this.port.postMessage({stopped:true}); }
    };
  }
  flush() {
    if (!this.length) return;
    const samples = new Float32Array(this.length);
    let offset = 0;
    for (const buffer of this.buffers) { samples.set(buffer, offset); offset += buffer.length; }
    this.port.postMessage({samples}, [samples.buffer]); this.buffers = []; this.length = 0;
  }
  process(inputs, outputs) {
    if (this.active && inputs[0]?.[0]) {
      const input = inputs[0][0];
      this.buffers.push(new Float32Array(input)); this.length += input.length;
      if (this.length >= sampleRate * 30) this.flush();
    }
    // Keep the graph running without playing the microphone through the speakers.
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('voice-recorder', Recorder);
