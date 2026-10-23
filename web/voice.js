'use strict';

// Require sustained input before treating a quiet gap as the end of a turn.
class SpeechEndDetector {
  constructor() {
    this.noiseFloor = 0.0003;
    this.speechMs = 0;
    this.heardSpeech = false;
    this.lastVoiceAt = null;
    this.previousAt = null;
  }

  update(rms, now) {
    const elapsed = this.previousAt === null ? 0 : Math.min(100, Math.max(0, now - this.previousAt));
    this.previousAt = now;
    const threshold = Math.max(0.0015, this.noiseFloor * 3);
    if (rms >= threshold) {
      if (!this.heardSpeech && this.lastVoiceAt !== null && now - this.lastVoiceAt > 300) this.speechMs = 0;
      this.speechMs += elapsed;
      this.lastVoiceAt = now;
      if (this.speechMs >= 250) this.heardSpeech = true;
    } else if (rms < threshold * 0.7) {
      this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
    }
    return this.heardSpeech && now - this.lastVoiceAt >= 1500;
  }
}

// Record with the browser; transcribe on our Python server, without Web Speech.
class LocalVoice {
  constructor(hooks) {
    this.hooks = hooks;
    this.generation = 0;
    this.phase = 'idle';
  }

  setPhase(phase) {
    this.phase = phase;
    this.hooks.onPhase(phase);
  }

