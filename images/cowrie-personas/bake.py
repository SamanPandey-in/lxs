#!/cowrie/cowrie-env/bin/python3
"""Image build step (runs inside the upstream Cowrie image with Cowrie's own interpreter; that image has no shell).

For every data/personas/<name>.json: copy upstream's text-command outputs, then bake the persona's fake filesystem
(pickled tree with file contents embedded) into /out/personas/<name>/.
"""
import glob
import os
import shutil
import sys

sys.path.insert(0, "/tmp/personas")
import build_persona  # noqa: E402

DATA = "/cowrie/cowrie-git/src/cowrie/data"
BASE_PICKLE = os.path.join(DATA, "fs.pickle")
UPSTREAM_TXTCMDS = os.path.join(DATA, "txtcmds")

if not os.path.exists(BASE_PICKLE):
    sys.exit("base fs.pickle not found at %s: the upstream image layout changed, update bake.py" % BASE_PICKLE)

for persona_json in sorted(glob.glob("/tmp/personas/*.json")):
    name = os.path.splitext(os.path.basename(persona_json))[0]
    out = os.path.join("/out/personas", name)
    os.makedirs(out, exist_ok=True)
    if os.path.isdir(UPSTREAM_TXTCMDS):
        shutil.copytree(UPSTREAM_TXTCMDS, os.path.join(out, "txtcmds"), dirs_exist_ok=True)
    build_persona.main(persona_json, BASE_PICKLE, out)
