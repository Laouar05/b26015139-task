"""SQLite schema inspection, transactional bootstrap and legacy backup."""
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from tempfile import mkstemp

from sqlalchemy import func, select
from werkzeug.security import generate_password_hash

from credentials import normalize_username, validate_password
from models import AIProvider, Permission, Role, Task, User, db, role_permissions, user_roles, utcnow

SCHEMA_VERSION = 2
V1_TABLES = {'users', 'roles', 'permissions', 'user_roles', 'role_permissions', 'tasks'}
LEGACY_COLUMNS = (
    ('id', 'INTEGER', 1, 1), ('title', 'VARCHAR(200)', 1, 0),
    ('description', 'TEXT', 0, 0), ('completed', 'BOOLEAN', 1, 0),
    ('created_at', 'DATETIME', 1, 0), ('updated_at', 'DATETIME', 1, 0),
)
PERMISSIONS = {
    'task:read': '查看任务', 'task:write': '创建、编辑和删除任务',
    'task:read_all': '跨用户查看任务', 'task:write_all': '跨用户修改任务',
    'task:assign': '转交任务', 'ai:chat': 'AI 对话', 'ai:recommend': '今日建议',
    'ai:decompose': 'AI 拆解', 'user:manage': '管理用户', 'role:manage': '分配角色',
}
ROLES = {
    'admin': ('管理员', '管理全部任务、AI 和用户角色', tuple(PERMISSIONS)),
    'member': ('普通成员', '管理自己的任务并使用 AI',
               ('task:read', 'task:write', 'ai:chat', 'ai:recommend', 'ai:decompose')),
    'viewer': ('只读访客', '仅查看自己名下的任务', ('task:read',)),
}


class BootstrapError(RuntimeError):
    pass


def schema_state(execute):
    version = execute('PRAGMA user_version').fetchone()[0]
    objects = {tuple(row) for row in execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    )}
    if version == SCHEMA_VERSION:
        expected = {('table', table.name) for table in db.metadata.tables.values()}
        expected.update(('index', index.name) for table in db.metadata.tables.values() for index in table.indexes)
        owner_column = any(row[1] == 'owner_id' and row[3] == 1 for row in execute('PRAGMA table_info(tasks)'))
        owner_fk = any(row[2:5] == ('users', 'owner_id', 'id') and row[6] == 'RESTRICT'
                       for row in map(tuple, execute('PRAGMA foreign_key_list(tasks)')))
        if not expected <= objects or not owner_column or not owner_fk:
            raise BootstrapError('版本标记与数据库结构不符，请检查备份。')
        return 'ready'
    if version == 1:
        expected_v1 = {('table', name) for name in V1_TABLES}
        owner_column = any(row[1] == 'owner_id' and row[3] == 1 for row in execute('PRAGMA table_info(tasks)'))
        owner_fk = any(row[2:5] == ('users', 'owner_id', 'id') and row[6] == 'RESTRICT'
                       for row in map(tuple, execute('PRAGMA foreign_key_list(tasks)')))
        if not expected_v1 <= objects or not owner_column or not owner_fk:
            raise BootstrapError('版本标记与数据库结构不符，请检查备份。')
        return 'v1'
    if version != 0:
        raise BootstrapError(f'不支持的数据库版本：{version}。')
    if not objects:
        return 'empty'
    if objects == {('table', 'tasks')}:
        columns = tuple((row[1], row[2].upper(), row[3], row[5]) for row in execute('PRAGMA table_info(tasks)'))
        if (columns == LEGACY_COLUMNS and not execute('PRAGMA foreign_key_list(tasks)').fetchone()
                and not execute('PRAGMA index_list(tasks)').fetchone()):
            return 'legacy'
    raise BootstrapError('无法识别数据库结构；未修改数据库，请检查备份和配置。')


def inspect_database(filename):
    if filename in ('', ':memory:', None):
        return 'empty'
    path = Path(filename).resolve()
    if not path.exists():
        return 'empty'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
        connection.execute('BEGIN')
        return schema_state(connection.execute)


def backup_legacy(filename):
    path = Path(filename).resolve()
    descriptor, name = mkstemp(prefix=path.name + '.pre-rbac-', suffix='.bak', dir=path.parent)
    os.close(descriptor)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(name)) as destination:
            source.backup(destination)
    return Path(name)


def seed(connection, username, password_hash):
    table = Permission.__table__
    permissions = {code: connection.execute(table.insert().values(code=code, description=description)).inserted_primary_key[0]
                   for code, description in PERMISSIONS.items()}
    table = Role.__table__
    roles = {}
    for code, (name, description, grants) in ROLES.items():
        roles[code] = connection.execute(table.insert().values(code=code, name=name, description=description)).inserted_primary_key[0]
        connection.execute(role_permissions.insert(), [
            dict(role_id=roles[code], permission_id=permissions[permission]) for permission in grants
        ])
    now = utcnow()
    admin_id = connection.execute(User.__table__.insert().values(
        username=username, password_hash=password_hash, created_at=now, updated_at=now,
    )).inserted_primary_key[0]
    connection.execute(user_roles.insert().values(user_id=admin_id, role_id=roles['admin']))
    return admin_id


