"""Local, pretrained Whisper speech recognition. Audio is never written to disk."""
from io import BytesIO
from pathlib import Path
import os
import threading
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent / '.runtime' / 'whisper-tiny'
MODEL_REPO = 'Systran/faster-whisper-tiny'
MODEL_REVISION = 'd90ca5fe260221311c53c58e660288d3deb8d356'
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 90


class SpeechUnavailable(RuntimeError):
    pass


class SpeechService:
    def __init__(self):
        self.model = None
        self.state = 'loading'
        self.message = 'Preparing local speech recognition…'
        self.lock = threading.Lock()
        if not (MODEL_DIR / 'model.bin').is_file():
            self.state = 'setup_required'
            self.message = 'Local voice needs setup. Run the project launcher, or python setup_voice.py, then restart the app.'
        else:
            threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            from faster_whisper import WhisperModel
            threads = max(1, min(4, int(os.environ.get('GD_SPEECH_THREADS', '4'))))
            self.model = WhisperModel(str(MODEL_DIR), device='cpu', compute_type='int8',
                                      cpu_threads=threads, num_workers=1, local_files_only=True)
            self.state = 'ready'
            self.message = 'Voice ready. Press Speak to start.'
        except Exception:
            self.state = 'unavailable'
            self.message = 'Local voice could not load. Run the launcher to install speech libraries, then restart the app.'

    def status(self):
        return {'state': self.state, 'ready': self.state == 'ready', 'message': self.message,
                'engine': 'Pretrained Whisper tiny / faster-whisper, CPU',
                'processing': 'Audio is processed on the Python server and is not saved.',
                'max_seconds': MAX_SECONDS, 'max_bytes': MAX_AUDIO_BYTES}

    @staticmethod
    def decode(data):
        """Decode browser WebM/Ogg/MP4 or an uploaded WAV, with a duration bound."""
        if not data or len(data) > MAX_AUDIO_BYTES:
            raise ValueError('Record a short clip, up to 90 seconds and 8 MB.')
        import av
        chunks, count = [], 0
        try:
            with av.open(BytesIO(data)) as container:
                resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
                for frame in container.decode(audio=0):
                    for sampled in resampler.resample(frame):
                        values = sampled.to_ndarray().reshape(-1)
                        count += values.size
                        if count > MAX_SECONDS * 16000:
                            raise ValueError('Keep each recording under 90 seconds.')
                        chunks.append(values)
                for sampled in resampler.resample(None):
                    values = sampled.to_ndarray().reshape(-1)
                    count += values.size
                    if count > MAX_SECONDS * 16000:
                        raise ValueError('Keep each recording under 90 seconds.')
                    chunks.append(values)
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError('This audio could not be read. Record again or use a WAV, MP3, WebM, Ogg or M4A file.') from exc
        if count < 4000:
            raise ValueError('The clip is too short. Speak for at least one second.')
        audio = np.concatenate(chunks).astype(np.float32) / 32768.0
        if float(np.sqrt(np.mean(audio ** 2))) < 0.0005:
            raise ValueError('No microphone signal was captured. Choose a different microphone above, check its mute switch, then record 5 seconds. If this continues in the in-app browser, open the app in Chrome or Edge.')
        return audio

    def transcribe(self, data, language):
        if language not in {'en-IN', 'en-US', 'hi-IN'}:
            raise ValueError('Choose English or Hindi / Hinglish.')
        if self.state != 'ready':
            raise SpeechUnavailable(self.message)
        if not self.lock.acquire(blocking=False):
            raise SpeechUnavailable('Another clip is being transcribed. Try again in a moment.')
        try:
            audio = self.decode(data)
            # English discussion needs text only. Avoid beam search, timestamp
            # prediction and repeated temperature retries on the small CPU host.
            options = ({'beam_size': 1, 'best_of': 1, 'temperature': 0.0,
                        'without_timestamps': True} if language != 'hi-IN' else {'beam_size': 3})
            segments, info = self.model.transcribe(
                audio, language='hi' if language == 'hi-IN' else 'en', task='transcribe',
                **options, condition_on_previous_text=False, vad_filter=True,
                vad_parameters={'min_silence_duration_ms': 500},
                no_speech_threshold=0.6)
            text = ' '.join(segment.text.strip() for segment in segments).strip()
            if not text:
                raise ValueError('No clear speech was detected. Move closer to the microphone and try again.')
            return {'text': text[:5000], 'language': info.language, 'duration': round(len(audio)/16000, 2),
                    'engine': 'Pretrained Whisper tiny', 'review_required': True}
        finally:
            self.lock.release()
