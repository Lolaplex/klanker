"""klanker#129: `klanker remote` registry + vault token handling."""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from klanker import remotes_cli


def _args(**kw):
    base = dict(
        remote_cmd="",
        json=False,
        name="",
        url="",
        id="",
        token="",
        token_stdin=False,
        prompt=False,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _vault_has(host_dir: str, key: str) -> bool:
    path = Path(host_dir) / "secrets" / "host.json"
    if not path.is_file():
        return False
    data = json.loads(path.read_text(encoding="utf-8"))
    return bool(str(data.get(key) or "").strip())


class RemoteCliTests(unittest.TestCase):
    def test_add_list_rm_roundtrip_via_token_stdin(self):
        with tempfile.TemporaryDirectory() as td:
            host_dir = str(Path(td) / "host")
            env = {"AGENTS_HOST_DIR": host_dir}
            with patch.dict(os.environ, env, clear=False):
                with patch("sys.stdin", io.StringIO("tok-secret-1\n")):
                    rc = remotes_cli.cmd_remote(
                        _args(
                            remote_cmd="add",
                            name="PVS Box",
                            url="https://pvs.example.ts.net",
                            token_stdin=True,
                        )
                    )
                self.assertEqual(rc, 0)

                store = Path(host_dir) / "clients" / "remotes.json"
                data = json.loads(store.read_text(encoding="utf-8"))
                row = data["remotes"]["pvs-box"]
                self.assertNotIn("secret", row)
                self.assertNotIn("token", row)
                self.assertEqual(row["base_url"], "https://pvs.example.ts.net")
                self.assertTrue(_vault_has(host_dir, "REMOTE_PVS-BOX_TOKEN"))

                buf = io.StringIO()
                with redirect_stdout(buf):
                    rc = remotes_cli.cmd_remote(_args(remote_cmd="list"))
                self.assertEqual(rc, 0)
                out = buf.getvalue()
                self.assertIn("pvs-box", out)
                self.assertIn("token", out)
                self.assertNotIn("tok-secret-1", out)

                rc = remotes_cli.cmd_remote(_args(remote_cmd="rm", id="pvs-box"))
                self.assertEqual(rc, 0)
                data = json.loads(store.read_text(encoding="utf-8"))
                self.assertNotIn("pvs-box", data["remotes"])
                self.assertFalse(_vault_has(host_dir, "REMOTE_PVS-BOX_TOKEN"))

    def test_add_rejects_bad_url_without_writes(self):
        with tempfile.TemporaryDirectory() as td:
            host_dir = str(Path(td) / "host")
            env = {"AGENTS_HOST_DIR": host_dir}
            with patch.dict(os.environ, env, clear=False):
                rc = remotes_cli.cmd_remote(
                    _args(
                        remote_cmd="add",
                        name="bad",
                        url="file:///etc/passwd",
                        token="x",
                    )
                )
            self.assertEqual(rc, 2)
            self.assertFalse((Path(host_dir) / "clients" / "remotes.json").exists())
            self.assertFalse((Path(host_dir) / "secrets" / "host.json").exists())

    def test_rm_unknown_remote_fails(self):
        with tempfile.TemporaryDirectory() as td:
            host_dir = str(Path(td) / "host")
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": host_dir}, clear=False):
                self.assertEqual(
                    remotes_cli.cmd_remote(_args(remote_cmd="rm", id="nope")), 1
                )

    def test_resolve_remote_and_shell_remote_id(self):
        """--remote <id> resolves the registry row; client keeps remote_id."""
        from klanker.shell.repl.loop import _gateway_client

        with tempfile.TemporaryDirectory() as td:
            host_dir = str(Path(td) / "host")
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": host_dir}, clear=False):
                with patch("sys.stdin", io.StringIO("tok-2\n")):
                    self.assertEqual(
                        remotes_cli.cmd_remote(
                            _args(
                                remote_cmd="add",
                                name="box2",
                                url="https://box2.example",
                                id="box2",
                                token_stdin=True,
                            )
                        ),
                        0,
                    )
                row = remotes_cli.resolve_remote("box2")
                self.assertIsNotNone(row)
                self.assertEqual(row["base_url"], "https://box2.example")
                self.assertTrue(row["token_set"])
                self.assertIsNone(remotes_cli.resolve_remote("other"))

                with patch(
                    "klanker.daemon.ensure_daemon"
                ) as ensure, patch(
                    "klanker.shell.repl.loop._repl_prefs_path",
                    return_value=Path(td) / "prefs.json",
                ):
                    gw = _gateway_client(
                        url=row["base_url"],
                        secret="",
                        user="local",
                        project="",
                        provider="",
                        persona="default",
                        session="",
                        remote_id="box2",
                    )
                ensure.assert_not_called()
                self.assertEqual(gw.remote_id, "box2")
                self.assertEqual(gw.base_url, "https://box2.example")


if __name__ == "__main__":
    unittest.main()
