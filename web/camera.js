'use strict';
// Optional, local preview only. Camera tracks never enter the voice recorder or server.
class LocalCamera {
  constructor(video, {onState = () => {}, onError = () => {}} = {}) {
    this.video = video;
    this.onState = onState;
    this.onError = onError;
    this.stream = null;
    this.generation = 0;
    this.phase = 'off';
  }
  setState(phase) { this.phase = phase; this.onState(phase); }
  stop() {
    this.generation++;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    this.video.srcObject = null;
    this.setState('off');
  }
  async start(deviceId = '') {
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError('Camera preview is unavailable here. You can continue with your avatar.');
      return;
    }
    this.setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {width: {ideal: 1280}, height: {ideal: 720}, ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: 'user'})},
        audio: false
      });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('Camera disconnected.');
      track.addEventListener('ended', () => {
        if (generation !== this.generation) return;
        this.stop();
        this.onError('Camera disconnected. Your avatar is back; the discussion can continue.');
      });
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      this.setState('on');
    } catch (cause) {
      if (generation !== this.generation) return;
      this.stop();
      const messages = {
        NotAllowedError: 'Camera permission was not allowed. Continue with your avatar, or allow Camera in your browser’s site settings and try again.',
        NotFoundError: 'No camera was found. Connect a webcam, then try again. You can continue with your avatar.',
        NotReadableError: 'The camera could not start. Close other apps using it, or choose another camera in Devices.',
        OverconstrainedError: 'That camera is no longer available. Choose another camera in Devices.',
        SecurityError: 'This browser blocked the camera. You can continue with your avatar.'
      };
      this.onError(messages[cause.name] || 'Camera preview could not start. You can continue with your avatar.');
    }
  }
}
window.LocalCamera = LocalCamera;
