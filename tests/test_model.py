import json
import csv
import sys
import tempfile
import unittest
from pathlib import Path

import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from gd_model import LABELS, StanceFeatures, key, predict, read_gd, read_vast


class ModelChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = joblib.load(ROOT / 'artifacts' / 'stance_model.joblib')
        cls.gd = read_gd(ROOT / 'data' / 'gd_examples.csv')

    def test_ten_topics_three_classes(self):
        self.assertEqual(len(self.bundle['topics']), 10)
        self.assertEqual(set(self.bundle['classifier'].classes_), set(LABELS))
        for split, expected in [('train', 180), ('dev', 60), ('test', 60)]:
            self.assertEqual(len(self.gd[split]), expected)

    def test_vast_neutral_uses_actual_target_not_stale_new_topic(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            for split in ['train', 'dev', 'test']:
                with (folder / f'vast_{split}.csv').open('w', newline='', encoding='utf-8') as handle:
                    writer = csv.DictWriter(handle, fieldnames=['post', 'topic', 'new_topic', 'label', 'seen?'])
                    writer.writeheader()
                    if split == 'train':
                        for target, label in [(['remote', 'work'], '1'), (['school', 'uniforms'], '2')]:
                            writer.writerow({'post': 'Remote work saves commuting time.',
                                             'topic': json.dumps(target), 'new_topic': 'remote work',
                                             'label': label, 'seen?': '0'})
            rows, audit = read_vast(folder)
            self.assertEqual(len(rows['train']), 2)
            self.assertEqual(rows['train'][1]['topic'], 'school uniforms')
            self.assertEqual(rows['train'][1]['label'], 'neutral')
            self.assertNotIn('conflicting_pair', audit['train']['removed'])

    def test_document_and_family_isolation(self):
        for left, right in [('train', 'dev'), ('train', 'test'), ('dev', 'test')]:
            for field in ['text', 'group']:
                a = {key(r[field]) for r in self.gd[left]}
                b = {key(r[field]) for r in self.gd[right]}
                self.assertFalse(a & b)

    def test_target_changes_features(self):
        rows = [{'text': 'Home working saves travel time.', 'topic': 'working from home'},
                {'text': 'Home working saves travel time.', 'topic': 'classroom education'}]
        x = self.bundle['features'].transform(rows)
        self.assertGreater((x[0] - x[1]).nnz, 0)

    def test_heldout_vocabulary_is_not_fitted(self):
        rows = [{'topic': 'remote work', 'text': 'Remote workers save commuting time.'},
                {'topic': 'remote work', 'text': 'Workers need commuting time for office work.'},
                {'topic': 'remote work', 'text': 'Remote work helps workers save time.'}]
        features = StanceFeatures().fit(rows)
        features.transform([{'topic': 'remote work', 'text': 'quasarholdouttoken appears only in heldout text.'}])
        self.assertNotIn('quasarholdouttoken', features.arguments_.vocabulary_)

    def test_saved_model_roundtrip(self):
        text = 'Working from home saves commuting time and allows focused work.'
        before = predict(self.bundle, text, topic_id='remote_work')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'copy.joblib'
            joblib.dump(self.bundle, path)
            after = predict(joblib.load(path), text, topic_id='remote_work')
        self.assertEqual(before, after)

    def test_invalid_inputs(self):
        for text in ['', 'hello', None, 'a' * 5001]:
            with self.assertRaises(ValueError):
                predict(self.bundle, text, topic_id='remote_work')
        with self.assertRaises(ValueError):
            predict(self.bundle, 'This is a valid argument.', topic_id='missing')
        with self.assertRaises(ValueError):
            predict(self.bundle, 'This is a valid argument.')

    def test_prediction_schema_all_topics(self):
        for topic in self.bundle['topics']:
            output = predict(self.bundle, 'I would like to understand the issue before taking a position.', topic_id=topic['id'])
            self.assertIn(output['stance'], LABELS)
            self.assertEqual(set(output['decision_scores']), set(LABELS))
            self.assertTrue(all(np.isfinite(v) for v in output['decision_scores'].values()))

    def test_metrics_match_saved_model(self):
        report = json.loads((ROOT / 'artifacts' / 'metrics.json').read_text())
        self.assertEqual(report, self.bundle['report'])
        expected = max(['Logistic Regression', 'Linear SVM'],
                       key=lambda n: report['validation'][n]['selection_score'])
        self.assertEqual(expected, report['selected_model'])
        for dataset in ['vast', 'gd']:
            cm = np.array(report['test'][dataset]['confusion_matrix'])
            self.assertEqual(int(cm.sum()), report['test'][dataset]['n'])
            self.assertAlmostEqual(float(np.trace(cm) / cm.sum()), report['test'][dataset]['accuracy'])


if __name__ == '__main__':
    unittest.main()
