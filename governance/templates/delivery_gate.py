#!/usr/bin/env python3
"""Fail-closed delivery evidence gate for PRs.

PR-only workflow helper. Verifies committed evidence only. Offline check of
committed manifest + OKF; no live service or credential usage. Never logs
credential or raw output.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SHA_RE = re.compile(r"^[a-f0-9]{40}$")
TICKET_RE = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")

ERR = "::error"
WARN = "::warning"


def die(msg: str, *, file: str = "", line: int | None = None) -> None:
    safe = msg.replace("\n", " ").replace("\r", "")[:1500]
    loc = ""
    if file:
        loc = f" file={file}"
        if line is not None:
            loc += f",line={line}"
    print(f"{ERR}{loc}::{safe}", file=sys.stderr)
    print(f"delivery-gate: {safe}", file=sys.stderr)
    sys.exit(1)


def run(*args: str):
    return subprocess.run(list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def sha_at_ref(ref: str):
    p = run("git", "rev-parse", "--verify", f"{ref}^{{commit}}")
    if p.returncode != 0:
        return None
    s = p.stdout.strip()
    return s if SHA_RE.match(s) else None


def parse_manifest(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"Delivery manifest not found: {path}", file=path.as_posix())
    except json.JSONDecodeError as e:
        die(f"Manifest JSON decode failed at {e.lineno}:{e.colno}: {e.msg}", file=path.as_posix(), line=e.lineno)
    except OSError as e:
        die(f"Cannot read manifest: {e}", file=path.as_posix())
    ticket = data.get("ticket_id")
    okf = data.get("okf_path")
    if not isinstance(ticket, str) or not TICKET_RE.match(ticket):
        die(f"Manifest field ticket_id missing or not WORK-style; got: {ticket!r}", file=path.as_posix())
    if not isinstance(okf, str) or not okf or okf.startswith("/") or "\\" in okf:
        die(f"Manifest field okf_path must be repository-relative Markdown path; got: {okf!r}", file=path.as_posix())
    if not okf.endswith(".md"):
        die(f"Manifest field okf_path must end in .md; got: {okf!r}", file=path.as_posix())
    if ".." in okf.split("/"):
        die(f"Manifest field okf_path must not contain traversal; got: {okf!r}", file=path.as_posix())
    return data, ticket, okf


def frontmatter_has(blob: str, key: str, value: str) -> bool:
    norm = blob.replace("\r\n", "\n")
    if not norm.startswith("---\n"):
        return False
    parts = norm.split("---\n", 2)
    return len(parts) == 3 and bool(re.search(rf"^{re.escape(key)}:\s*{re.escape(value)}\s*$", parts[1], re.MULTILINE))


def check_frontmatter(blob: str, rel: str):
    if not blob.startswith("---"):
        die("OKF must start with YAML frontmatter (opening '---' on line 1)", file=rel, line=1)
    nl = blob.find("\n")
    if nl == -1:
        die("OKF must start with YAML frontmatter (missing newline)", file=rel, line=1)
    first = blob[:nl].rstrip("\r")
    if first != "---":
        die("OKF must start with YAML frontmatter (opening line must be exactly '---')", file=rel, line=1)
    norm = blob.replace("\r\n", "\n")
    parts = norm.split("---\n", 2)
    if len(parts) != 3 or parts[0] != "":
        die("OKF must start with YAML frontmatter (missing closing '---')", file=rel, line=1)
    fm = parts[1]
    for k in ("type", "title", "timestamp"):
        if not re.search(rf"^{re.escape(k)}\s*:\s*\S", fm, re.MULTILINE):
            die(f"OKF frontmatter missing required key '{k}' (checked at delivery commit)", file=rel, line=1)


def main():
    repo = Path(os.environ.get("DELIVERY_GATE_REPO_ROOT") or os.environ.get("GITHUB_WORKSPACE") or ".").resolve()
    os.chdir(str(repo))

    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    if event_name and event_name != "pull_request":
        die(f"delivery-gate runs only on pull_request (got {event_name!r})")

    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = {}
    pr = {}
    base_sha = ""
    head_sha = ""
    if event_path and Path(event_path).exists():
        try:
            event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        except Exception as e:
            die(f"Cannot read event payload: {e}")
        pr = event.get("pull_request") or {}
        base_sha = (((pr.get("base") or {}).get("sha")) or "").strip().lower()
        head_sha = (((pr.get("head") or {}).get("sha")) or os.environ.get("GITHUB_SHA") or "").strip().lower()
    else:
        head_sha = (os.environ.get("GITHUB_SHA") or os.environ.get("DELIVERY_GATE_EXPECTED_COMMIT") or "").strip().lower()
        base_sha = (os.environ.get("GITHUB_BASE_SHA") or "").strip().lower()

    if head_sha and not SHA_RE.match(head_sha):
        die("Expected PR head SHA missing/malformed (need 40-char lowercase)")
    if head_sha and sha_at_ref(head_sha) != head_sha:
        die(f"Expected head {head_sha} not in checkout")

    manifest_env = (os.environ.get("DELIVERY_GATE_MANIFEST") or "").strip()
    expected_env = (os.environ.get("DELIVERY_GATE_EXPECTED_COMMIT") or "").strip().lower()
    if expected_env and not SHA_RE.match(expected_env):
        die(f"DELIVERY_GATE_EXPECTED_COMMIT must be 40-char SHA; got {expected_env!r}")

    manifests = []
    delivery_dir = repo / "evidence" / "delivery"

    if manifest_env:
        cand = (repo / manifest_env).resolve() if not Path(manifest_env).is_absolute() else Path(manifest_env).resolve()
        try:
            rel = cand.relative_to(repo)
        except ValueError:
            die(f"Manifest path escapes repository root: {manifest_env}")
        if cand.is_dir():
            die(f"Manifest path is a directory: {manifest_env}")
        if not cand.exists():
            die(f"Delivery manifest not found: {rel.as_posix()}", file=rel.as_posix())
        manifests = [cand]
    else:
        if base_sha and SHA_RE.match(base_sha) and head_sha and SHA_RE.match(head_sha) and base_sha != head_sha:
            if sha_at_ref(base_sha) != base_sha:
                die(f"Base commit {base_sha} not in checkout")
            p = run("git", "diff", "--name-only", "--diff-filter=AM", f"{base_sha}...{head_sha}")
            if p.returncode != 0:
                die(f"git diff base...head failed: {p.stderr[:400]}")
            names = [n.strip() for n in p.stdout.splitlines() if n.strip()]
            cands = [repo / n for n in names if n.startswith("evidence/delivery/") and n.endswith(".json")]
            if not cands:
                p2 = run("git", "diff", "--name-only", "--diff-filter=AM", f"{base_sha}..{head_sha}")
                if p2.returncode == 0:
                    names2 = [n.strip() for n in p2.stdout.splitlines() if n.strip()]
                    cands = [repo / n for n in names2 if n.startswith("evidence/delivery/") and n.endswith(".json")]
            manifests = [c for c in cands if c.exists()]
            if not manifests:
                pr_title = (pr.get("title") or "") if pr else ""
                is_housekeeping = pr_title.startswith("[housekeeping]") or pr_title.startswith("[HOUSEKEEPING]")
                is_evolution = pr_title.startswith("[evolution") or "EVOLUTION_" in " ".join(names) or any(n.startswith("skill-evolution/") for n in names)
                only_wiki = len(names) > 0 and all(n.startswith(".llm-wiki/wiki/") or n.startswith(".llm-wiki/templates/") for n in names)
                if is_housekeeping or is_evolution or only_wiki:
                    print(f"{WARN}::wiki-only/housekeeping/evolution PR — no delivery manifest required (title={pr_title!r}, files={names[:5]})", file=sys.stderr)
                    print("delivery-gate: skipped (wiki/housekeeping/evolution, no delivery evidence)", file=sys.stderr)
                    sys.exit(0)
                die("No delivery manifest changed in this PR (expected evidence/delivery/<TICKET>.json added/modified between base and head)")
        else:
            # local/test fallback: all manifests at HEAD
            if not delivery_dir.exists():
                die("No delivery evidence: evidence/delivery/ absent")
            found = sorted(delivery_dir.glob("*.json"))
            if not found:
                die("No delivery manifest: evidence/delivery/*.json empty")
            manifests = found

    # A governed implementation ticket requires a code/configuration mutation.
    # Documentation-only delivery is permitted only when every manifest's delivery
    # commit declares `work_class: documentation` and every changed path is in the
    # narrow canonical planning/evidence allowlist; mutable PR titles never grant it.
    if base_sha and SHA_RE.match(base_sha) and head_sha and SHA_RE.match(head_sha) and base_sha != head_sha and manifests:
        q = run("git", "diff", "--name-only", f"{base_sha}...{head_sha}")
        if q.returncode != 0:
            die(f"git diff base...head failed while checking implementation mutation: {q.stderr[:400]}")
        diff_names = [n.strip() for n in q.stdout.splitlines() if n.strip()]
        code_suffixes = (".go", ".mjs", ".js", ".ts", ".py", ".service", ".sh", ".yml", ".yaml")
        has_code = any(not n.startswith(("docs/", ".llm-wiki/", "evidence/")) and n.endswith(code_suffixes) for n in diff_names)
        doc_paths = ("docs/specs/", "docs/planning-rubric/", "evidence/delivery/")
        documentation_only = bool(diff_names) and all(n.startswith(doc_paths) for n in diff_names)
        for cand in manifests:
            data, _, okf = parse_manifest(cand)
            msha = data.get("commit_sha")
            shown = run("git", "show", f"{msha}:{okf}") if isinstance(msha, str) and SHA_RE.match(msha) else None
            documentation_only = documentation_only and shown is not None and shown.returncode == 0 and frontmatter_has(shown.stdout, "work_class", "documentation")
        if not has_code and not documentation_only:
            die(f"Implementation PR with delivery evidence has no code mutation (only {diff_names[:3]!r}); expected code mutation or artifact-bound documentation-only scope")

    github_output = os.environ.get("GITHUB_OUTPUT")
    ok = 0
    for cand in manifests:
        rel = cand.relative_to(repo).as_posix()
        data, ticket, okf = parse_manifest(cand)
        expected_name = f"{ticket}.json"
        if cand.name != expected_name:
            die(f"Manifest filename {cand.name!r} does not match ticket_id {ticket!r} (expected {expected_name!r})", file=rel)
        msha = data.get("commit_sha")
        if not isinstance(msha, str) or not SHA_RE.match(msha):
            die(f"Manifest field commit_sha missing or not 40-char SHA; got: {msha!r}", file=rel)
        if pr and isinstance(pr.get("number"), int):
            pr_num = pr["number"]
            mpr_num = (data.get("pull_request") or {}).get("number")
            if isinstance(mpr_num, int) and mpr_num != pr_num:
                die(f"Manifest pull_request.number {mpr_num} does not match PR #{pr_num}", file=rel)
            murl = (data.get("pull_request") or {}).get("url") or ""
            pr_url = pr.get("html_url") or pr.get("url") or ""
            if murl and pr_url:
                mm = re.search(r"/pull/(\d+)", murl)
                pp = re.search(r"/pull/(\d+)", pr_url)
                if mm and pp and mm.group(1) != pp.group(1):
                    die(f"Manifest pull_request.url PR /pull/{mm.group(1)} != triggering PR /pull/{pp.group(1)}", file=rel)
        if sha_at_ref(msha) != msha:
            die(f"Manifest commit_sha {msha} not found in checkout (stale or mis-copied)", file=rel)
        if head_sha:
            anc = run("git", "merge-base", "--is-ancestor", msha, head_sha)
            if anc.returncode != 0:
                die(f"Manifest commit_sha {msha} is not ancestor of PR head {head_sha} (stale)", file=rel)
            if msha == head_sha:
                print(f"{WARN} file={rel}::Manifest commit_sha equals PR head; evidence commit should be later than delivery commit", file=sys.stderr)
        okf_show = run("git", "show", f"{msha}:{okf}")
        if okf_show.returncode != 0:
            die(f"OKF artifact {okf!r} not present at delivery commit {msha}", file=okf)
        check_frontmatter(okf_show.stdout, okf)
        head_okf = run("git", "show", f"HEAD:{okf}")
        if head_okf.returncode != 0:
            die(f"OKF artifact {okf!r} not present at HEAD", file=okf)
        # authoritative Go validator for field-level cross-checks
        p = run("go", "run", "./cmd/delivery-evidence-validator", "-manifest", rel, "-repo-root", ".", "-expected-commit", msha)
        if p.returncode != 0:
            err = (p.stderr or p.stdout).replace("\n", " ").strip()[:1500]
            die(f"Deterministic validator failed for {rel}: {err}", file=rel)
        if github_output and ok == 0:
            try:
                with open(github_output, "a", encoding="utf-8") as f:
                    f.write(f"manifest={rel}\n")
                    f.write(f"expected_commit={msha}\n")
            except OSError:
                pass
        print(f"delivery-gate: ok {rel} ticket={ticket} commit={msha} okf={okf}", file=sys.stderr)
        ok += 1
    if ok == 0:
        die("No delivery manifests validated")
    print(f"delivery-gate: validated {ok} manifest(s) successfully", file=sys.stderr)


if __name__ == "__main__":
    main()
