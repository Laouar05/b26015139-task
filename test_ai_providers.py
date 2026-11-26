"""Tests for AI provider management, switching, Gemini protocol and v1->v2 migration."""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from app import create_app
from bootstrap import inspect_database
from models import db
from test_rbac import PASSWORD, settings, shutdown


class FakeHTTPResponse:
    def __init__(self, payload):
        self._data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self, _limit=-1):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class AIProviderTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.database = Path(self.tempdir.name) / "providers.db"
        self.app = create_app(settings(self.database))

    def tearDown(self):
        shutdown(self.app)
        self.tempdir.cleanup()

    def csrf(self, client):
        return client.get("/api/auth/csrf").get_json()["csrf_token"]

    def send(self, client, method, path, body=None, token=None):
        headers = {}
        if method != "GET":
            headers["X-CSRF-Token"] = token or self.csrf(client)
        kwargs = dict(headers=headers)
        if body is not None:
            kwargs["json"] = body
        return client.open(path, method=method, **kwargs)

    def login(self, client, username, password=PASSWORD):
        res = self.send(client, "POST", "/api/auth/login", dict(username=username, password=password))
        self.assertEqual(res.status_code, 200)
        return res.get_json()["csrf_token"]

    def test_provider_crud_switch_and_permissions(self):
        admin = self.app.test_client()
        token = self.login(admin, "admin")

        # Register a regular member and verify they cannot manage providers
        member = self.app.test_client()
        self.assertEqual(
            self.send(member, "POST", "/api/auth/register", dict(username="alice", password=PASSWORD)).status_code,
            201,
        )
        m_token = self.login(member, "alice")
        self.assertEqual(member.get("/api/admin/ai-providers").status_code, 403)
        self.assertEqual(
            self.send(member, "POST", "/api/admin/ai-providers", dict(
                name="Hack", provider_type="openai", base_url="https://api.openai.com/v1",
                api_key="sk-secret-1234", model="gpt-4o-mini",
            ), m_token).status_code,
            403,
        )

        # Admin creates DeepSeek (OpenAI-compatible) provider
        r1 = self.send(admin, "POST", "/api/admin/ai-providers", dict(
            name="DeepSeek",
            provider_type="openai",
            base_url="https://api.deepseek.com/",
            api_key="sk-deepseek-secret-9988",
            model="deepseek-chat",
            activate=True,
        ), token)
        self.assertEqual(r1.status_code, 201)
        p1 = r1.get_json()
        self.assertEqual(p1["base_url"], "https://api.deepseek.com")
        self.assertTrue(p1["is_active"])
        self.assertNotIn("api_key", p1)
        self.assertEqual(p1["api_key_preview"], "sk-d••••9988")

        # Admin creates Gemini provider (inactive initially)
        r2 = self.send(admin, "POST", "/api/admin/ai-providers", dict(
            name="Google Gemini",
            provider_type="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            api_key="AIzaSyTestKey12345678",
            model="gemini-2.5-flash",
            activate=False,
        ), token)
        self.assertEqual(r2.status_code, 201)
        p2 = r2.get_json()
        self.assertFalse(p2["is_active"])

        # Active endpoint reports DeepSeek
        active = member.get("/api/ai/active").get_json()
        self.assertTrue(active["configured"])
        self.assertEqual(active["name"], "DeepSeek")
        self.assertEqual(active["model"], "deepseek-chat")

        # Switch active provider to Gemini
        sw = self.send(admin, "POST", f"/api/admin/ai-providers/{p2['id']}/activate", None, token)
        self.assertEqual(sw.status_code, 200)
        self.assertTrue(sw.get_json()["is_active"])

        active2 = member.get("/api/ai/active").get_json()
        self.assertEqual(active2["name"], "Google Gemini")
        self.assertEqual(active2["provider_type"], "gemini")

        # Edit Gemini model without re-entering API key -> key stays preserved
        upd = self.send(admin, "PUT", f"/api/admin/ai-providers/{p2['id']}", dict(
            model="gemini-2.5-pro",
        ), token)
        self.assertEqual(upd.status_code, 200)
        self.assertEqual(upd.get_json()["model"], "gemini-2.5-pro")
        self.assertTrue(upd.get_json()["has_api_key"])

        # Chat now routes through Gemini native endpoint and header
        captured = {}

        def fake_urlopen(req, timeout=25):
            captured["url"] = req.full_url
            captured["headers"] = {k.lower(): v for k, v in req.header_items()}
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeHTTPResponse({
                "candidates": [{"content": {"parts": [{"text": "来自 Gemini 的回复"}]}}]
            })

        with patch("llm.urlopen", side_effect=fake_urlopen):
            chat_res = self.send(member, "POST", "/api/chat", dict(
                messages=[dict(role="user", content="你好 Gemini")]
            ), m_token)
        self.assertEqual(chat_res.status_code, 200)
        self.assertEqual(chat_res.get_json()["reply"], "来自 Gemini 的回复")
        self.assertTrue(captured["url"].endswith("/models/gemini-2.5-pro:generateContent"))
        self.assertEqual(captured["headers"].get("x-goog-api-key"), "AIzaSyTestKey12345678")
        self.assertIn("systemInstruction", captured["body"])
        self.assertEqual(captured["body"]["contents"][0]["role"], "user")

        # Fetch Gemini model list using stored provider key
        def fake_models_urlopen(req, timeout=10):
            captured["models_url"] = req.full_url
            return FakeHTTPResponse({
                "models": [
                    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"]},
                ]
            })

        with patch("llm.urlopen", side_effect=fake_models_urlopen):
            ml = self.send(admin, "POST", "/api/admin/ai-providers/models", dict(
                provider_type="gemini",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                provider_id=p2["id"],
            ), token)
        self.assertEqual(ml.status_code, 200)
        self.assertEqual(ml.get_json()["models"], ["gemini-2.5-flash"])

        # Delete active provider -> /api/ai/active falls back cleanly
        self.assertEqual(self.send(admin, "DELETE", f"/api/admin/ai-providers/{p2['id']}", None, token).status_code, 204)
        self.assertFalse(member.get("/api/ai/active").get_json()["configured"])

    def test_v1_to_v2_migration_preserves_data(self):
        # Simulate an existing v1 database (without ai_providers table)
        shutdown(self.app)
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute("DROP TABLE ai_providers")
            conn.execute("PRAGMA user_version=1")
        self.assertEqual(inspect_database(str(self.database)), "v1")

        # Re-open app without bootstrap admin credentials -> should upgrade v1->v2 cleanly
        self.app = create_app(settings(
            self.database,
            RBAC_BOOTSTRAP_ADMIN_USERNAME=None,
            RBAC_BOOTSTRAP_ADMIN_PASSWORD=None,
        ))
        self.assertEqual(inspect_database(str(self.database)), "ready")
        admin = self.app.test_client()
        self.login(admin, "admin")
        self.assertEqual(admin.get("/api/admin/ai-providers").status_code, 200)


if __name__ == "__main__":
    unittest.main()
