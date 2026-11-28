import asyncio
import json
import os
import sys
import site
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent
site.addsitedir(str(root / "serena"))
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    request = json.load(sys.stdin)
    names = {"overview": "get_symbols_overview", "definition": "find_symbol", "references": "find_referencing_symbols"}
    operation = request["operation"]
    if operation not in names:
        raise ValueError("Unsupported read-only query")
    workspace = str(Path(request["workspace"]).resolve(strict=True))
    arguments = request.get("arguments", {})
    relative = arguments.get("relative_path")
    if relative:
        target = (Path(workspace) / relative).resolve(strict=True)
        target.relative_to(workspace)
    state = Path(request.get("state", str(Path(workspace) / ".serena-runtime"))).resolve()
    params = StdioServerParameters(command=sys.executable, env={**os.environ, "SERENA_HOME": str(state)}, args=[
        "-I", "-B", str(root / "code-navigation.py"), "--server",
        "--workspace", workspace, "--state", str(state), "--node", request["nodeExecutable"],
    ])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(names[operation], arguments)
            print(result.model_dump_json(by_alias=True))

def join_navigation_job(name):
    import ctypes
    from ctypes import wintypes
    # Join before Serena import/configuration. A retired or missing host Job
    # cannot be recreated by a late SDK startup attempt.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenJobObjectW.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.OpenJobObjectW(0x0001, False, name)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if not kernel.CloseHandle(job):
            raise ctypes.WinError(ctypes.get_last_error())


def serve():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--job")
    args = parser.parse_args()
    if args.serve:
        if not args.job:
            parser.error("--serve requires the host Job")
        join_navigation_job(args.job)
    workspace = str(Path(args.workspace).resolve(strict=True))
    state = Path(args.state).resolve()
    site.addsitedir(str(root))
    from code_navigation_runtime import create_server
    # Never inherit project caches or the old global registered-project list.
    # Serena's ordinary loaders can deserialize pickle and migrate project YAML.
    # Static language-service payloads still use the separately checked state.
    with tempfile.TemporaryDirectory(prefix="codebuddy-navigation-") as private_home:
        if Path(private_home).resolve().is_relative_to(Path(workspace)):
            raise ValueError("Private navigation data must be outside the current workspace")
        os.environ["SERENA_HOME"] = private_home
        create_server(workspace, state, args.node, root, Path(private_home) / "project").run(transport="stdio")


if __name__ == "__main__":
    if "--serve" in sys.argv[1:] or "--server" in sys.argv[1:]:
        serve()
    else:
        asyncio.run(main())
