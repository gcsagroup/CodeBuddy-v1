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

def configure_python_server(state, node_executable):
    # Use Serena's supported command override. The default uvx route downloads
    # another Python and installs its server on the user's first read-only query.
    server = root / "pyright" / "dist" / "pyright-langserver.js"
    if not server.is_file():
        raise RuntimeError("Bundled Pyright is missing; prepare the code-navigation payload before packaging")
    node = str(Path(node_executable).resolve(strict=True))
    os.environ["SERENA_HOME"] = str(state)
    from serena.config.serena_config import SerenaConfig
    from ruamel.yaml import YAML
    config = SerenaConfig.from_config_file()
    config_path = Path(config.config_file_path).resolve(strict=True)
    config_path.relative_to(state.resolve())
    yaml = YAML()
    with config_path.open(encoding="utf-8") as stream:
        data = yaml.load(stream)
    python = data.setdefault("ls_specific_settings", {}).setdefault("python", {})
    command = [node, str(server)]
    if python.get("ls_base_cmd") != command:
        python["ls_base_cmd"] = command
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=config_path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            yaml.dump(data, stream)
        try:
            os.replace(temporary, config_path)
        finally:
            temporary.unlink(missing_ok=True)

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
    configure_python_server(state, request["nodeExecutable"])
    code = "import sys,site;site.addsitedir(sys.argv.pop(1));from serena.cli import top_level;top_level()"
    params = StdioServerParameters(command=sys.executable, env={**os.environ, "SERENA_HOME": str(state)}, args=[
        "-B", "-c", code, str(root / "serena"), "start-mcp-server",
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
