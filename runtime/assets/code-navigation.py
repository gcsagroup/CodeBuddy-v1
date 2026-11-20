import asyncio
import json
import os
import sys
import site
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
    code = "import sys,site;site.addsitedir(sys.argv.pop(1));from serena.cli import top_level;top_level()"
    params = StdioServerParameters(command=sys.executable, env={**os.environ, "SERENA_HOME": request.get("state", str(Path(workspace) / ".serena-runtime"))}, args=[
        "-c", code, str(root / "serena"), "start-mcp-server",
        "--project", workspace, "--context", "ide",
        "--mode", "planning", "--mode", "no-onboarding", "--mode", "no-memories",
        "--enable-web-dashboard", "false", "--enable-gui-log-window", "false",
        "--open-web-dashboard", "false", "--log-level", "ERROR",
    ])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(names[operation], arguments)
            print(result.model_dump_json(by_alias=True))

asyncio.run(main())
