"use strict";

class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    const output = outputs[0];
    if (output && output[0]) output[0].fill(0);
    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);
