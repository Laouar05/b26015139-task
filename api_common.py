"""Shared JSON validation and API errors."""
from flask import jsonify, request
from werkzeug.exceptions import BadRequest, UnsupportedMediaType


class ApiError(Exception):
    def __init__(self, status, code, message, *, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def response(self):
        response = jsonify(error=self.message, code=self.code)
        response.status_code = self.status
        if self.retry_after is not None:
            response.headers['Retry-After'] = str(self.retry_after)
        return response


def invalid(message='请输入有效的 JSON 对象。'):
    return ApiError(400, 'VALIDATION_ERROR', message)


def fields(data, allowed):
    if not isinstance(data, dict) or data.keys() - set(allowed):
        raise invalid('请求包含无效字段或不是 JSON 对象。')
    return data


def json_body(*allowed):
    try:
        return fields(request.get_json(), allowed)
    except (BadRequest, UnsupportedMediaType, RecursionError):
        raise invalid() from None


def valid_id(value):
    return type(value) is int and 0 < value <= 2**63 - 1
