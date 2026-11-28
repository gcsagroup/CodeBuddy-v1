"""Pinned Serena bootstrap for the host's three read-only navigation queries.

The factory hook is protected, not a public configuration API. Keep its guard
and the same inspected ProjectConfig through activation; a CLI reload would
reopen the managed-install/project-command window.
"""

import hashlib
import inspect
import json
import logging
from pathlib import Path


class NavigationUnavailable(RuntimeError):
    code = "CODE_NAVIGATION_UNAVAILABLE"

    def __init__(self, message):
        super().__init__(f"{self.code}: {message}")


def _file(path, boundary):
    try:
        resolved = Path(path).resolve(strict=True)
        resolved.relative_to(Path(boundary).resolve(strict=True))
        if not resolved.is_file():
            raise ValueError("not a file")
        return resolved
    except (OSError, ValueError) as error:
        raise NavigationUnavailable(f"Language-service payload is not prepared: {path}") from error


def _package(directory, name, version, boundary):
    manifest = _file(directory / "package.json", boundary)
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise NavigationUnavailable(f"Invalid prepared language-service manifest: {manifest}") from error
    if data.get("name") != name or data.get("version") != version:
        raise NavigationUnavailable(f"Prepared {name} must have version {version}")


def _settings_for_languages(languages, state, node, assets):
    from solidlsp.ls_config import LanguageServerId
    from solidlsp.settings import SolidLSPSettings
    from solidlsp.language_servers.pyright_server import PYRIGHT_VERSION
    from solidlsp.language_servers.typescript_language_server import (
        DEFAULT_TYPESCRIPT_VERSION, DEFAULT_TYPESCRIPT_LANGUAGE_SERVER_VERSION,
        INITIAL_TYPESCRIPT_VERSION, INITIAL_TYPESCRIPT_LANGUAGE_SERVER_VERSION,
    )

    unsupported = [language.get_key() for language in languages
                   if language not in (LanguageServerId.PYTHON, LanguageServerId.TYPESCRIPT)]
    if unsupported:
        raise NavigationUnavailable("Language-service payload is not prepared for: " + ", ".join(unsupported))
    if not languages:
        raise NavigationUnavailable("Serena did not select a language service for this project")

    settings = {}
    storage = SolidLSPSettings(solidlsp_dir=str(state))
    for language in languages:
        server_class = language.get_ls_class()
        # This upstream helper migrates old vendor-local caches even with
        # mkdir=False. A query must not perform that migration implicitly.
        legacy = Path(inspect.getfile(server_class)).parent / "static" / server_class.__name__
        if legacy.exists():
            raise NavigationUnavailable(f"Legacy language-service cache needs explicit preparation: {legacy}")
        resources = Path(server_class.ls_resources_dir(storage, mkdir=False)).resolve()
        try:
            resources.relative_to(state)
        except ValueError as error:
            raise NavigationUnavailable("Language-service cache is outside the host state directory") from error

        if language == LanguageServerId.PYTHON:
            payload = assets / "pyright"
            _package(payload, "pyright", PYRIGHT_VERSION, assets)
            command = _file(payload / "dist" / "pyright-langserver.js", assets)
            settings[language.get_key()] = {"ls_base_cmd": [str(node), str(command)], "ls_args": ["--stdio"]}
        else:
            versions = (DEFAULT_TYPESCRIPT_VERSION, DEFAULT_TYPESCRIPT_LANGUAGE_SERVER_VERSION)
            if versions != ("5.9.3", "5.1.3"):
                raise NavigationUnavailable("The pinned TypeScript dependency provider requires a new review")
            prepared = assets / "typescript"
            if prepared.exists():
                boundary = assets
                try:
                    expected = json.loads(_file(assets / "typescript-runtime.json", assets).read_text(encoding="utf-8"))
                    actual = json.loads(_file(prepared / ".codebuddy-runtime.json", assets).read_text(encoding="utf-8"))
                    if actual != expected:
                        raise ValueError("payload provenance mismatch")
                except (OSError, ValueError) as error:
                    raise NavigationUnavailable("Prepared TypeScript payload provenance does not match the host") from error
            else:
                initial = versions == (INITIAL_TYPESCRIPT_VERSION, INITIAL_TYPESCRIPT_LANGUAGE_SERVER_VERSION)
                prepared = resources / ("ts-lsp" if initial else f"ts-lsp-{versions[0]}-{versions[1]}")
                boundary = state
            modules = prepared / "node_modules"
            server = modules / "typescript-language-server"
            compiler = modules / "typescript"
            _package(server, "typescript-language-server", versions[1], boundary)
            _package(compiler, "typescript", versions[0], boundary)
            command = _file(server / "lib" / "cli.mjs", boundary)
            tsserver = _file(compiler / "lib" / "tsserver.js", boundary)
            for entry in ("_tsserver.js", "typescript.js", "typingsInstaller.js", "_typingsInstaller.js"):
                _file(compiler / "lib" / entry, boundary)
            settings[language.get_key()] = {
                "ls_base_cmd": [str(node), str(command)], "ls_args": ["--stdio"],
                "initializationOptions": {
                    "disableAutomaticTypingAcquisition": True,
                    "tsserver": {"path": str(tsserver)},
                },
            }
    return settings


