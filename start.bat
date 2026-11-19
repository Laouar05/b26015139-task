@echo off
setlocal
cd /d "%~dp0" || goto directory_error

if not exist ".venv\Scripts\python.exe" (
    echo Creating the virtual environment...
    py -3 --version >nul 2>&1
    if errorlevel 1 (
        python --version >nul 2>&1 || goto python_missing
        python -m venv .venv || goto venv_error
    ) else (
        py -3 -m venv .venv || goto venv_error
    )
)

echo Checking project dependencies...
".venv\Scripts\python.exe" -m pip --disable-pip-version-check install -r requirements.txt || goto install_error

echo Starting Task Manager at http://127.0.0.1:5000
echo Press Ctrl+C to stop the server.
".venv\Scripts\python.exe" app.py || goto app_error
exit /b 0

:directory_error
echo ERROR: Could not open the project directory.
goto failed

:python_missing
echo ERROR: Install Python 3 and make it available as py or python.
goto failed

:venv_error
echo ERROR: Could not create the virtual environment.
goto failed

:install_error
echo ERROR: Could not install project dependencies.
goto failed

:app_error
echo ERROR: The application exited with an error. See the output above.

:failed
pause
exit /b 1
