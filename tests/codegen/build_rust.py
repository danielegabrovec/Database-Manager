import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent / 'generated'
environment = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / 'sqlite-rust-project/target'))
results=[]
for engine in ('sqlite', 'postgresql', 'mysql', 'mariadb', 'mongodb'):
    project=ROOT / f'{engine}-rust-project'
    result=subprocess.run(['cargo','build','--manifest-path',str(project / 'Cargo.toml')],env=environment,capture_output=True,text=True)
    if result.returncode == 0: shutil.copy2(Path(environment['CARGO_TARGET_DIR'])/'debug/database-example.exe',project/'database-example.exe')
    results.append({'engine':engine,'output':'project','success':result.returncode==0,'errors':result.stderr if result.returncode else ''})
    print(engine + ' project: ' + ('PASS' if result.returncode==0 else 'FAIL'),flush=True)
    project=ROOT / f'{engine}-rust-rest'
    result=subprocess.run(['cargo','build','--manifest-path',str(project / 'Cargo.toml')],env=environment,capture_output=True,text=True)
    if result.returncode == 0: shutil.copy2(Path(environment['CARGO_TARGET_DIR'])/'debug/database-example.exe',project/'database-example.exe')
    results.append({'engine':engine,'output':'rest','success':result.returncode==0,'errors':result.stderr if result.returncode else ''})
    print(engine + ' REST: ' + ('PASS' if result.returncode==0 else 'FAIL'),flush=True)
(ROOT/'rust-build-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
