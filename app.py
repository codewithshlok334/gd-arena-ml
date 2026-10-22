"""GD Arena frontend + local Python ML API. Run: python app.py

The trained model predicts stance. Practice partner replies are retrieved from
prepared TRAINING examples; no generative AI service or API key is used.
"""
from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import joblib
import numpy as np

from gd_model import predict
from speech import SpeechService, SpeechUnavailable, MAX_AUDIO_BYTES

ROOT = Path(__file__).resolve().parent
PARTNERS = [
    {'id': 'aanya', 'name': 'Aanya', 'role': 'Builds the case', 'stance': 'support'},
    {'id': 'kabir', 'name': 'Kabir', 'role': 'Challenges assumptions', 'stance': 'oppose'},
    {'id': 'riya', 'name': 'Riya', 'role': 'Asks for clarity', 'stance': 'neutral'},
]


class ArenaService:
    def __init__(self, model_path=None):
        self.bundle = joblib.load(model_path or ROOT / 'artifacts' / 'stance_model.joblib')
        self.topics = self.bundle['topics']
        self.topic_ids = {t['id'] for t in self.topics}
        with (ROOT / 'data' / 'gd_examples.csv').open(encoding='utf-8', newline='') as handle:
            self.points = [row for row in csv.DictReader(handle) if row['split'] == 'train']
        self.point_vectors = self.bundle['features'].arguments_.transform([p['text'] for p in self.points])
        self.speech = SpeechService()

    def info(self):
        report = self.bundle['report']
        return {'topics': self.topics, 'partners': PARTNERS, 'speech': self.speech.status(),
                'model': {'name': self.bundle['model_name'], 'language': 'English',
                          'public_accuracy': report['test']['vast']['accuracy'],
                          'public_macro_f1': report['test']['vast']['macro_f1'],
                          'status': 'Experimental baseline',
                          'reply_mode': 'Prepared topic perspectives; relevance-ranked using TF-IDF.'}}

    def turn(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('Send a JSON object.')
        topic_id, text = payload.get('topic_id'), payload.get('text')
        if not isinstance(topic_id, str) or topic_id not in self.topic_ids:
            raise ValueError('Choose one of the ten available topics.')
        if not isinstance(text, str) or len(text.strip().split()) < 3 or len(text) > 5000:
            raise ValueError('Use an English argument of 3 words or more, up to 5,000 characters.')
        if re.search(r'[\u0900-\u097f]', text):
            raise ValueError('Please write the English meaning of your transcript before model analysis.')
        used = payload.get('used_points', [])
        turn_number = payload.get('turn_number', 0)
        reply_count = payload.get('reply_count', 1)
        if not isinstance(used, list) or len(used) > 100 or not all(isinstance(x, str) for x in used):
            raise ValueError('Invalid discussion history. Start a fresh session.')
        if type(turn_number) is not int or not 0 <= turn_number <= 1000:
            raise ValueError('Invalid turn number.')
        if type(reply_count) is not int or reply_count not in {1, 3}:
            raise ValueError('Choose one partner or a three-partner round.')
        analysis = predict(self.bundle, text.strip(), topic_id=topic_id)
        partners = PARTNERS if reply_count == 3 else [PARTNERS[turn_number % len(PARTNERS)]]
        replies = [self.reply_for(partner, topic_id, text, used) for partner in partners]
        count = len(text.split())
        has_example = bool(re.search(r'\b(for example|for instance|such as|because|consider)\b', text, re.I))
        tip = ('Try adding one concrete example to support your point.' if not has_example else
               'Next, acknowledge a trade-off or respond to another perspective.')
        if count < 15:
            tip = 'Build on your opening with a reason and one concrete example.'
        return {'analysis': analysis, 'reply': replies[0], 'replies': replies, 'word_count': count,
                'coach_note': tip, 'coach_note_type': 'Simple writing prompt, not an ML quality score.'}

    def reply_for(self, partner, topic_id, text, used):
        candidates = [i for i, row in enumerate(self.points)
                      if row['topic_id'] == topic_id and row['label'] == partner['stance'] and row['id'] not in used]
        if candidates:
            vector = self.bundle['features'].arguments_.transform([text])
            similarities = (self.point_vectors[candidates] @ vector.T).toarray().ravel()
            choice = candidates[int(np.argmax(similarities))]
            row = self.points[choice]
            lead = {'support': 'One point in favor: ', 'oppose': 'A different perspective: ',
                    'neutral': 'Let us clarify one thing. '}[partner['stance']]
            reply = {'id': row['id'], 'text': lead + row['text'], 'prepared': True, **partner}
            # Keep the point ID separate from the stable participant ID.
            reply['point_id'] = row['id']
        else:
            reply = {**partner, 'point_id': None, 'prepared': True,
                     'text': 'We have explored several perspectives. Can you summarize the strongest point on each side and explain your conclusion?'}
        return reply


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Do not log participants' arguments or transcripts.
            pass

        def respond(self, code, body, mime='application/json; charset=utf-8'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
            elif isinstance(body, str):
                body = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # The user cancelled or ended the session.

        def do_GET(self):
            path = urlparse(self.path).path
            if path == '/api/health':
                return self.respond(200, {'ok': True, 'app': 'GD Arena', 'model_loaded': True})
            if path == '/api/topics':
                return self.respond(200, service.info())
            if path == '/api/speech':
                return self.respond(200, service.speech.status())
            files = {'/': 'index.html', '/index.html': 'index.html',
                     '/styles.css': 'styles.css', '/app.js': 'app.js', '/camera.js': 'camera.js', '/meeting.css': 'meeting.css', '/voice.js': 'voice.js', '/favicon.svg': 'favicon.svg'}
            if path not in files:
                return self.respond(404, {'error': 'Not found.'})
            filename = ROOT / 'web' / files[path]
            mime = mimetypes.guess_type(str(filename))[0] or 'application/octet-stream'
            if filename.suffix == '.js':
                mime = 'application/javascript'
            return self.respond(200, filename.read_bytes(), mime + '; charset=utf-8')

        def do_POST(self):
            if urlparse(self.path).path == '/api/transcribe':
                if self.headers.get('X-GD-Arena') != '1':
                    return self.respond(415, {'error': 'Use the GD Arena microphone or audio upload control.'})
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= MAX_AUDIO_BYTES:
                        return self.respond(413, {'error': 'Use an audio clip under 8 MB and 90 seconds.'})
                    result = service.speech.transcribe(self.rfile.read(size), self.headers.get('X-Speech-Language', 'en-IN'))
                except SpeechUnavailable as exc:
                    return self.respond(503, {'error': str(exc)})
                except (ValueError, UnicodeDecodeError) as exc:
                    return self.respond(400, {'error': str(exc)})
                except Exception:
                    return self.respond(500, {'error': 'Speech transcription failed. Your text is unchanged; try a shorter recording.'})
                return self.respond(200, result)
            if urlparse(self.path).path != '/api/turn':
                return self.respond(404, {'error': 'Not found.'})
            if self.headers.get('X-GD-Arena') != '1' or not self.headers.get('Content-Type', '').startswith('application/json'):
                return self.respond(415, {'error': 'Use the GD Arena interface to submit an argument.'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size <= 0 or size > 24000:
                    return self.respond(413, {'error': 'This argument is too large.'})
                payload = json.loads(self.rfile.read(size))
                result = service.turn(payload)
            except (ValueError, UnicodeDecodeError) as error:
                return self.respond(400, {'error': str(error)})
            except Exception:
                return self.respond(500, {'error': 'The model could not process this argument. Try again.'})
            self.respond(200, result)

    return Handler


def create_server(port=7860, host='127.0.0.1'):
    service = ArenaService()
    return ThreadingHTTPServer((host, port), make_handler(service))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7860)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    server = create_server(args.port, args.host)
    print(f'GD Arena ready: http://{args.host}:{server.server_port}', flush=True)
    print('Open this address in Chrome or Edge for browser voice features. Ctrl+C stops the app.', flush=True)
    if args.open_browser:
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{server.server_port}/')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
