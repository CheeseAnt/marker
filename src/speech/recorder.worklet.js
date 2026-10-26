/* global AudioWorkletProcessor, registerProcessor */
// Copies microphone samples out of the audio thread, one 128-frame block at a time.
class MarkerRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('marker-recorder', MarkerRecorder)
