"""GD Arena: reproducible, CPU-based, topic-conditioned stance classification.

Run: python gd_model.py train --data-dir data/vast --output-dir artifacts
No LLM, paid API, GPU or pretrained language model is used.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import time
import warnings
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import joblib
import numpy as np
import scipy
import sklearn
from scipy.sparse import hstack
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.multiclass import OneVsRestClassifier
from sklearn.preprocessing import normalize
from sklearn.svm import LinearSVC
from threadpoolctl import threadpool_limits

LABELS = ['oppose', 'support', 'neutral']
LABEL_MAP = {'0': 'oppose', '1': 'support', '2': 'neutral'}
SEED = 42
BASE = Path(__file__).resolve().parent
REVISION = 'e7c4775182b184730f350995f8260579c9e066fe'
CHECKSUMS = {
    'vast_train.csv': 'b2f0d69a73231b8ef22f10e4df7d759cf228505ce5252506068da6aa7fe42109',
    'vast_dev.csv': 'ea6f4c4aa7d35c1f961a7e041099b7e8a7420cdb1199b96b8f4f1d0e7d01d02c',
    'vast_test.csv': '32931d3390c5bf71fcfbb98e517ae38a11388d4258afbb5b0d612a6211335cec',
}


def clean(text):
    """Normalize formatting, retaining negation, punctuation and sentence meaning."""
    return re.sub(r'\s+', ' ', html.unescape(str(text))).strip()


def key(text):
    return re.sub(r'[^a-z0-9]+', ' ', clean(text).lower()).strip()


def download_vast(data_dir):
    """Download the authors' pinned release; validate every cached/downloaded file."""
    folder = Path(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    for filename, expected in CHECKSUMS.items():
        path = folder / filename
        if not path.exists():
            url = f'https://raw.githubusercontent.com/emilyallaway/zero-shot-stance/{REVISION}/data/VAST/{filename}'
            request = Request(url, headers={'User-Agent': 'GD-Arena-Educational-Project'})
            with urlopen(request, timeout=120) as response:
                payload = response.read()
            if hashlib.sha256(payload).hexdigest() != expected:
                raise ValueError(f'Checksum mismatch for downloaded {filename}')
            temp = path.with_suffix('.tmp')
            temp.write_bytes(payload)
            temp.replace(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'{filename} has changed. Use the pinned original data.')
    return folder


def read_vast(data_dir):
    """Keep original posts; upstream preprocessed text removes useful negations."""
    splits, audit = {}, {}
    previous_documents = set()
    for split in ['train', 'dev', 'test']:
        with (Path(data_dir) / f'vast_{split}.csv').open(encoding='utf-8', newline='') as handle:
            raw = list(csv.DictReader(handle))
        records, rejected, labels_by_pair = [], Counter(), {}
        for index, row in enumerate(raw):
            # VAST neutral examples may retain a stale `new_topic` field.
            # The authors' loader uses the JSON `topic` tokens as the true target.
            # Using new_topic would pair neutral labels with the wrong target.
            target_tokens = json.loads(row.get('topic', '[]'))
            if not isinstance(target_tokens, list) or not all(isinstance(t, str) for t in target_tokens):
                raise ValueError('Invalid VAST target token list')
            text, topic = clean(row.get('post', '')), clean(' '.join(target_tokens))
            label = LABEL_MAP.get(row.get('label', ''))
            if not text or not topic or label is None:
                rejected['invalid'] += 1
                continue
            pair = (key(text), key(topic))
            labels_by_pair.setdefault(pair, set()).add(label)
            records.append({'id': f'vast-{split}-{index}', 'text': text, 'topic': topic,
                            'label': label, 'source': 'VAST', 'group': key(text),
                            'official_seen': row.get('seen?', '')})
        used_pairs, accepted = set(), []
        for row in records:
            pair = (key(row['text']), key(row['topic']))
            if len(labels_by_pair[pair]) > 1:
                rejected['conflicting_pair'] += 1
            elif pair in used_pairs:
                rejected['duplicate_pair'] += 1
            elif row['group'] in previous_documents:
                rejected['document_in_earlier_split'] += 1
            else:
                accepted.append(row)
                used_pairs.add(pair)
        previous_documents.update(r['group'] for r in accepted)
        splits[split] = accepted
        audit[split] = {'original_rows': len(raw), 'used_rows': len(accepted),
                        'removed': dict(rejected),
                        'class_counts': dict(Counter(r['label'] for r in accepted)),
                        'unique_targets': len({key(r['topic']) for r in accepted}),
                        'unique_documents': len({r['group'] for r in accepted})}
    return splits, audit


def read_gd(path):
    """Read explicitly authored examples with immutable argument-family splits."""
    with Path(path).open(encoding='utf-8', newline='') as handle:
        rows = list(csv.DictReader(handle))
    splits = {s: [] for s in ['train', 'dev', 'test']}
    groups, documents = {}, {}
    for row in rows:
        split = row['split']
        if split not in splits or row['label'] not in LABELS:
            raise ValueError('Invalid split/label in GD data')
        if not row['text'].strip() or not row['topic'].strip():
            raise ValueError('Empty GD text or topic')
        group = row['group_id']
        doc = key(row['text'])
        if group in groups and groups[group] != split:
            raise ValueError('Argument family leaked across GD splits')
        if doc in documents and documents[doc] != split:
            raise ValueError('Duplicate GD text leaked across splits')
        groups[group], documents[doc] = split, split
        splits[split].append({**row, 'group': group, 'source': 'assistant_authored_synthetic'})
    return splits


def pair_terms(row):
    """Topic x argument lexical interactions; no labels or handcrafted stance rules."""
    topics = sorted(set(re.findall(r'[a-z]{3,}', row['topic'].lower())) - ENGLISH_STOP_WORDS)
    words = list(dict.fromkeys(re.findall(r'[a-z]{3,}', row['text'].lower())))[:100]
    return ' '.join(f'{t}__{w}' for t in topics[:12] for w in words if w not in ENGLISH_STOP_WORDS)


class StanceFeatures(BaseEstimator, TransformerMixin):
    """Fit all vocabularies/IDF on training examples only."""
    def fit(self, rows, y=None):
        self.arguments_ = TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_features=30000,
                                         sublinear_tf=True, strip_accents='unicode', dtype=np.float32)
        self.targets_ = TfidfVectorizer(ngram_range=(1, 2), max_features=6000,
                                       sublinear_tf=True, strip_accents='unicode', dtype=np.float32)
        self.characters_ = TfidfVectorizer(analyzer='char_wb', ngram_range=(3, 5),
                                           min_df=3, max_features=20000, sublinear_tf=True,
                                           dtype=np.float32)
        self.pairs_ = TfidfVectorizer(token_pattern=r'(?u)\b\w+\b', min_df=3,
                                     max_features=40000, sublinear_tf=True, dtype=np.float32)
        self.arguments_.fit([r['text'] for r in rows])
        self.targets_.fit([r['topic'] for r in rows])
        self.characters_.fit([r['text'] for r in rows])
        self.pairs_.fit([pair_terms(r) for r in rows])
        return self

    def transform(self, rows):
        texts, topics = [r['text'] for r in rows], [r['topic'] for r in rows]
        matrix = hstack([self.arguments_.transform(texts),
                         self.targets_.transform(topics) * 0.5,
                         self.characters_.transform(texts) * 0.5,
                         self.pairs_.transform([pair_terms(r) for r in rows])], format='csr')
        return normalize(matrix, copy=False)


