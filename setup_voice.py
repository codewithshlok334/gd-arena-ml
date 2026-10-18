"""One-time download of the pinned multilingual speech model (about 75 MB)."""
from pathlib import Path
import os
from speech import MODEL_DIR, MODEL_REPO, MODEL_REVISION


def prepare_voice():
    required = ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt']
    if all((MODEL_DIR / name).is_file() for name in required):
        print('Local speech model is already installed.', flush=True)
        return
    runtime = Path(__file__).resolve().parent / '.runtime'
    os.environ.setdefault('HF_HOME', str(runtime / 'huggingface'))
    os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
    from huggingface_hub import snapshot_download
    print('Downloading the local speech model (about 75 MB). This is a one-time setup.', flush=True)
    snapshot_download(repo_id=MODEL_REPO, revision=MODEL_REVISION, local_dir=str(MODEL_DIR),
                      cache_dir=str(runtime / 'huggingface'), allow_patterns=required+['README.md'])
    print('Local speech model ready. No microphone audio was uploaded.', flush=True)


if __name__ == '__main__':
    prepare_voice()
