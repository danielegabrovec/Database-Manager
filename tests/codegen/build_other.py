from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent / 'generated'
def build_family(family):
    results=[]
    for engine in ('sqlite','postgresql','mysql','mariadb','mongodb'):
        languages=('java','kotlin') if family=='jvm' else (family,)
        for language in languages:
            folder=ROOT/f'{engine}-{language}-project'
            commands=([['go','mod','tidy'],['go','build','-o','database-example.exe','.']] if language=='go' else [['cmd','/d','/c','C:/Tools/gradle-9.7.1/bin/gradle.bat','--no-daemon','build']] if language in ('java','kotlin') else [['dotnet','build','--nologo']])
            output=''; success=True
            for command in commands:
                result=subprocess.run(command,cwd=folder,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=300)
                output+=result.stdout+result.stderr
                if result.returncode: success=False;break
            results.append({'engine':engine,'language':language,'success':success,'errors':output if not success else ''})
            print(engine+'/'+language+': '+('PASS' if success else 'FAIL'),flush=True)
    (ROOT/f'{family}-build-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    return results
with ThreadPoolExecutor(max_workers=3) as workers:
    results=list(workers.map(build_family,sys.argv[1:] or ('go','jvm','csharp')))
