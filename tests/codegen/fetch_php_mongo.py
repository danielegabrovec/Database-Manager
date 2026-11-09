import os
from pathlib import Path
import subprocess
import urllib.request
import zipfile
ROOT=Path(__file__).resolve().parent
def get(url):
    with urllib.request.urlopen(url,timeout=60) as response:return response.read()
version=get('https://pecl.php.net/rest/r/mongodb/stable.txt').decode().strip()
archive=ROOT/'toolchains/php-mongodb.zip'
archive.write_bytes(get(f'https://downloads.php.net/~windows/pecl/releases/mongodb/{version}/php_mongodb-{version}-8.4-nts-vs17-x64.zip'))
with zipfile.ZipFile(archive) as package:
    for name in package.namelist():
        if name.endswith('php_mongodb.dll'):(ROOT/'toolchains/php/ext/php_mongodb.dll').write_bytes(package.read(name))
composer=ROOT/'toolchains/composer.phar'
if not composer.exists():composer.write_bytes(get('https://getcomposer.org/download/latest-stable/composer.phar'))
environment=dict(os.environ,COMPOSER_HOME=str(ROOT/'toolchains/composer-home'),COMPOSER_CACHE_DIR=str(ROOT/'toolchains/composer-cache'))
command=[str(ROOT/'toolchains/php/php.exe'),'-n','-d','extension_dir='+str(ROOT/'toolchains/php/ext'),'-d','extension=openssl','-d','extension=curl','-d','extension=zip','-d','extension=mongodb',str(composer),'install','--no-interaction','--no-progress']
result=subprocess.run(command,cwd=ROOT/'generated/mongodb-php-project',env=environment)
print('PHP Mongo extension',version)
raise SystemExit(result.returncode)
