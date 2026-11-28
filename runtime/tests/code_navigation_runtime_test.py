import json
import os
from pathlib import Path
import site
import sys
import tempfile
import unittest
from unittest.mock import patch

ASSETS = Path(__file__).resolve().parents[1] / "assets"
site.addsitedir(str(ASSETS / "serena"))
sys.path.insert(0, str(ASSETS))

from code_navigation_runtime import NavigationUnavailable, create_server
from serena.config.serena_config import SerenaConfig
from serena.mcp import SerenaMCPFactory
from solidlsp.ls import SolidLanguageServer


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="navigation-bootstrap-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.workspace, self.state = self.root / "workspace", self.root / "state"
        self.assets = self.root / "assets"
        (self.workspace / ".serena").mkdir(parents=True)
        self.state.mkdir()
        (self.assets / "pyright/dist").mkdir(parents=True)
        (self.assets / "pyright/package.json").write_text(json.dumps({"name": "pyright", "version": "1.1.403"}), encoding="utf-8")
        (self.assets / "pyright/dist/pyright-langserver.js").write_text("// never executed", encoding="utf-8")
        self.previous_state = os.environ.get("SERENA_HOME")
        os.environ["SERENA_HOME"] = str(self.state)
        self.addCleanup(self.restore_state)
        self.global_file = self.state / "serena_config.yml"
        self.global_file.write_text(json.dumps({"projects": [], "trusted_project_path_patterns": ["**"]}), encoding="utf-8")

    def restore_state(self):
        if self.previous_state is None:
            os.environ.pop("SERENA_HOME", None)
        else:
            os.environ["SERENA_HOME"] = self.previous_state

    def project(self, languages, **extra):
        data = {"project_name": "fixture", "language_servers": languages, **extra}
        (self.workspace / ".serena" / "project.yml").write_text(json.dumps(data), encoding="utf-8")

    def create(self):
        return create_server(self.workspace, self.state, sys.argv[1], self.assets, self.root / "derived")

    def test_all_selected_services_are_checked_before_any_agent_or_install(self):
        self.project(["python", "typescript"])
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server, patch.object(SolidLanguageServer, "create") as language_server:
            with self.assertRaisesRegex(NavigationUnavailable, "not prepared"):
                self.create()
            server.assert_not_called()
            language_server.assert_not_called()

    def test_unprepared_language_does_not_fall_back_to_its_provider(self):
        self.project(["python", "bash"])
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "bash"):
                self.create()
            server.assert_not_called()

    def test_project_commands_are_not_trusted_and_the_checked_snapshot_survives_a_reload(self):
        self.project(["python"], activation_command="must-not-run", ls_specific_settings={"python": {"ls_base_cmd": ["uvx", "unsafe"]}})
        original_global = self.global_file.read_bytes()

        def upstream_reload(factory, **kwargs):
            self.project(["bash"], activation_command="changed-after-check")
            # Simulate the upstream factory's independent config read before
            # the protected Agent-construction hook. It must not replace ours.
            return factory._create_serena_agent(SerenaConfig())

        with patch.object(SerenaMCPFactory, "create_mcp_server", upstream_reload), patch("serena.mcp.SerenaAgent") as agent:
            self.create()
            config = agent.call_args.kwargs["serena_config"]
            self.assertEqual(config.trusted_project_path_patterns, [])
            self.assertEqual([language.get_key() for language in config.projects[0].project_config.language_servers], ["python"])
            self.assertEqual(config.ls_specific_settings["python"]["ls_base_cmd"][0], str(Path(sys.argv[1]).resolve()))
            self.assertNotIn("uvx", json.dumps(config.ls_specific_settings))
            self.assertEqual(self.global_file.read_bytes(), original_global, "Query constraints never persist a trust change")

    def test_workspace_configuration_cannot_expand_the_query_scope(self):
        self.project(["python"], ls_additional_workspace_folders=[".."])
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "inside the current workspace"):
                self.create()
            server.assert_not_called()

    def test_non_lsp_backend_is_explicitly_unavailable(self):
        self.project(["python"], language_backend="JetBrains")
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "prepared LSP"):
                self.create()
            server.assert_not_called()

    def inspect_config(self):
        def checked_settings(factory, **kwargs):
            return factory._create_serena_agent(SerenaConfig())
        with patch.object(SerenaMCPFactory, "create_mcp_server", checked_settings), patch("serena.mcp.SerenaAgent") as agent:
            self.create()
            return agent.call_args.kwargs["serena_config"]

    def test_project_defaults_and_local_overrides_are_read_without_writes(self):
        self.project(["typescript"], initial_prompt="unneeded template", added_modes=["outside.yml"])
        local = self.workspace / ".serena/project.local.yml"
        local.write_text('language_servers: [python]\n', encoding="utf-8")
        before = {path.name: path.read_bytes() for path in local.parent.iterdir()}
        config = self.inspect_config()
        project = config.projects[0].project_config
        self.assertEqual([language.get_key() for language in project.language_servers], ["python"])
        self.assertEqual(project.initial_prompt, "")
        self.assertEqual(project.added_modes, [])
        self.assertTrue(project.read_only)
        self.assertEqual({path.name: path.read_bytes() for path in local.parent.iterdir()}, before)
        self.assertEqual(Path(config.get_project_serena_folder(self.workspace)), self.root / "derived")

    def test_local_only_configuration_is_honored_without_creating_base_yaml(self):
        (self.workspace / "sample.py").write_text('def add(a, b): return a + b\n', encoding="utf-8")
        local = self.workspace / ".serena/project.local.yml"
        local.write_text('language_servers: [python]\nproject_name: local-only\n', encoding="utf-8")
        config = self.inspect_config()
        self.assertEqual(config.projects[0].project_config.project_name, "local-only")
        self.assertEqual(list(local.parent.iterdir()), [local])

    def test_autodetection_does_not_create_project_files_or_admit_in_workspace_cache(self):
        (self.workspace / ".serena").rmdir()
        (self.workspace / "sample.py").write_text('def add(a, b): return a + b\n', encoding="utf-8")
        self.inspect_config()
        self.assertFalse((self.workspace / ".serena").exists())
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "outside the current workspace"):
                create_server(self.workspace, self.state, sys.argv[1], self.assets, self.workspace / "derived")
            server.assert_not_called()

    def test_factory_contract_change_fails_closed(self):
        self.project(["python"])
        with patch("serena.__version__", "future-unreviewed"), patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "version review"):
                self.create()
            server.assert_not_called()

    def test_prepared_typescript_cache_uses_the_host_compiler_and_never_managed_install(self):
        self.project(["typescript"])
        modules = self.state / "language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules"
        for name, version, files in [
            ("typescript-language-server", "5.1.3", ["cli.mjs"]),
            ("typescript", "5.9.3", ["tsserver.js", "_tsserver.js", "typescript.js", "typingsInstaller.js", "_typingsInstaller.js"]),
        ]:
            package = modules / name
            (package / "lib").mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": name, "version": version}), encoding="utf-8")
            for name in files:
                (package / "lib" / name).write_text("// never executed", encoding="utf-8")

        def checked_settings(factory, **kwargs):
            return factory._create_serena_agent(SerenaConfig())

        with patch.object(SerenaMCPFactory, "create_mcp_server", checked_settings), patch("serena.mcp.SerenaAgent") as agent:
            self.create()
            settings = agent.call_args.kwargs["serena_config"].ls_specific_settings["typescript"]
            self.assertEqual(settings["ls_args"], ["--stdio"])
            self.assertTrue(settings["initializationOptions"]["disableAutomaticTypingAcquisition"])
            self.assertEqual(settings["initializationOptions"]["tsserver"]["path"], str(modules / "typescript/lib/tsserver.js"))
        (modules / "typescript/lib/_tsserver.js").unlink()
        with patch.object(SerenaMCPFactory, "create_mcp_server") as server:
            with self.assertRaisesRegex(NavigationUnavailable, "not prepared"):
                self.create()
            server.assert_not_called()


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(BootstrapTests))
    print("BOOTSTRAP_CONTRACT_TESTS", result.testsRun)
    raise SystemExit(not result.wasSuccessful())
