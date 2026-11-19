@echo off
setlocal
rem Use UTF-8 for the Chinese messages below.
chcp 65001 >nul
cd /d "%~dp0" || goto directory_error

if not exist ".venv\Scripts\python.exe" (
    echo 正在创建 Python 虚拟环境……
    py -3 --version >nul 2>&1
    if errorlevel 1 (
        python --version >nul 2>&1 || goto python_missing
        python -m venv .venv || goto venv_error
    ) else (
        py -3 -m venv .venv || goto venv_error
    )
)

echo 正在检查项目依赖……
".venv\Scripts\python.exe" -m pip --quiet --disable-pip-version-check install -r requirements.txt || goto install_error

".venv\Scripts\python.exe" -X utf8 launch.py || goto app_error
exit /b 0

:directory_error
echo 错误：无法打开项目目录。
goto failed

:python_missing
echo 错误：请安装 Python 3，并确保可以使用 py 或 python 命令。
goto failed

:venv_error
echo 错误：无法创建 Python 虚拟环境。
goto failed

:install_error
echo 错误：无法安装项目依赖。
goto failed

:app_error
echo 错误：应用运行失败，请查看上方日志。

:failed
echo 按任意键关闭窗口……
pause >nul
exit /b 1
