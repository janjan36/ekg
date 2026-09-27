@echo off
rem Startet den lokalen Webserver und oeffnet die EKG-App in Microsoft Edge.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
