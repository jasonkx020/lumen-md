@echo off
cd /d "%~dp0.."
git config commit.template .gitmessage
git config core.hooksPath .githooks
echo.
echo Enabled for this repo:
git config --get commit.template
git config --get core.hooksPath
echo.
echo Tip: template fills only when running "git commit" without -m.
pause

