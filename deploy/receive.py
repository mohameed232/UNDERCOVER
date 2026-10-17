#!/usr/bin/python3
"""Restricted SSH receiver. Install root-owned; runs as undercover-deploy, never root."""
import fcntl
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

BASE = Path("/opt/undercover")
RELEASES = BASE / "releases"
CURRENT = BASE / "current"
MAX_ARCHIVE = 25 * 1024 * 1024
MAX_CONTENT = 100 * 1024 * 1024


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def validate_members(archive):
    members = archive.getmembers()
    if len(members) > 2000 or sum(member.size for member in members) > MAX_CONTENT:
        raise ValueError("Archive is too large")
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("Unsafe archive path")
        if not (member.isfile() or member.isdir()):
            raise ValueError("Links and special files are forbidden")
    return members


def extract(archive_path, destination):
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in validate_members(archive):
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)


def switch_current(target):
    link = BASE / f".current-{os.getpid()}"
    link.symlink_to(target)
    os.replace(link, CURRENT)


def main():
    match = re.fullmatch(r"deploy ([0-9a-f]{40}) ([0-9a-f]{64})", os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    if not match:
        raise ValueError("Only a deployment of a commit and archive checksum is allowed")
    revision, expected_digest = match.groups()
    os.umask(0o022)
    if os.geteuid() == 0:
        raise ValueError("Do not run the receiver as root")
    with (BASE / ".deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not CURRENT.is_symlink():
            raise ValueError("Run the one-time VPS setup first")
        previous = CURRENT.resolve(strict=True)
        if previous != BASE and previous.parent != RELEASES:
            raise ValueError("Current release points outside UNDERCOVER")
        release = RELEASES / revision
        with tempfile.TemporaryDirectory(prefix=".incoming-", dir=RELEASES) as temporary:
            temporary = Path(temporary)
            archive_path = temporary / "source.tar.gz"
            digest = hashlib.sha256()
            total = 0
            with archive_path.open("wb") as archive_file:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_ARCHIVE:
                        raise ValueError("Archive exceeds the upload limit")
                    digest.update(chunk)
                    archive_file.write(chunk)
            if digest.hexdigest() != expected_digest:
                raise ValueError("Archive checksum does not match")
            if not release.exists():
                staged = temporary / "release"
                staged.mkdir()
                extract(archive_path, staged)
                for required in ("app.py", "requirements.txt", "static/index.html", "deploy/smoke.py"):
                    if not (staged / required).is_file():
                        raise ValueError(f"Missing required file: {required}")
                (staged / "REVISION").write_text(revision + "\n")
                (staged / ".archive-sha256").write_text(expected_digest)
                run("/usr/bin/python3", "-m", "venv", str(staged / ".venv"))
                python = str(staged / ".venv/bin/python")
                run(python, "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "-r", str(staged / "requirements.txt"))
                run(python, "-c", "from app import app; from undercover.data import WORD_PAIRS; assert len(WORD_PAIRS) >= 5", cwd=staged)
                staged.chmod(0o755)
                staged.rename(release)
            elif (release / ".archive-sha256").read_text() != expected_digest:
                raise ValueError("Existing release has a different checksum")

        # Use python -m rather than venv entrypoints: the staged directory was renamed.
        switch_current(release)
        try:
            run("sudo", "-n", "/usr/bin/systemctl", "restart", "undercover.service")
            python = str(release / ".venv/bin/python")
            run(python, str(release / "deploy/smoke.py"), "--url", "http://127.0.0.1:8011", "--revision", revision)
            run(python, str(release / "deploy/smoke.py"), "--url", "http://127.0.0.1:8081", "--host-header", "8.213.86.128:8081", "--revision", revision)
        except BaseException:
            switch_current(previous)
            run("sudo", "-n", "/usr/bin/systemctl", "restart", "undercover.service")
            print("Deployment failed; restored the previous UNDERCOVER release.", file=sys.stderr)
            raise
        print(f"Deployed and checked UNDERCOVER {revision}")
        # Keep the active release, rollback release, and three other recent releases.
        older = sorted((p for p in RELEASES.iterdir() if p.is_dir() and re.fullmatch(r"[0-9a-f]{40}", p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
        protected = {release, previous}
        retained = 0
        for candidate in older:
            if candidate in protected:
                continue
            if retained < 3:
                retained += 1
            else:
                shutil.rmtree(candidate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"UNDERCOVER deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