def evaluate(gold, predicted):
    return {'n': len(gold), 'accuracy': float(accuracy_score(gold, predicted)),
            'macro_f1': float(f1_score(gold, predicted, labels=LABELS, average='macro', zero_division=0)),
            'per_class': classification_report(gold, predicted, labels=LABELS, output_dict=True, zero_division=0),
            'confusion_matrix': confusion_matrix(gold, predicted, labels=LABELS).tolist(),
            'confusion_order': LABELS}


def make_plots(report, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'figure.facecolor': '#f8fafc',
                         'axes.facecolor': '#ffffff', 'axes.spines.top': False, 'axes.spines.right': False})
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), constrained_layout=True)
    for ax, dataset, title in zip(axes, ['vast', 'gd'], ['Public VAST test set', 'Authored GD test examples']):
        metrics = report['test'][dataset]
        cm = np.array(metrics['confusion_matrix'])
        ax.imshow(cm, cmap='Blues')
        for i in range(3):
            for j in range(3):
                ax.text(j, i, str(cm[i, j]), ha='center', va='center',
                        color='white' if cm[i, j] > cm.max() / 2 else '#16324f', fontsize=13)
        ax.set(xticks=range(3), yticks=range(3), xticklabels=LABELS, yticklabels=LABELS,
               xlabel='Predicted stance', ylabel='Actual stance',
               title=f'{title}\nn={metrics["n"]:,} | macro F1={metrics["macro_f1"]:.3f}')
    fig.suptitle('GD Arena | Held-out evaluation', fontweight='bold', fontsize=16)
    fig.savefig(output / 'confusion_matrices.png', dpi=180)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(9, 4.8), constrained_layout=True)
    names = list(report['validation'])
    x = np.arange(len(names))
    ax.bar(x - .18, [report['validation'][n]['vast']['macro_f1'] for n in names], .36,
           color='#245dd3', label='Public VAST dev')
    ax.bar(x + .18, [report['validation'][n]['gd']['macro_f1'] for n in names], .36,
           color='#19a99c', label='Authored GD dev')
    ax.set(xticks=x, xticklabels=names, ylim=(0, 1), ylabel='Macro F1',
           title='Model selection uses validation data only')
    ax.legend()
    fig.savefig(output / 'model_comparison.png', dpi=180)
    plt.close(fig)


