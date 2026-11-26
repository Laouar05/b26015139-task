import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app import create_app
from launch import configure_local
from test_rbac import PASSWORD, create_legacy, settings, shutdown


class LaunchTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.database = self.root / 'test.db'
        self.config = self.root / 'TaskManager' / 'llm.json'
        patcher = patch('launch.user_config_path', return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)

    def environment(self, **overrides):
        return dict(DATABASE_URL=f'sqlite:///{self.database.as_posix()}', **overrides)

    def test_create_key_reuse_and_environment_precedence(self):
        env = self.environment(RBAC_BOOTSTRAP_ADMIN_USERNAME='Admin', RBAC_BOOTSTRAP_ADMIN_PASSWORD=PASSWORD)
        configure_local(env)
        key = env['SECRET_KEY']
        self.assertRegex(key, r'^[0-9a-f]{64}$')
        self.assertEqual(self.config.with_name('session.key').read_text().strip(), key)
        second = self.environment(RBAC_BOOTSTRAP_ADMIN_USERNAME='Admin', RBAC_BOOTSTRAP_ADMIN_PASSWORD=PASSWORD)
        configure_local(second)
        self.assertEqual(second['SECRET_KEY'], key)
        self.assertEqual(second['RBAC_ALLOW_REGISTRATION'], 'true')
        self.assertEqual(second['RBAC_BOOTSTRAP_ADMIN_USERNAME'], 'admin')
        second.update(SECRET_KEY='external-key-' * 4, RBAC_ALLOW_REGISTRATION='false')
        configure_local(second)
        self.assertNotEqual(second['SECRET_KEY'], key)
        self.assertEqual(second['RBAC_ALLOW_REGISTRATION'], 'false')
        self.assertEqual(self.config.with_name('session.key').read_text().strip(), key)

    def test_ask_first_boot_only_for_legacy_db(self):
        create_legacy(self.database)
        with patch('launch.sys.stdin.isatty', return_value=True), patch('builtins.input', return_value='') as name, \
                patch('launch.read_api_key', side_effect=[PASSWORD, 'different-password', PASSWORD, PASSWORD]) as password:
            env = self.environment()
            configure_local(env)
        name.assert_called_once()
        self.assertEqual(password.call_count, 4)
        app = create_app(settings(self.database, SECRET_KEY=env['SECRET_KEY'],
                                  RBAC_BOOTSTRAP_ADMIN_USERNAME=env['RBAC_BOOTSTRAP_ADMIN_USERNAME'],
                                  RBAC_BOOTSTRAP_ADMIN_PASSWORD=env['RBAC_BOOTSTRAP_ADMIN_PASSWORD']))
        self.addCleanup(shutdown, app)
        with patch('builtins.input', side_effect=AssertionError('asked again')), \
                patch('launch.read_api_key', side_effect=AssertionError('asked again')):
            second = self.environment()
            configure_local(second)
        self.assertEqual(second['SECRET_KEY'], env['SECRET_KEY'])
        self.assertNotIn('RBAC_BOOTSTRAP_ADMIN_PASSWORD', second)

    def test_noninteractive_missing_credentials_not_synthesized(self):
        with patch('launch.sys.stdin.isatty', return_value=False):
            with self.assertRaisesRegex(ValueError, 'start.bat'):
                configure_local(self.environment())
        self.assertFalse(self.database.exists())


if __name__ == '__main__':
    unittest.main()
