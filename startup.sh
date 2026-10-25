#!/bin/bash
# Azure Linux App Service Startup Script for SentinelVault
echo "Starting SentinelVault on Azure App Service..."
PORT="${PORT:-8000}"
gunicorn --bind=0.0.0.0:$PORT --workers=2 --threads=4 --timeout=600 app:app