def train(data_dir, gd_path, output_dir):
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    vast, audit = read_vast(download_vast(data_dir))
    gd = read_gd(gd_path)
    training = vast['train'] + gd['train']
    for left, right in [('train', 'dev'), ('train', 'test'), ('dev', 'test')]:
        assert not ({key(r['text']) for r in vast[left] + gd[left]} &
                    {key(r['text']) for r in vast[right] + gd[right]}), 'Cross-split document leakage'
    print('Fitting TF-IDF features on training data only...', flush=True)
    started = time.monotonic()
    features = StanceFeatures().fit(training)
    x_train = features.transform(training)
    y_train = np.array([r['label'] for r in training])
    dev_x = {name: features.transform(rows['dev']) for name, rows in [('vast', vast), ('gd', gd)]}
    dev_y = {name: [r['label'] for r in rows['dev']] for name, rows in [('vast', vast), ('gd', gd)]}
    # Fixed BEFORE evaluation: modest emphasis on the small domain-adaptation set.
    sample_weights = np.array([1.0] * len(vast['train']) + [8.0] * len(gd['train']))
    with sklearn.config_context(enable_metadata_routing=True):
        logistic = OneVsRestClassifier(LogisticRegression(
            C=4.0, solver='liblinear', max_iter=1000, tol=0.002,
            random_state=SEED).set_fit_request(sample_weight=True))
    candidates = {
        'Majority baseline': DummyClassifier(strategy='most_frequent'),
        'Logistic Regression': logistic,
        'Linear SVM': LinearSVC(C=0.5, max_iter=5000, random_state=SEED, dual='auto'),
    }
    validation, fitted, training_warnings = {}, {}, {}
    for name, classifier in candidates.items():
        print(f'Training {name}...', flush=True)
        with warnings.catch_warnings(record=True) as caught, threadpool_limits(limits=2), sklearn.config_context(enable_metadata_routing=True):
            warnings.simplefilter('always')
            classifier.fit(x_train, y_train, sample_weight=sample_weights)
        training_warnings[name] = [str(w.message) for w in caught]
        fitted[name] = classifier
        validation[name] = {d: evaluate(dev_y[d], classifier.predict(dev_x[d])) for d in dev_x}
        validation[name]['selection_score'] = (validation[name]['vast']['macro_f1'] + validation[name]['gd']['macro_f1']) / 2
        print(name, 'VAST dev F1:', round(validation[name]['vast']['macro_f1'], 4),
              'GD dev F1:', round(validation[name]['gd']['macro_f1'], 4), flush=True)
    learned = ['Logistic Regression', 'Linear SVM']
    best_name = max(learned, key=lambda name: validation[name]['selection_score'])
    classifier = fitted[best_name]
    print(f'Selected on dev data: {best_name}. Evaluating test sets once.', flush=True)
    tests, test_predictions = {}, {}
    for name, rows in [('vast', vast['test']), ('gd', gd['test'])]:
        predicted = classifier.predict(features.transform(rows))
        test_predictions[name] = predicted
        tests[name] = evaluate([r['label'] for r in rows], predicted)
        # Export IDs and labels, not the third-party comment text.
        with (output / f'{name}_test_predictions.csv').open('w', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['id', 'actual', 'predicted', 'correct'])
            writer.writerows((r['id'], r['label'], str(p), r['label'] == p) for r, p in zip(rows, predicted))
    train_targets = {key(r['topic']) for r in training}
    unseen = [i for i, r in enumerate(vast['test']) if key(r['topic']) not in train_targets]
    if unseen:
        tests['vast_unseen_target_strings'] = evaluate([vast['test'][i]['label'] for i in unseen],
                                                        [test_predictions['vast'][i] for i in unseen])
    tests['gd_per_topic'] = {}
    for topic_id in sorted({r['topic_id'] for r in gd['test']}):
        indices = [i for i, r in enumerate(gd['test']) if r['topic_id'] == topic_id]
        tests['gd_per_topic'][topic_id] = evaluate([gd['test'][i]['label'] for i in indices],
                                                   [test_predictions['gd'][i] for i in indices])
    report = {
        'created_utc': datetime.now(timezone.utc).isoformat(), 'seed': SEED,
        'selected_model': best_name, 'training_seconds': round(time.monotonic() - started, 2),
        'dataset_revision': REVISION, 'data_audit': audit,
        'dataset_fields': {'argument': 'post', 'target': 'JSON topic tokens joined by spaces',
                           'label': 'label; 0=oppose, 1=support, 2=neutral'},
        'gd_counts': {s: len(gd[s]) for s in gd},
        'gd_sha256': hashlib.sha256(Path(gd_path).read_bytes()).hexdigest(),
        'feature_count': int(x_train.shape[1]), 'training_rows': len(training),
        'selection_rule': 'Mean of VAST dev macro F1 and authored GD dev macro F1; test data never used for selection.',
        'source_weights': {'VAST': 1.0, 'assistant_authored_synthetic': 8.0},
        'validation': validation, 'test': tests, 'warnings': training_warnings,
        'versions': {'python': __import__('platform').python_version(), 'numpy': np.__version__,
                     'scipy': scipy.__version__, 'scikit-learn': sklearn.__version__, 'joblib': joblib.__version__},
        'limitations': [
            'Experimental educational baseline; predictions may be wrong, including on simple arguments.',
            'GD examples and labels were authored by the assistant, not collected from real users or independently annotated.',
            'Authored GD test scores are a small development check, not evidence of real-world interview performance.',
            'English only. Hindi/Hinglish, voice recognition, translation and conversational turn generation are not trained here.',
            'Neutral means no clear stance towards the target; it does not mean low confidence.',
            'Raw decision scores are uncalibrated model scores, not probabilities or argument-quality scores.',
            'Bag-of-words features cannot reliably understand sarcasm, implication, long context or arbitrary reversed propositions.',
            'Unseen-target reporting uses exact normalized target strings, not semantic topic equivalence.',
            'VAST cleaning modifies the published evaluation set; metrics are not directly comparable with paper results.'
        ]}
    (output / 'metrics.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    bundle = {'features': features, 'classifier': classifier, 'model_name': best_name,
              'report': report, 'topics': json.loads((BASE / 'topics.json').read_text(encoding='utf-8'))}
    joblib.dump(bundle, output / 'stance_model.joblib', compress=3)
    make_plots(report, output)
    print(json.dumps({n: {'accuracy': tests[n]['accuracy'], 'macro_f1': tests[n]['macro_f1'], 'n': tests[n]['n']}
                      for n in ['vast', 'gd']}, indent=2), flush=True)
    return bundle, report


