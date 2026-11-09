import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import sqlite3

engine=sys.argv[1]
root=Path(__file__).resolve().parent
results=[]
if engine=='sqlite':
    database=root/'generated/rest-sqlite-test.sqlite'
    connection=sqlite3.connect(database)
    connection.execute('DROP TABLE IF EXISTS people')
    connection.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    connection.commit(); connection.close()
    os.environ['DATABASE_URL']=str(database)
def request(method,path,payload=None):
    data=None if payload is None else json.dumps(payload).encode('utf-8')
    req=urllib.request.Request('http://127.0.0.1:3000'+path,data=data,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)
for language in ('python','javascript','typescript','rust'):
    folder=root/'generated'/f'{engine}-{language}-rest'
    command=[sys.executable,'-m','uvicorn','server:app','--host','127.0.0.1','--port','3000'] if language=='python' else ['node','server.js' if language=='javascript' else 'dist/server.js'] if language in ('javascript','typescript') else [str(folder/'database-example.exe')]
    logfile=(folder/'qa-server.log').open('w',encoding='utf-8')
    process=subprocess.Popen(command,cwd=folder,env=dict(os.environ,PYTHONIOENCODING='utf-8'),stdout=logfile,stderr=logfile)
    try:
        for _ in range(100):
            if process.poll() is not None:raise AssertionError('Server terminated during startup')
            try:
                if request('GET','/health')['status']=='ok':break
            except OSError:time.sleep(.1)
        else:raise AssertionError('Server startup timed out')
        key={'_id':1107} if engine=='mongodb' else {'id':1107}
        record=dict(key,name="È una API '; DROP TABLE people; --")
        request('POST','/records',record)
        rows=request('GET','/records')
        assert any(row['name']==record['name'] for row in rows),rows
        record['name']='API aggiornata'
        request('PUT','/records',record)
        assert any(row['name']=='API aggiornata' for row in request('GET','/records'))
        request('DELETE','/records',key)
        assert not any(row['name']=='API aggiornata' for row in request('GET','/records'))
        results.append({'language':language,'success':True})
    except Exception as error:
        results.append({'language':language,'success':False,'error':str(error)})
    finally:
        process.terminate()
        process.wait(timeout=15)
        logfile.close()
print(json.dumps(results,ensure_ascii=False))
if engine=='sqlite':(root/'generated/rest-sqlite-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
if not all(result['success'] for result in results):sys.exit(1)
