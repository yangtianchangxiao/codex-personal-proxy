#!/usr/bin/env bash
# Direct port / localhost mode:
# export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
# export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"

# Public domain + nginx prefix mode:
# export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN/codex/anthropic"
# export OPENAI_BASE_URL="https://YOUR_DOMAIN/codex/v1"

# Claude Code
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"

# OpenAI Responses / SDK
export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
export OPENAI_API_KEY="cx_your_key"
