import json
from pathlib import Path
import re
import subprocess
import urllib.request
ROOT=Path(__file__).resolve().parent/'toolchains'
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'DatabaseManager-QA/1.0'}),timeout=60) as response:return response.read()
release=json.loads(get('https://api.github.com/repos/mongodb/mongo-c-driver/releases/latest'))
tag=release['tag_name']
archive=ROOT/'mongo-c-driver.tar.gz'
if not archive.exists():archive.write_bytes(get('https://github.com/mongodb/mongo-c-driver/archive/refs/tags/'+tag+'.tar.gz'))
destination=ROOT/'mongo-c-driver'
destination.mkdir(exist_ok=True)
subprocess.run(['C:/msys64/usr/bin/bsdtar.exe','-xf',str(archive),'-C',str(destination),'--strip-components','1'],check=True)
print('Mongo C driver source',tag,flush=True)
listing=get('https://repo.msys2.org/msys/x86_64/').decode('utf-8')
packages=sorted(set(re.findall(r'\bmake-[0-9][^"<> ]*-x86_64\.pkg\.tar\.zst',listing)))
package=packages[-1]
archive=ROOT/'make.pkg.tar.zst'
if not archive.exists():archive.write_bytes(get('https://repo.msys2.org/msys/x86_64/'+package))
destination=ROOT/'msys-make'
destination.mkdir(exist_ok=True)
subprocess.run(['C:/msys64/usr/bin/bsdtar.exe','-xf',str(archive),'-C',str(destination)],check=True)
print('MSYS make',package,flush=True)
