"""Adapt makefile drive syntax of the portable Ruby QA distribution, then run real make."""
from pathlib import Path
import re
import subprocess
import sys
makefile=Path('Makefile')
if makefile.exists():
    text=makefile.read_text(encoding='utf-8')
    text=re.sub(r'/([A-Z])/',lambda match:match[1]+':/',text)
    makefile.write_text(text,encoding='utf-8')
sys.exit(subprocess.run(['C:/msys64/ucrt64/bin/mingw32-make.exe','SHELL=C:/msys64/usr/bin/sh.exe']+sys.argv[1:]).returncode)
