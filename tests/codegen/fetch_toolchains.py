"""Fetch portable verification runtimes from their official distributions only."""
import json
from pathlib import Path
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent / 'toolchains'
ROOT.mkdir(exist_ok=True)
def get_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'DatabaseManager-QA/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)
def download(url, path):
    if not path.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'DatabaseManager-QA/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response, path.open('wb') as output:
            while block := response.read(1024 * 1024): output.write(block)

releases = get_json('https://windows.php.net/downloads/releases/releases.json')
release = releases.get('8.4') or releases['8.5']
asset = next((value for key, value in release.items() if key.startswith('nts-vs') and key.endswith('-x64')), None)
if asset:
    filename = asset['zip']['path']
    archive = ROOT / 'php.zip'
    download('https://windows.php.net/downloads/releases/' + filename, archive)
    php = ROOT / 'php'
    php.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as package: package.extractall(php)
    print('PHP portable:', release['version'])
else:
    print('PHP: no compatible official x64 asset found')

release = get_json('https://api.github.com/repos/oneclick/rubyinstaller2/releases/latest')
asset = next((asset for asset in release['assets'] if asset['name'].endswith('-x64.7z')), None)
if asset:
    archive = ROOT / 'ruby.7z'
    download(asset['browser_download_url'], archive)
    ruby = ROOT / 'ruby'
    ruby.mkdir(exist_ok=True)
    subprocess.run(['C:/msys64/usr/bin/bsdtar.exe', '-xf', str(archive), '-C', str(ruby)], check=True)
    print('Ruby portable:', release['tag_name'])
else:
    print('Ruby: no compatible official x64 portable asset found')

cjson = ROOT / 'cjson'
(cjson / 'include' / 'cjson').mkdir(parents=True, exist_ok=True)
download('https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.19/cJSON.h', cjson / 'include' / 'cjson' / 'cJSON.h')
download('https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.19/cJSON.c', cjson / 'cJSON.c')
