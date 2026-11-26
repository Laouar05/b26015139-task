"""Shared credential policy for web registration and local bootstrap."""
import re


def normalize_username(value):
    if not isinstance(value, str):
        raise ValueError("用户名须为 3 至 32 位英文字母、数字或下划线。")
    name = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,32}", name):
        raise ValueError("用户名须为 3 至 32 位英文字母、数字或下划线。")
    return name.lower()


def validate_password(value):
    if not isinstance(value, str) or not 8 <= len(value) <= 128 or not value.strip():
        raise ValueError("密码须为 8 至 128 个字符，且不能全为空白。")
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("密码含无效字符。") from exc
    return value
