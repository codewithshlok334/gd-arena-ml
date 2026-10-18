"""Bundle optional meeting assets into the original server's supported URLs.

Run after editing web/camera.js or web/meeting.css. No extra packages required.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / 'web'
CAMERA_START = '// BEGIN BUNDLED CAMERA\n'
CAMERA_END = '// END BUNDLED CAMERA\n'
STYLE_START = '/* BEGIN BUNDLED MEETING STYLES */\n'


def build():
    app = (WEB/'app.js').read_text(encoding='utf-8')
    if app.startswith(CAMERA_START):
        app = app.split(CAMERA_END, 1)[1]
    camera = (WEB/'camera.js').read_text(encoding='utf-8')
    # A private scope also tolerates an older cached HTML page loading camera.js.
    bundle = CAMERA_START + "'use strict';\n(() => {\n" + camera.rstrip() + '\n})();\n' + CAMERA_END
    (WEB/'app.js').write_text(bundle+app, encoding='utf-8')
    styles = (WEB/'styles.css').read_text(encoding='utf-8').split(STYLE_START, 1)[0].rstrip()
    meeting = (WEB/'meeting.css').read_text(encoding='utf-8')
    (WEB/'styles.css').write_text(styles+'\n\n'+STYLE_START+meeting, encoding='utf-8')
    html = (WEB/'index.html').read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet" href="meeting.css">', '')
    html = html.replace('<script src="camera.js" defer></script>', '')
    (WEB/'index.html').write_text(html, encoding='utf-8')


if __name__ == '__main__':
    build()
    print('Camera and meeting styles bundled into app.js and styles.css.')
