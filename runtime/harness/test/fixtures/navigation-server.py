"""Local MCP fault fixture; never loads a model, Serena, or a desktop app."""
import argparse
import json
import os
from pathlib import Path
import runpy
import site
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--runtime", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--job", required=True)
parser.add_argument("--before-join-ms", type=int, default=0)
args = parser.parse_args()
workspace = Path(args.workspace)
events = workspace / "events.jsonl"


def record(kind, **extra):
    with events.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), **extra}) + "\n")


record("bootstrap", job=args.job)
time.sleep(args.before_join_ms / 1000)
adapter = runpy.run_path(str(Path(args.runtime) / "assets/code-navigation.py"))
adapter["join_navigation_job"](args.job)
record("joined")
site.addsitedir(str(Path(args.runtime) / "assets/serena"))
from mcp.server.fastmcp import FastMCP

server = FastMCP("private-navigation-fixture", instructions="PRIVATE_INSTRUCTIONS_MUST_NOT_BE_PROJECTED")


def query(operation, relative_path):
    record("query-start", operation=operation, path=relative_path)
    if relative_path in ("hold", "crash"):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"])
        record("descendant", child=child.pid)
        if relative_path == "crash":
            os._exit(17)
        time.sleep(60)
    if relative_path == "slow":
        time.sleep(0.2)
    if relative_path == "tool-error":
        raise ValueError("Known fixture query error")
    record("query-end", operation=operation, path=relative_path)
    return json.dumps({"pid": os.getpid(), "operation": operation, "path": relative_path})


@server.tool()
def get_symbols_overview(relative_path: str, max_answer_chars: int = 18000) -> str:
    return query("overview", relative_path)


@server.tool()
def find_symbol(relative_path: str, name_path_pattern: str, max_answer_chars: int = 18000) -> str:
    return query("definition", relative_path)


@server.tool()
def find_referencing_symbols(relative_path: str, name_path: str, max_answer_chars: int = 18000) -> str:
    return query("references", relative_path)


@server.tool()
def destructive_raw_tool() -> str:
    raise AssertionError("The read-only facade must never expose or dispatch this tool")


server.run(transport="stdio")