def predict(bundle, text, topic_id=None, target=None):
    if not isinstance(text, str) or len(text.strip().split()) < 3:
        raise ValueError('Enter an English argument of at least three words.')
    if len(text) > 5000:
        raise ValueError('Use at most 5,000 characters per argument.')
    if topic_id is not None:
        match = next((t for t in bundle['topics'] if t['id'] == topic_id), None)
        if match is None:
            raise ValueError(f'Unknown topic ID: {topic_id}')
        target = match['target']
    if not isinstance(target, str) or not target.strip():
        raise ValueError('Choose a topic_id or supply an explicit target proposition.')
    if len(target) > 500:
        raise ValueError('Target must be 500 characters or fewer.')
    x = bundle['features'].transform([{'text': clean(text), 'topic': clean(target)}])
    classifier = bundle['classifier']
    scores = classifier.decision_function(x)[0]
    return {'target': target, 'stance': str(classifier.predict(x)[0]),
            'decision_scores': {str(k): round(float(v), 4) for k, v in zip(classifier.classes_, scores)},
            'score_note': 'Uncalibrated scores; not confidence percentages.',
            'language': 'English only', 'model': bundle['model_name']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    training = commands.add_parser('train')
    training.add_argument('--data-dir', default=str(BASE / 'data' / 'vast'))
    training.add_argument('--gd-data', default=str(BASE / 'data' / 'gd_examples.csv'))
    training.add_argument('--output-dir', default=str(BASE / 'artifacts'))
    inference = commands.add_parser('predict')
    inference.add_argument('--model', default=str(BASE / 'artifacts' / 'stance_model.joblib'))
    inference.add_argument('--topic', required=True)
    inference.add_argument('--text', required=True)
    commands.add_parser('topics')
    args = parser.parse_args()
    if args.command == 'train':
        train(args.data_dir, args.gd_data, args.output_dir)
    elif args.command == 'predict':
        bundle = joblib.load(args.model)
        print(json.dumps(predict(bundle, args.text, topic_id=args.topic), indent=2))
    else:
        print((BASE / 'topics.json').read_text(encoding='utf-8'))


if __name__ == '__main__':
    # Keep saved custom classes importable when training through the CLI.
    from gd_model import main as imported_main
    imported_main()