  cleanupCapture() {
    clearInterval(this.clock);
    clearTimeout(this.limit);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.hooks.onLevel(0);
  }

  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.ondataavailable = null;
      try { this.recorder.stop(); } catch (_) {}
    }
    this.recorder = null;
    this.cleanupCapture();
    this.setPhase('idle');
  }

  stop(reason = 'manual') {
    if (this.phase !== 'recording' || !this.recorder) return;
    this.stopReason = reason;
    this.setPhase('transcribing');
    this.hooks.onStatus('Transcribing your recording on the Python server…');
    clearInterval(this.clock);
    clearTimeout(this.limit);
    this.recorder.stop();
    // Release tracks in onstop, after the browser flushes its final audio chunk.
  }

  async start(language, deviceId = '', options = {}) {
    if (this.phase === 'recording') { this.stop(); return; }
    if (this.phase !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.hooks.onStatus('This browser cannot record audio here. Open the app in Chrome / Edge, or use Upload audio.', true);
      return;
    }
    this.cancel();
    const generation = this.generation;
    this.setPhase('requesting');
    this.hooks.onStatus('Waiting for microphone permission. Choose Allow in your browser.');
    this.hooks.onHelp(false);
    try {
      // An explicit device avoids a muted virtual/default communications input.
      // Leave processing settings to the device instead of forcing noise filters.
      let selectedId = deviceId;
      const chooseMic = async () => {
        if (!navigator.mediaDevices.enumerateDevices) return '';
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && !['default','communications',''].includes(d.deviceId));
        if (selectedId && inputs.some(d => d.deviceId === selectedId)) return selectedId;
        const physical = inputs.filter(d => !/camo|virtual|stereo mix|loopback|cable/i.test(d.label));
        return (physical.find(d => /headset|usb/i.test(d.label)) || physical.find(d => /realtek|microphone array|built.in|internal/i.test(d.label)))?.deviceId || selectedId;
      };
      try { selectedId = await chooseMic(); } catch (_) {}
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({audio: selectedId ? {deviceId: {exact: selectedId}} : true}); }
      catch (error) {
        if (error.name !== 'OverconstrainedError' || !navigator.mediaDevices.enumerateDevices) throw error;
        selectedId = ''; selectedId = await chooseMic();
        stream = await navigator.mediaDevices.getUserMedia({audio: selectedId ? {deviceId: {exact: selectedId}} : true});
      }
      // Device labels may become available only after microphone permission.
      if (!deviceId && !selectedId) {
        try {
          const physicalId = await chooseMic();
          if (physicalId && physicalId !== stream.getAudioTracks()[0]?.getSettings?.().deviceId) {
            const physicalStream = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: physicalId}}});
            stream.getTracks().forEach(track => track.stop()); stream = physicalStream;
          }
        } catch (_) { /* Keep the already-permitted microphone if switching fails. */ }
      }
      // A late permission decision must not reopen the mic after pause/end.
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      this.peakSignal = 0;
      this.stopReason = 'manual';
      this.detector = new SpeechEndDetector();
      this.autoStopAvailable = false;
      const activeTrack = stream.getAudioTracks()[0];
      this.hooks.onDevice?.(activeTrack?.label || 'Selected microphone', activeTrack?.getSettings?.().deviceId || selectedId);
      this.hooks.onDevicesChanged?.();
      const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
      this.recorder = recorder;
      const chunks = [];
      let bytes = 0;
      recorder.ondataavailable = event => {
        if (generation !== this.generation || !event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes > 8 * 1024 * 1024) {
          this.cancel();
          this.hooks.onStatus('That recording is too large. Try a shorter clip.', true);
        }
      };
      recorder.onerror = () => {
        if (generation !== this.generation) return;
        this.cancel();
        this.hooks.onStatus('Recording was interrupted. Check the microphone and try again.', true);
      };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.recorder = null;
        this.cleanupCapture();
        this.transcribe(new Blob(chunks, {type: recorder.mimeType || mime || 'audio/webm'}), language, generation,
          {reason: this.stopReason, autoShare: !!options.autoShare && this.stopReason === 'silence'});
      };
      stream.getAudioTracks().forEach(track => track.onended = () => this.stop('device-ended'));
      recorder.start(250);
      this.setPhase('recording');
      const started = Date.now();
      const tick = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        if (seconds >= 6 && this.audioContext?.state === 'running' && this.peakSignal < 0.0005) {
          this.cancel();
          this.hooks.onStatus('No microphone signal. In Devices, select your laptop / Realtek or headset microphone, unmute it, then press Speak.', true);
          return;
        }
        const signal = seconds >= 3 && this.audioContext?.state === 'running' && this.peakSignal < 0.0005 ?
          'No mic signal yet. Speak closer, check mute, or cancel and choose another microphone.' :
          this.autoStopAvailable ? (this.detector.heardSpeech ?
            'Listening. A 1.5-second quiet pause finishes your point.' :
            'Start speaking. Recording will stop after a 1.5-second quiet pause.') :
            'Press Stop & transcribe when finished. Automatic pause detection is unavailable in this browser.';
        this.hooks.onStatus(`Recording ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · ${signal}`);
      };
      this.monitorLevel(stream, generation);
      tick();
      this.clock = setInterval(tick, 500);
      this.limit = setTimeout(() => this.stop('limit'), 89500);
    } catch (error) {
      if (generation !== this.generation) return;
      this.cancel();
      const messages = {
        NotAllowedError: 'Microphone access is blocked. Open this page’s Site settings in Chrome / Edge, set Microphone to Allow, then reload. Also check Windows microphone access.',
        SecurityError: 'This browser blocks microphone access here. Open the local app in Chrome / Edge, or upload a recording.',
        NotFoundError: 'No microphone was found. Connect a microphone, or use Upload audio.',
        NotReadableError: 'The microphone is busy or unavailable. Close other apps using it and check Windows microphone access.',
        OverconstrainedError: 'The selected microphone is no longer available. Press Refresh list, choose your laptop or headset microphone, and try again.'
      };
      this.hooks.onStatus(messages[error.name] || 'Could not start recording. Check microphone permissions or upload an audio clip.', true);
      this.hooks.onHelp(['NotAllowedError', 'SecurityError'].includes(error.name));
    }
  }

  monitorLevel(stream, generation) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      this.audioContext = context;
      context.resume().catch(() => { this.autoStopAvailable = false; });
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const update = () => {
        if (generation !== this.generation || this.phase !== 'recording') return;
        analyser.getFloatTimeDomainData(buffer);
        const rms = Math.sqrt(buffer.reduce((sum, value) => sum + value**2, 0) / buffer.length);
        this.autoStopAvailable = context.state === 'running';
        this.peakSignal = Math.max(this.peakSignal || 0, rms);
        this.hooks.onLevel(Math.min(1, rms * 10));
        if (this.autoStopAvailable && this.detector.update(rms, performance.now())) {
          this.stop('silence');
          return;
        }
        this.frame = requestAnimationFrame(update);
      };
      update();
    } catch (_) { this.autoStopAvailable = false; /* Manual stop remains available. */ }
  }

  async upload(file, language) {
    if (!file || this.phase !== 'idle') return;
    this.cancel();
    await this.transcribe(file, language, this.generation);
  }

  async transcribe(blob, language, generation, completion = {}) {
    if (generation !== this.generation) return;
    this.hooks.onHelp(false);
    if (blob.size < 100 || blob.size > 8 * 1024 * 1024) {
      this.setPhase('idle');
      this.hooks.onStatus('Use a recording of at least one second, under 90 seconds and 8 MB.', true);
      return;
    }
    this.setPhase('transcribing');
    this.hooks.onStatus('Transcribing on the Python server… This can take a few seconds.');
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
    let transcript = null;
    try {
      const response = await fetch('api/transcribe', {
        method: 'POST', headers: {'Content-Type': blob.type || 'application/octet-stream',
          'X-GD-Arena': '1', 'X-Speech-Language': language}, body: blob, signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not transcribe this recording.');
      if (generation !== this.generation) return;
      transcript = typeof result.text === 'string' ? result.text.trim() : '';
      if (!transcript) throw new Error('No words were detected. Try speaking closer to the microphone.');
      this.hooks.onText(transcript, language);
      this.hooks.onStatus(language === 'hi-IN' ?
        'Transcript ready. Review it, write its English meaning below, and tick the review box.' :
        'Transcript ready. Review your words, then press Share your point.');
    } catch (error) {
      if (generation !== this.generation) return;
      this.hooks.onStatus(error.name === 'AbortError' ?
        'Transcription took too long. Try a shorter recording; your existing text is unchanged.' :
        error instanceof TypeError ? 'Could not reach the Python app. Restart the launcher and try again.' : error.message, true);
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.controller = null;
        this.setPhase('idle');
      }
    }
    // Submit only after idle restores the controls; cancellation invalidates this result.
    if (transcript && generation === this.generation) this.hooks.onReady?.(transcript, language, completion);
  }
}
window.LocalVoice = LocalVoice;

// One speaker at a time; every wait and microphone restart is cancellable.
class PartnerTurnFlow {
  constructor(hooks) { this.hooks = hooks; this.generation = 0; this.active = false; }
  cancel() {
    this.generation++;
    clearTimeout(this.restartTimer);
    this.hooks.cancelPlayback();
    this.active = false;
    this.hooks.onActive(false);
  }
  async run(replies, autoListen = false) {
    this.cancel();
    const generation = this.generation;
    const current = () => generation === this.generation && this.hooks.canContinue();
    this.active = true; this.hooks.onActive(true);
    let completed = false;
    try {
      for (const reply of replies) {
        if (!current()) return;
        this.hooks.onReply(reply);
        if (!await this.hooks.play(reply) || !current()) return;
      }
      completed = true;
    } finally {
      if (generation === this.generation) {
        this.active = false; this.hooks.onActive(false);
        if (completed && autoListen && current()) {
          // Let the speaker output settle before capturing the user's next turn.
          this.restartTimer = setTimeout(() => { if (current()) this.hooks.listen(); }, 400);
        }
      }
    }
  }
}
window.PartnerTurnFlow = PartnerTurnFlow;
