# Chaos API

## Démarrage

```bash
docker compose up --build
```

L'API est disponible sur `http://localhost:3000`. PostgreSQL est persistant dans
le volume Docker `postgres_data`.

Routes principales : `GET /healthz`, `GET /readyz`, `GET /metrics`,
`GET|POST /items`, `POST /chaos/cpu?seconds=30`,
`POST /chaos/memory?mb=256` et `POST /chaos/hang`.