def initialize_database(app):
    saved_backup = None
    with db.engine.connect() as connection:
        try:
            connection.exec_driver_sql('BEGIN')
            state = schema_state(connection.exec_driver_sql)
            if state != 'ready':
                connection.rollback()
                connection.exec_driver_sql('BEGIN IMMEDIATE')
                state = schema_state(connection.exec_driver_sql)
            if state == 'v1':
                db.metadata.create_all(connection)
                connection.exec_driver_sql(f'PRAGMA user_version={SCHEMA_VERSION}')
            elif state != 'ready':
                try:
                    username = normalize_username(app.config.get('RBAC_BOOTSTRAP_ADMIN_USERNAME'))
                    password = validate_password(app.config.get('RBAC_BOOTSTRAP_ADMIN_PASSWORD'))
                except ValueError as exc:
                    raise BootstrapError('需要配置初始管理员。请通过 start.bat 启动，或设置首管环境变量。' + str(exc)) from exc
                if state == 'legacy':
                    saved_backup = backup_legacy(db.engine.url.database)
                    connection.exec_driver_sql('ALTER TABLE tasks RENAME TO tasks_legacy')
                db.metadata.create_all(connection)
                admin_id = seed(connection, username, generate_password_hash(password, method='scrypt'))
                if state == 'legacy':
                    columns = ', '.join(column[0] for column in LEGACY_COLUMNS)
                    connection.exec_driver_sql(
                        f'INSERT INTO tasks ({columns}, owner_id) SELECT {columns}, ? FROM tasks_legacy', (admin_id,)
                    )
                    counts = [connection.exec_driver_sql(f'SELECT COUNT(*) FROM {table}').scalar_one()
                              for table in ('tasks', 'tasks_legacy')]
                    difference = connection.exec_driver_sql(
                        f'SELECT {columns} FROM tasks_legacy EXCEPT SELECT {columns} FROM tasks LIMIT 1'
                    ).fetchone()
                    if counts[0] != counts[1] or difference is not None:
                        raise BootstrapError('历史任务复制校验失败。')
                    connection.exec_driver_sql('DROP TABLE tasks_legacy')
                connection.exec_driver_sql(f'PRAGMA user_version={SCHEMA_VERSION}')
            if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
                raise BootstrapError('数据库存在无效外键。')
            active_admins = connection.scalar(
                select(func.count()).select_from(User).join(user_roles).join(Role)
                .where(User.is_active.is_(True), Role.code == 'admin')
            )
            if not active_admins:
                raise BootstrapError('没有有效管理员，请执行离线管理员恢复。')
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    if saved_backup:
        app.logger.warning('旧库迁移完成，备份：%s', saved_backup)


def recover_admin(filename, username, password):
    username = normalize_username(username)
    password_hash = generate_password_hash(validate_password(password), method='scrypt')
    if not filename or filename == ':memory:':
        raise BootstrapError('离线恢复需要已初始化的文件型数据库。')
    uri = Path(filename).resolve().as_uri() + '?mode=rw'
    with closing(sqlite3.connect(uri, uri=True)) as connection, connection:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('BEGIN IMMEDIATE')
        if schema_state(connection.execute) != 'ready':
            raise BootstrapError('离线恢复仅可用于已初始化的数据库。')
        updated = connection.execute('''
            UPDATE users SET password_hash=?, is_active=1, session_version=session_version+1, updated_at=?
            WHERE username=? AND id IN (
                SELECT user_id FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE roles.code='admin'
            )
        ''', (password_hash, utcnow().replace(tzinfo=None).isoformat(' '), username))
        if updated.rowcount != 1:
            raise BootstrapError('指定用户没有现有管理员角色。此命令不会提升普通用户。')


def main():
    import argparse
    from getpass import getpass

    from config import DEFAULT_DATABASE_URI, sqlite_url

    parser = argparse.ArgumentParser(description='停止应用后，在本机离线恢复现有管理员。')
    parser.add_argument('--recover-admin', metavar='USERNAME', required=True)
    args = parser.parse_args()
    try:
        if not sys.stdin.isatty():
            raise BootstrapError('请在控制台交互运行恢复命令。')
        password = getpass('新管理员密码：')
        if password != getpass('确认新密码：'):
            raise BootstrapError('两次密码输入不同。')
        url = sqlite_url(os.environ.get('DATABASE_URL') or DEFAULT_DATABASE_URI)
        recover_admin(url.database, args.recover_admin, password)
    except (BootstrapError, ValueError, OSError, sqlite3.Error, EOFError) as exc:
        parser.exit(1, f'恢复失败：{exc}\n')
    print('管理员账号已恢复，该账号之前的会话已撤销。')


if __name__ == '__main__':
    main()
