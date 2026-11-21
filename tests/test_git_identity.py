"""Unit tests for Git identity and credential setup."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from klanker.git_identity import askpass_response, setup_git_identity


class TestGitIdentity(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _clean_env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        env = {
            k: v
            for k, v in os.environ.items()
            if k in ("PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "COMSPEC")
        }
        if extra:
            env.update(extra)
        return env

    def test_default_fallback_identity(self):
        with patch.dict(os.environ, self._clean_env(), clear=True):
            res = setup_git_identity(target_home=self.home)
            self.assertEqual(res["name"], "Klanker")
            self.assertEqual(res["email"], "klanker@users.noreply.github.com")

            gitconfig = self.home / ".gitconfig"
            self.assertTrue(gitconfig.exists())
            content = gitconfig.read_text(encoding="utf-8")
            self.assertIn("name = Klanker", content)
            self.assertIn("email = klanker@users.noreply.github.com", content)

    def test_explicit_author_env_vars(self):
        extra = {
            "GIT_AUTHOR_NAME": "Alice",
            "GIT_AUTHOR_EMAIL": "alice@example.com",
        }
        with patch.dict(os.environ, self._clean_env(extra), clear=True):
            res = setup_git_identity(target_home=self.home)
            self.assertEqual(res["name"], "Alice")
            self.assertEqual(res["email"], "alice@example.com")

            gitconfig = self.home / ".gitconfig"
            content = gitconfig.read_text(encoding="utf-8")
            self.assertIn("name = Alice", content)
            self.assertIn("email = alice@example.com", content)

    def test_token_configures_askpass_without_plaintext_credentials(self):
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.read.return_value = b'{"login": "felixk", "id": 12345}'
        mock_response.__enter__.return_value = mock_response

        cred_file = self.home / ".git-credentials"
        cred_file.write_text("https://x-access-token:oldleak@github.com\n", encoding="utf-8")

        extra = {
            "GITHUB_TOKEN": "ghp_mocktoken123",
            "AGENTS_HOST_DIR": str(self.home / ".agents"),
        }
        with patch.dict(os.environ, self._clean_env(extra), clear=True):
            with patch("urllib.request.urlopen", return_value=mock_response):
                res = setup_git_identity(target_home=self.home)
                self.assertEqual(res["name"], "felixk")
                self.assertEqual(res["email"], "12345+felixk@users.noreply.github.com")

                self.assertFalse(cred_file.exists())
                askpass_file = Path(res["askpass"])
                self.assertTrue(askpass_file.is_file())
                self.assertNotIn(
                    "ghp_mocktoken123", askpass_file.read_text(encoding="utf-8")
                )

                gitconfig = self.home / ".gitconfig"
                content = gitconfig.read_text(encoding="utf-8")
                self.assertIn("askPass", content)
                self.assertNotIn("helper = store --file", content)
                self.assertNotIn("ghp_mocktoken123", content)
                self.assertNotIn("insteadof", content.lower())
                self.assertEqual(
                    askpass_response("Username for 'https://github.com': "),
                    "x-access-token",
                )
                self.assertEqual(
                    askpass_response("Password for 'https://github.com': "),
                    "ghp_mocktoken123",
                )


if __name__ == "__main__":
    unittest.main()
