"""Integration checks against the actual saved classifier and local HTTP API."""
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import ArenaService, make_handler
from gd_model import predict


class ArenaIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = ArenaService()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(cls.service))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def payload(self, **extra):
        return {'topic_id': 'remote_work', 'text': 'Working from home can save commuting time.', **extra}

    def test_predictions_are_from_saved_model(self):
        data = self.payload()
        result = self.service.turn(data)
        expected = predict(self.service.bundle, data['text'], topic_id=data['topic_id'])
        self.assertEqual(result['analysis'], expected)
        self.assertTrue(result['reply']['prepared'])

    def test_all_topics_and_partner_roles(self):
        self.assertEqual(len(self.service.info()['topics']), 10)
        for item in self.service.topics:
            for turn, role in enumerate(['support', 'oppose', 'neutral']):
                response = self.service.turn(self.payload(topic_id=item['id'], turn_number=turn))
                self.assertEqual(response['reply']['stance'], role)
                point = next(p for p in self.service.points if p['id'] == response['reply']['point_id'])
                self.assertEqual(point['topic_id'], item['id'])
                self.assertEqual(point['split'], 'train')
                self.assertEqual(point['label'], role)

    def test_does_not_repeat_points_until_exhausted(self):
        used = []
        for _ in range(6):
            point = self.service.turn(self.payload(used_points=used))['reply']['point_id']
            self.assertNotIn(point, used)
            used.append(point)
        self.assertIsNone(self.service.turn(self.payload(used_points=used))['reply']['point_id'])

    def test_invalid_inputs(self):
        for payload in [[], self.payload(text='yes'), self.payload(text='x'*5001),
                        self.payload(topic_id='missing'), self.payload(text='यह मेरा विचार है'),
                        self.payload(turn_number=-1), self.payload(turn_number=True),
                        self.payload(used_points='not-a-list')]:
            with self.subTest(payload=str(payload)[:100]), self.assertRaises(ValueError):
                self.service.turn(payload)

    def test_http_end_to_end(self):
        request = urllib.request.Request(self.url+'/api/turn', data=json.dumps(self.payload()).encode(),
                    headers={'Content-Type':'application/json', 'X-GD-Arena':'1'})
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        self.assertIn(result['analysis']['stance'], ['support','oppose','neutral'])
        self.assertEqual(result['reply']['name'], 'Aanya')

    def test_static_files_and_health(self):
        for path in ['/', '/app.js', '/styles.css', '/meeting.css', '/camera.js', '/voice.js', '/favicon.svg']:
            with urllib.request.urlopen(self.url+path) as response:
                self.assertGreater(len(response.read()), 100)
        with urllib.request.urlopen(self.url+'/api/health') as response:
            self.assertEqual(json.load(response)['app'], 'GD Arena')
        for path in ['/../app.py','/artifacts/stance_model.joblib']:
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(self.url+path)
            self.assertEqual(context.exception.code, 404)

    def test_cross_origin_plain_form_blocked(self):
        request = urllib.request.Request(self.url+'/api/turn', data=b'text=hello')
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(request)
        self.assertEqual(context.exception.code,415)

    def test_audio_endpoint_routes_raw_bytes_and_language(self):
        request=urllib.request.Request(self.url+'/api/transcribe',data=b'audio-test-bytes',headers={
            'Content-Type':'audio/webm','X-GD-Arena':'1','X-Speech-Language':'hi-IN'})
        with patch.object(self.service.speech,'transcribe',return_value={'text':'sample'}) as transcribe:
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)['text'],'sample')
            transcribe.assert_called_once_with(b'audio-test-bytes','hi-IN')
        blocked=urllib.request.Request(self.url+'/api/transcribe',data=b'audio-test-bytes')
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(blocked)
        self.assertEqual(context.exception.code,415)


if __name__ == '__main__':
    unittest.main()
