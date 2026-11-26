import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Barrier, Event
from unittest.mock import patch

import app as task_app
from bootstrap import BootstrapError, inspect_database
from models import db

PASSWORD = 'test-only-pass-6789'
LEGACY_SQL = '''CREATE TABLE tasks (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL,
    description TEXT, completed BOOLEAN NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'''
LEGACY_TASK = (17, '历史任务', None, 1, '2025-01-02 03:00:00', '2025-01-03 05:00:00')


def create_legacy(path):
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(LEGACY_SQL)
        conn.execute('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)', LEGACY_TASK)


def settings(path, **overrides):
    return dict(dict(TESTING=True, SECRET_KEY='test-secret-value-' * 4,
                     SQLALCHEMY_DATABASE_URI=f'sqlite:///{path.as_posix()}',
                     RBAC_BOOTSTRAP_ADMIN_USERNAME='admin', RBAC_BOOTSTRAP_ADMIN_PASSWORD=PASSWORD,
                     RBAC_ALLOW_REGISTRATION=True, SESSION_COOKIE_SECURE=False,
                     TASK_STUDIO_ORIGIN=None, LLM_MODEL='', LLM_API_KEY='', LLM_BASE_URL=''), **overrides)


def shutdown(application):
    with application.app_context():
        db.engine.dispose()


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'test.db'

    def open_app(self, **overrides):
        application = task_app.create_app(settings(self.path, **overrides))
        self.addCleanup(shutdown, application)
        return application

    def test_empty_and_repeat_with_or_without_llm(self):
        self.open_app()
        self.open_app(RBAC_BOOTSTRAP_ADMIN_USERNAME=None, RBAC_BOOTSTRAP_ADMIN_PASSWORD=None,
                      LLM_MODEL='stub', LLM_API_KEY='unused', LLM_BASE_URL='https://example.invalid')
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(conn.execute('SELECT username FROM users').fetchall(), [('admin',)])
            self.assertEqual(conn.execute('SELECT count(*) FROM role_permissions').fetchone()[0], 16)
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_legacy_fields_fk_and_backup_recovery(self):
        create_legacy(self.path)
        application = self.open_app()
        backup, = self.path.parent.glob('*.bak')
        with closing(sqlite3.connect(backup)) as source, closing(sqlite3.connect(':memory:')) as recovered:
            source.backup(recovered)
            self.assertEqual(recovered.execute('SELECT * FROM tasks').fetchone(), LEGACY_TASK)
        with application.app_context(), db.engine.connect() as conn:
            self.assertEqual(conn.exec_driver_sql('PRAGMA foreign_keys').scalar(), 1)
            result = conn.exec_driver_sql('SELECT id,title,description,completed,created_at,updated_at,owner_id FROM tasks').one()
            self.assertEqual(tuple(result), (*LEGACY_TASK, 1))
            self.assertEqual(conn.exec_driver_sql('PRAGMA foreign_key_check').all(), [])
            with self.assertRaises(Exception) as caught:
                conn.exec_driver_sql('UPDATE tasks SET owner_id=999')
            self.assertIn('FOREIGN KEY', str(caught.exception))

    def test_interrupted_migration_rolls_back(self):
        create_legacy(self.path)
        with patch('bootstrap.seed', side_effect=RuntimeError('interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                self.open_app()
        self.assertEqual(inspect_database(self.path), 'legacy')
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(conn.execute('SELECT * FROM tasks').fetchone(), LEGACY_TASK)
        self.open_app()

    def test_reject_unknown_database_and_corrupt_fk(self):
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute('PRAGMA user_version=99')
        with self.assertRaisesRegex(BootstrapError, '99'):
            self.open_app()
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute('PRAGMA user_version=0')
        self.open_app()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute('INSERT INTO user_roles VALUES (999, 1)')
        with self.assertRaisesRegex(BootstrapError, '外键'):
            self.open_app()


class ApiTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.application = task_app.create_app(settings(Path(temporary.name) / 'test.db'))
        self.addCleanup(shutdown, self.application)
        self.admin = self.login('admin')

    def send(self, client, method, url, body=None, csrf=True):
        headers = {}
        if csrf:
            headers['X-CSRF-Token'] = client.get('/api/auth/csrf').json['csrf_token']
        return client.open(url, method=method, json=body, headers=headers)

    def login(self, username):
        client = self.application.test_client()
        result = self.send(client, 'POST', '/api/auth/login', dict(username=username, password=PASSWORD))
        self.assertEqual(result.status_code, 200, result.json)
        return client

    def register(self, username):
        client = self.application.test_client()
        result = self.send(client, 'POST', '/api/auth/register', dict(username=username, password=PASSWORD))
        self.assertEqual(result.status_code, 201, result.json)
        return result.json['id'], self.login(username)

    def create_task(self, client, title='test'):
        result = self.send(client, 'POST', '/api/tasks', {'title': title})
        self.assertEqual(result.status_code, 201, result.json)
        return result.json

    def change_roles(self, admin, target, *roles):
        return self.send(admin, 'PUT', f'/api/admin/users/{target}/roles', {'roles': list(roles)})

    def change_status(self, admin, target, active):
        return self.send(admin, 'PATCH', f'/api/admin/users/{target}', {'is_active': active})

    def test_identity_registration_and_csrf(self):
        guest = self.application.test_client()
        response = guest.get('/api/tasks')
        self.assertEqual((response.status_code, response.json['code']), (401, 'AUTH_REQUIRED'))
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        credentials = dict(username='a_member', password=PASSWORD)
        self.assertEqual(self.send(guest, 'POST', '/api/auth/login', credentials, csrf=False).json['code'], 'CSRF_INVALID')
        self.application.config['RBAC_ALLOW_REGISTRATION'] = False
        self.assertEqual(self.send(guest, 'POST', '/api/auth/register', credentials).json['code'], 'REGISTRATION_DISABLED')
        self.application.config['RBAC_ALLOW_REGISTRATION'] = True
        self.assertEqual(self.send(guest, 'POST', '/api/auth/register', dict(credentials, roles=['admin'])).status_code, 400)
        target, member = self.register('a_member')
        self.assertEqual(member.get('/api/auth/me').json['roles'], ['member'])
        self.assertEqual(member.get('/api/admin/users').status_code, 403)
        for method, url, body in [('POST', '/api/tasks', {'title': 'x'}), ('POST', '/api/chat', {}),
                                  ('PUT', f'/api/admin/users/{target}/roles', {'roles': ['viewer']})]:
            self.assertEqual(self.send(self.admin, method, url, body, csrf=False).json['code'], 'CSRF_INVALID')
        token = self.admin.get('/api/auth/csrf').json['csrf_token']
        result = self.admin.post('/api/tasks', json={'title': 'x'}, headers={'X-CSRF-Token': token, 'Origin': 'https://other.test'})
        self.assertEqual(result.json['code'], 'CSRF_INVALID')

    def test_logout_and_disable_revoke_previous_cookies(self):
        target, member = self.register('a_member')
        other = self.login('a_member')
        self.assertEqual(self.send(member, 'POST', '/api/auth/logout').status_code, 204)
        self.assertEqual(other.get('/api/auth/me').status_code, 401)
        member = self.login('a_member')
        self.assertEqual(self.change_status(self.admin, target, False).status_code, 200)
        self.assertEqual(self.change_status(self.admin, target, True).status_code, 200)
        self.assertEqual(member.get('/api/auth/me').status_code, 401)

    def test_viewer_read_own_only_and_no_ai_or_writes(self):
        target, member = self.register('a_member')
        own = self.create_task(member)
        self.create_task(self.admin, 'other')
        self.assertEqual(self.change_roles(self.admin, target, 'member', 'viewer').status_code, 200)
        self.assertIn('task:write', member.get('/api/auth/me').json['permissions'])
        self.assertEqual(self.change_roles(self.admin, target, 'viewer').status_code, 200)
        self.assertEqual(member.get('/api/tasks').json, [own])
        self.assertEqual(member.get('/api/auth/me').json['permissions'], ['task:read'])
        with patch('app.chat_reply') as chat, patch('app.recommend_tasks') as recommend, patch('app.decompose_task') as decompose:
            for method, url in [('POST', '/api/chat'), ('POST', '/api/recommendations/today'),
                                ('POST', '/api/tasks/decompose'), ('POST', '/api/tasks/batch'), ('POST', '/api/tasks'),
                                ('PUT', f'/api/tasks/{own["id"]}'), ('DELETE', f'/api/tasks/{own["id"]}'),
                                ('PATCH', f'/api/tasks/{own["id"]}/toggle')]:
                self.assertEqual(self.send(member, method, url, {}).status_code, 403, url)
            for upstream in (chat, recommend, decompose):
                upstream.assert_not_called()

    def test_task_isolation_transfer_and_admin_binding(self):
        _, alice = self.register('alice')
        bob_id, bob = self.register('bobby')
        task = self.create_task(alice)
        url = f'/api/tasks/{task["id"]}'
        for method, suffix, data in [('GET', '', None), ('PUT', '', {'title': 'x'}), ('DELETE', '', None), ('PATCH', '/toggle', None)]:
            found = self.send(bob, method, url + suffix, data)
            missing = self.send(bob, method, '/api/tasks/999' + suffix, data)
            self.assertEqual((found.status_code, found.json), (404, missing.json))
        self.assertEqual(self.send(self.admin, 'PUT', url, {'title': 'admin edit'}).status_code, 200)
        self.assertEqual(self.send(self.admin, 'PUT', f'/api/admin/tasks/{task["id"]}/owner', {'owner_id': bob_id}).status_code, 200)
        self.assertEqual(alice.get(url).status_code, 404)
        self.assertEqual(bob.get(url).json['title'], 'admin edit')
        admin_id = self.admin.get('/api/auth/me').json['user']['id']
        self.assertEqual(self.create_task(self.admin, 'admin')['owner_id'], admin_id)
        batch = self.send(self.admin, 'POST', '/api/tasks/batch', {'tasks': [{'title': 'batch'}]})
        self.assertEqual((batch.status_code, batch.json['tasks'][0]['owner_id']), (201, admin_id))
        self.assertEqual(len(self.admin.get('/api/tasks').json), 3)

    def test_batch_atomic_and_whitelisted(self):
        uid, member = self.register('a_member')
        for bad in ({'title': ''}, {'title': 'forged', 'owner_id': 1}):
            self.assertEqual(self.send(member, 'POST', '/api/tasks/batch', {'tasks': [{'title': 'valid'}, bad]}).status_code, 400)
            self.assertEqual(member.get('/api/tasks').json, [])
        self.assertEqual(self.send(member, 'POST', '/api/tasks', {'title': 'forged', 'owner_id': 1}).status_code, 400)
        result = self.send(member, 'POST', '/api/tasks/batch', {'tasks': [{'title': 'first'}, {'title': 'second'}]})
        self.assertTrue(all(task['owner_id'] == uid for task in result.json['tasks']))

    def test_ai_scope_and_no_upstream_on_denial(self):
        _, member = self.register('a_member')
        foreign = self.create_task(self.admin, 'foreign')
        message = {'messages': [{'role': 'user', 'content': 'hello'}]}
        with patch('app.chat_reply', return_value='ok') as chat, patch('app.recommend_tasks', return_value=[]) as recommend:
            self.assertEqual(self.send(member, 'POST', '/api/chat', dict(message, task_id=foreign['id'])).status_code, 404)
            chat.assert_not_called()
            self.assertEqual(self.send(member, 'POST', '/api/chat', message).json, {'reply': 'ok'})
            self.assertIsNone(chat.call_args.args[2])
            self.assertEqual(self.send(member, 'POST', '/api/recommendations/today', {'scope': 'all'}).status_code, 403)
            self.assertEqual(self.send(member, 'POST', '/api/recommendations/today', {}).json, {'recommendations': []})
            recommend.assert_not_called()
            own = self.create_task(member, 'own')
            done = self.create_task(member, 'done')
            self.send(member, 'PATCH', f'/api/tasks/{done["id"]}/toggle')
            self.send(member, 'POST', '/api/recommendations/today', {})
            self.assertEqual([task['id'] for task in recommend.call_args.args[1]], [own['id']])
            self.send(self.admin, 'POST', '/api/recommendations/today', {})
            self.assertEqual([task['id'] for task in recommend.call_args.args[1]], [foreign['id']])
            self.send(self.admin, 'POST', '/api/recommendations/today', {'scope': 'all'})
            self.assertEqual({task['id'] for task in recommend.call_args.args[1]}, {foreign['id'], own['id']})
            self.send(member, 'POST', '/api/chat', dict(message, task_id=own['id']))
            self.assertEqual(chat.call_args.args[2], {'title': 'own', 'description': '', 'completed': False})
        payload = {'recommendations': [{'task_id': foreign['id'], 'reason': 'bad', 'first_step': 'bad'}]}
        with patch('llm._chat_json', return_value=payload):
            output = self.send(member, 'POST', '/api/recommendations/today', {})
        self.assertEqual(output.status_code, 502)
        self.assertNotIn('recommendations', output.json)

    def test_self_changes_and_parallel_admin_changes(self):
        second_id, second = self.register('second')
        member_id, member = self.register('untouched')
        first_id = self.admin.get('/api/auth/me').json['user']['id']
        self.assertEqual(self.change_roles(self.admin, first_id, 'viewer').json['code'], 'SELF_CHANGE_FORBIDDEN')
        self.assertEqual(self.change_status(self.admin, first_id, False).json['code'], 'SELF_CHANGE_FORBIDDEN')
        self.assertEqual(self.change_roles(self.admin, second_id, 'admin').status_code, 200)
        ready = Barrier(2, timeout=5)

        def demote():
            ready.wait()
            return self.change_roles(self.admin, second_id, 'viewer').status_code

        def disable():
            ready.wait()
            return self.change_status(second, first_id, False).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(demote), pool.submit(disable)]
            self.assertEqual(sorted(result.result(timeout=12) for result in futures)[0], 200)
            self.assertIn(futures[0].result() + futures[1].result() - 200, {401, 403, 409})
        self.assertEqual(member.get('/api/auth/me').json['user']['id'], member_id)
        self.assertEqual(member.get('/api/auth/me').json['roles'], ['member'])

    def test_write_rechecks_owner_after_concurrent_transfer(self):
        _, alice = self.register('alice')
        bob_id, bob = self.register('bobby')
        task = self.create_task(alice, 'original')
        reached = Event()
        allow_write = Event()
        start_write = task_app.start_write

        def paused(*codes):
            db.session.remove()
            reached.set()
            if not allow_write.wait(8):
                raise RuntimeError('timed out waiting for transfer')
            return start_write(*codes)

        url = f'/api/tasks/{task["id"]}'
        with patch('app.start_write', side_effect=paused), ThreadPoolExecutor(max_workers=1) as pool:
            def write():
                return self.send(alice, 'PUT', url, {'title': 'stale write'})
            future = pool.submit(write)
            try:
                self.assertTrue(reached.wait(5))
                # Release the authentication read snapshot before the transfer commits.
                self.assertEqual(self.send(self.admin, 'PUT', f'/api/admin/tasks/{task["id"]}/owner', {'owner_id': bob_id}).status_code, 200)
            finally:
                allow_write.set()
            self.assertEqual(future.result(timeout=12).status_code, 404)
        self.assertEqual(bob.get(url).json['title'], 'original')


if __name__ == '__main__':
    unittest.main()
