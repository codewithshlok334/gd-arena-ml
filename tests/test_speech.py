import io
from pathlib import Path
import sys
import unittest
import wave
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from speech import SpeechService, SpeechUnavailable


def audio_wave(seconds=1, silent=False):
    values=np.zeros(int(seconds*16000),dtype=np.int16) if silent else (
        np.sin(np.arange(int(seconds*16000))*2*np.pi*440/16000)*4000).astype(np.int16)
    output=io.BytesIO()
    with wave.open(output,'wb') as handle:
        handle.setnchannels(1);handle.setsampwidth(2);handle.setframerate(16000)
        handle.writeframes(values.tobytes())
    return output.getvalue()


class SpeechValidationTests(unittest.TestCase):
    def test_real_wav_decode(self):
        samples=SpeechService.decode(audio_wave())
        self.assertEqual(len(samples),16000)
        self.assertGreater(float(np.max(samples)),0.1)

    def test_silence_rejected(self):
        with self.assertRaisesRegex(ValueError,'No microphone signal'):
            SpeechService.decode(audio_wave(silent=True))

    def test_invalid_media_and_size(self):
        for data in [b'not audio', b'', b'x'*(8*1024*1024+1)]:
            with self.assertRaises(ValueError):
                SpeechService.decode(data)

    def test_duration_limit(self):
        with self.assertRaisesRegex(ValueError,'90 seconds'):
            SpeechService.decode(audio_wave(seconds=91))

    def test_missing_engine_and_invalid_language(self):
        service=SpeechService.__new__(SpeechService)
        service.state='setup_required';service.message='Please run setup.'
        with self.assertRaises(SpeechUnavailable):
            service.transcribe(b'not used','en-IN')
        with self.assertRaisesRegex(ValueError,'English or Hindi'):
            service.transcribe(b'not used','invalid-language')


if __name__=='__main__':unittest.main()
