# @openhive/server

Python FastAPI backend for OpenHive.

## Run (dev)

```bash
cd apps/server
uv venv --python 3.14
source .venv/bin/activate
uv pip install -e .
uvicorn openhive.main:app --port 4484 --reload
```

Verify:
```bash
curl http://127.0.0.1:4484/api/health
# {"status":"ok","version":"0.0.1"}
```

## OAuth providers

Connect flows use real client IDs from each provider's CLI:
- Claude Code — Authorization Code + PKCE (popup)
- OpenAI Codex — Authorization Code + PKCE (popup)
- GitHub Copilot — Device Code (shows code, user visits github.com/login/device)

Tokens are encrypted with Fernet and stored in `~/.openhive/openhive.db` (table:
`oauth_tokens`). The Fernet key lives in `~/.openhive/encryption.key` with `chmod 600`.

## Config

Environment variables (prefix `OPENHIVE_`):

| Var | Default |
| --- | --- |
| `OPENHIVE_HOST` | `127.0.0.1` |
| `OPENHIVE_PORT` | `4484` |
| `OPENHIVE_DATA_DIR` | `~/.openhive` |
| `OPENHIVE_ENCRYPTION_KEY` | auto-generated in `data_dir/encryption.key` |
| `OPENHIVE_CORS_ORIGINS` | `http://localhost:4483,http://127.0.0.1:4483` |
