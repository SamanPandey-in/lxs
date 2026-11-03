#!/usr/bin/env python3
"""Bake a LXS persona into a Cowrie fake filesystem.

Usage: build_persona.py <persona.json> <base-fs.pickle> <out-dir>

Writes <out-dir>/fs.pickle (file contents embedded as bytes), <out-dir>/honeyfs/<path> (plain copy, for older Cowrie
releases that read contents_path) and <out-dir>/txtcmds/<path> (command output).
Cowrie stores the fake directory tree as a pickled list of nodes, so it has to be edited as data, not as files:
    node = [name, type, uid, gid, size, mode, ctime, children, target, realfile]
Run with Cowrie's own interpreter (/cowrie/cowrie-env/bin/python) so the pickle matches the pinned release.
Only static text is produced here: nothing in a persona is ever executed.
"""
import json
import os
import pickle
import sys
import time

A_NAME, A_TYPE, A_UID, A_GID, A_SIZE, A_MODE, A_CTIME, A_CONTENTS, A_TARGET, A_REALFILE = range(10)
T_LINK, T_DIR, T_FILE = 0, 1, 2
S_IFDIR, S_IFREG = 0o040000, 0o100000
CTIME = time.mktime((2026, 10, 1, 8, 0, 0, 0, 0, -1))


def find(node, name):
    for child in node[A_CONTENTS]:
        if child[A_NAME] == name:
            return child
    return None


def mkdir_p(root, path, uid=0, gid=0, mode=0o755):
    node = root
    for part in [p for p in path.split("/") if p]:
        nxt = find(node, part)
        if nxt is None:
            nxt = [part, T_DIR, uid, gid, 4096, S_IFDIR | mode, CTIME, [], None, None]
            node[A_CONTENTS].append(nxt)
        node = nxt
    return node


def put_file(root, path, size, uid=0, gid=0, mode=0o644, data=None):
    """data: bytes embedded in the node (current Cowrie reads A_CONTENTS bytes; a contents_path file overrides it)."""
    parent_path, _, name = path.rpartition("/")
    parent = mkdir_p(root, parent_path)
    existing = find(parent, name)
    node = [name, T_FILE, uid, gid, size, S_IFREG | mode, CTIME, data if data is not None else [], None, None]
    if existing is not None:
        parent[A_CONTENTS][parent[A_CONTENTS].index(existing)] = node
    else:
        parent[A_CONTENTS].append(node)


def write_text(base, path, content):
    target = os.path.join(base, path.lstrip("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def main(persona_path, base_pickle, out):
    with open(persona_path, encoding="utf-8") as fh:
        persona = json.load(fh)
    with open(base_pickle, "rb") as f:
        root = pickle.load(f, encoding="utf-8")

    os.makedirs(out, exist_ok=True)
    honeyfs = os.path.join(out, "honeyfs")
    txtcmds = os.path.join(out, "txtcmds")

    passwd = [
        "root:x:0:0:root:/root:/bin/bash",
        "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
        "sshd:x:105:65534::/run/sshd:/usr/sbin/nologin",
    ]
    group = ["root:x:0:", "daemon:x:1:"]
    for u in persona.get("users", []):
        passwd.append("%s:x:%d:%d:%s:%s:%s" % (u["name"], u["uid"], u["gid"], u.get("gecos", ""), u["home"], u["shell"]))
        group.append("%s:x:%d:" % (u["name"], u["gid"]))
        if u["shell"] != "/usr/sbin/nologin":
            mkdir_p(root, u["home"], u["uid"], u["gid"], 0o750)
    write_text(honeyfs, "/etc/passwd", "\n".join(passwd) + "\n")
    write_text(honeyfs, "/etc/group", "\n".join(group) + "\n")
    passwd_txt = "\n".join(passwd) + "\n"
    group_txt = "\n".join(group) + "\n"
    put_file(root, "/etc/passwd", len(passwd_txt), data=passwd_txt.encode("utf-8"))
    put_file(root, "/etc/group", len(group_txt), data=group_txt.encode("utf-8"))

    for d in persona.get("dirs", []):
        mkdir_p(root, d["path"], d.get("uid", 0), d.get("gid", 0), int(d.get("mode", "0755"), 8))

    for f in persona.get("files", []):
        content = f.get("content")
        size = f.get("size", len(content.encode("utf-8")) if content is not None else 0)
        put_file(
            root,
            f["path"],
            size,
            f.get("uid", 0),
            f.get("gid", 0),
            int(f.get("mode", "0644"), 8),
            data=content.encode("utf-8") if content is not None else None,
        )
        if content is not None:
            write_text(honeyfs, f["path"], content)

    for path, text in persona.get("commands", {}).items():
        write_text(txtcmds, path, text)

    with open(os.path.join(out, "fs.pickle"), "wb") as f:
        pickle.dump(root, f, protocol=2)
    print(
        "persona %s: %d files, %d dirs, %d commands"
        % (persona["name"], len(persona.get("files", [])), len(persona.get("dirs", [])), len(persona.get("commands", {})))
    )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
