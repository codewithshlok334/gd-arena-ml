"""Start the saved model and UI without retraining. Uses only stdlib to bootstrap."""
from pathlib import Path
import importlib.metadata
import json
import os
import subprocess
import sys
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
URL = 'http://127.0.0.1:7860/'


def main():
    try:
        with urllib.request.urlopen(URL + 'api/health', timeout=2) as response:
            running = json.load(response)
        if running.get('app') == 'GD Arena' and running.get('model_loaded'):
            print('GD Arena is already running. Opening your practice room.')
            webbrowser.open(URL)
            return
    except Exception:
        pass
    if not (3, 11) <= sys.version_info[:2] <= (3, 14):
        raise RuntimeError('Use Python 3.11 to 3.14. This project was tested on Python 3.12.')
    # Optional path used by the prepared launcher on the original demo machine.
    supplied = os.environ.get('GD_ARENA_DEPENDENCIES')
    packages = ROOT / '.runtime' / 'packages'
    if supplied:
        sys.path.insert(0, str(Path(supplied).resolve()))
    speech_dependencies = os.environ.get('GD_ARENA_SPEECH_DEPENDENCIES')
    if speech_dependencies:
        sys.path.append(str(Path(speech_dependencies).resolve()))
    if packages.is_dir():
        sys.path.insert(0, str(packages))
    required = [line.strip().split('==') for line in (ROOT / 'requirements.txt').read_text().splitlines()
                if line.strip() and not line.startswith('#')]
    missing = []
    for name, version in required:
        try:
            installed = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            installed = None
        if installed != version:
            missing.append(name)
    if missing:
        print('First launch: installing the saved model\'s Python libraries.')
        print('Internet is needed for this setup. Training is NOT required.')
        packages.mkdir(parents=True, exist_ok=True)
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                               '--target', str(packages), '--upgrade', '-r', str(ROOT / 'requirements.txt')])
        sys.path.insert(0, str(packages))
    from setup_voice import prepare_voice
    try:
        prepare_voice()
    except Exception as error:
        print('Speech setup could not finish:', error)
        print('Text practice will still open. Rerun the launcher with internet to finish voice setup.')
    from app import create_server
    server = create_server()
    print('\nGD Arena is ready at ' + URL)
    print('Keep this window open during your demo. Ctrl+C stops the app.\n', flush=True)
    webbrowser.open(URL)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('\nCould not start GD Arena:', error)
        print('See START_HERE.txt. No retraining is needed.')
        sys.exit(1)
