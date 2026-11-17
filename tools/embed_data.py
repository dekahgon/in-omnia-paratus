"""Copies data/*.csv into js/data-embedded.js, so the site also works when the HTML files
are opened directly from the disk. Run after editing the CSVs:  python3 tools/embed_data.py"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
d = {k: (root / 'data' / f'{k}.csv').read_text(encoding='utf-8') for k in ['movies', 'characters', 'appearances']}
(root / 'js' / 'data-embedded.js').write_text(
    '/* Built-in copy of data/*.csv, used when the CSVs cannot be loaded (e.g. the page was opened by double-clicking).\n'
    '   Regenerate after editing the CSVs: python3 tools/embed_data.py */\n'
    'window.MN_EMBEDDED = ' + json.dumps(d, ensure_ascii=False) + ';\n', encoding='utf-8')
print('updated js/data-embedded.js')
