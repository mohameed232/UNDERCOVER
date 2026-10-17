import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location("receiver", Path(__file__).parents[1] / "deploy/receive.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


def make_archive(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, body, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(body) if kind == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(body) if kind == tarfile.REGTYPE else None)
    return buffer.getvalue()


@pytest.mark.parametrize("name,kind", [("../../nexus/file", tarfile.REGTYPE), ("/etc/passwd", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("pipe", tarfile.FIFOTYPE)])
def test_receiver_rejects_paths_and_special_files(tmp_path, name, kind):
    source = tmp_path / "upload.tar.gz"
    source.write_bytes(make_archive([(name, b"x", kind)]))
    with pytest.raises(ValueError):
        receiver.extract(source, tmp_path / "release")
    assert not (tmp_path / "release").exists()


@pytest.mark.parametrize("failure", [None, "install", "health"])
def test_deploy_activation_and_rollback_are_scoped(tmp_path, monkeypatch, failure):
    base = tmp_path / "undercover"
    base.mkdir()
    releases = base / "releases"
    releases.mkdir()
    current = base / "current"
    current.symlink_to(base)
    monkeypatch.setattr(receiver, "BASE", base)
    monkeypatch.setattr(receiver, "RELEASES", releases)
    monkeypatch.setattr(receiver, "CURRENT", current)
    monkeypatch.setattr(receiver.os, "geteuid", lambda: 1000)
    contents = make_archive([(name, b"test", tarfile.REGTYPE) for name in ("app.py", "requirements.txt", "static/index.html", "deploy/smoke.py")])
    sha = "a" * 40
    checksum = hashlib.sha256(contents).hexdigest()
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", f"deploy {sha} {checksum}")
    monkeypatch.setattr(receiver.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(contents)))
    calls = []

    def run(*args, **kwargs):
        calls.append(args)
        if failure == "install" and "pip" in args:
            raise subprocess.CalledProcessError(1, args)
        if failure == "health" and "http://127.0.0.1:8081" in args:
            raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(receiver, "run", run)
    if failure:
        with pytest.raises(subprocess.CalledProcessError):
            receiver.main()
        assert current.resolve() == base
    else:
        receiver.main()
        assert current.resolve() == releases / sha
        assert (current / "REVISION").read_text().strip() == sha
    privileged = [call for call in calls if call[0] == "sudo"]
    assert all(call == ("sudo", "-n", "/usr/bin/systemctl", "restart", "undercover.service") for call in privileged)
    assert len(privileged) == (2 if failure == "health" else 0 if failure == "install" else 1)


@pytest.mark.parametrize("command", ["bash", "deploy main", "deploy " + "a" * 40 + "; id", "scp -t /etc", ""])
def test_receiver_refuses_shell_and_file_transfer(monkeypatch, command):
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", command)
    with pytest.raises(ValueError, match="Only a deployment"):
        receiver.main()