def _project_config(workspace, config):
    from serena.config.serena_config import ProjectConfig

    # Reuse upstream defaults, compatibility and local overrides, but not load():
    # load() persists migrations; autogeneration normally writes both YAML files.
    folder = (workspace / ".serena").resolve()
    try:
        folder.relative_to(workspace)
    except ValueError as error:
        raise NavigationUnavailable("Project configuration must stay inside the current workspace") from error
    base, local = folder / "project.yml", folder / "project.local.yml"
    def checked_yaml(path):
        try:
            return str(_file(path, workspace))
        except NavigationUnavailable as error:
            raise NavigationUnavailable("Project configuration must be a file inside the current workspace") from error
    if base.exists() or base.is_symlink():
        data, _ = ProjectConfig._load_yaml_dict(checked_yaml(base))
        data.setdefault("project_name", workspace.name)
    else:
        data = ProjectConfig.autogenerate(workspace, config, save_to_disk=False, asynchronous=False)._to_yaml_dict()
    overrides = []
    if local.exists() or local.is_symlink():
        local_data, _ = ProjectConfig._load_yaml_dict(checked_yaml(local), apply_defaults=False)
        if local_data:
            overrides = list(local_data)
            data.update(local_data)
    project = ProjectConfig._from_dict(data, local_override_keys=overrides)
    # This private query service does not consume project prompts or mode files.
    project.initial_prompt = ""
    project.added_modes = []
    project.default_modes = None
    project.read_only = True
    return project


def prepare_config(config, workspace, state, node_executable, assets, project_data):
    from serena.config.serena_config import RegisteredProject

    workspace, state, assets = Path(workspace).resolve(strict=True), Path(state).resolve(), Path(assets).resolve(strict=True)
    node = Path(node_executable).resolve(strict=True)
    if not node.is_file():
        raise NavigationUnavailable("The host Node executable is unavailable")
    config.with_headless_mode_overrides()
    config.web_dashboard_open_on_launch = False
    config.log_level = logging.ERROR
    # Only this in-memory navigation instance is constrained. Do not persist a
    # trust change, and do not inherit project activation commands or LS overrides.
    config.trusted_project_path_patterns = []
    project = _project_config(workspace, config)
    if not config.determine_language_backend(project).is_lsp():
        raise NavigationUnavailable("Read-only navigation requires a prepared LSP backend")
    for folder in [*project.ls_workspace_folders, *project.ls_additional_workspace_folders]:
        try:
            (workspace / folder).resolve(strict=True).relative_to(workspace)
        except (OSError, ValueError) as error:
            raise NavigationUnavailable("Language-service workspace folders must stay inside the current workspace") from error
    config.ls_specific_settings = _settings_for_languages(project.language_servers, state, node, assets)
    project_data = Path(project_data).resolve()
    if project_data.is_relative_to(workspace):
        raise NavigationUnavailable("Private navigation data must be outside the current workspace")
    # Existence is required: Serena otherwise falls back to workspace/.serena.
    project_data.mkdir(parents=True, exist_ok=True)
    config.project_serena_folder_location = str(project_data)
    # Public RegisteredProject keeps exactly this inspected configuration. The
    # factory's later lookup therefore cannot reread a changed project.local.yml.
    config.projects = [RegisteredProject(str(workspace), project)]
    return config


def create_server(workspace, state, node_executable, assets, project_data):
    from serena import __version__
    from serena.mcp import SerenaMCPFactory
    from serena.config.serena_config import ModeSelectionDefinitionWithAddedModes, SerenaConfig

    factory_file = _file(inspect.getfile(SerenaMCPFactory), Path(__file__).resolve().parent / "serena")
    if (__version__ != "1.7.1.dev0"
            or hashlib.sha256(factory_file.read_bytes()).hexdigest() != "7b5aab7dcf91503be850ce580aa101d3713fccfe8bdfe32f8aa53ab33f130daa"
            or tuple(inspect.signature(SerenaMCPFactory._create_serena_agent).parameters)
            != ("self", "serena_config", "modes", "project_activation_error")):
        raise NavigationUnavailable("The protected Serena bootstrap contract requires a new version review")
    config_file = _file(inspect.getfile(SerenaConfig), Path(__file__).resolve().parent / "serena")
    if hashlib.sha256(config_file.read_bytes()).hexdigest() != "0149cbafedb537f769a00a8e1ee69f70cb7976657e419ffd1df9a736d16289e3":
        raise NavigationUnavailable("The protected Serena project configuration requires a new version review")

    # Check before the upstream factory's error/GUI handler. Its own config
    # reload must never replace this snapshot when the Agent is constructed.
    prepared_config = prepare_config(SerenaConfig(), workspace, state, node_executable, assets, project_data)

    class PreparedNavigationFactory(SerenaMCPFactory):
        def _create_serena_agent(self, serena_config, modes=None, project_activation_error=None):
            return super()._create_serena_agent(prepared_config, modes, project_activation_error)

    return PreparedNavigationFactory("stdio", context="ide", project=str(workspace)).create_mcp_server(
        mode_selection_def=ModeSelectionDefinitionWithAddedModes(default_modes=("planning", "no-onboarding", "no-memories")),
        enable_web_dashboard=False, enable_gui_log_window=False, open_web_dashboard=False, log_level="ERROR",
    )
