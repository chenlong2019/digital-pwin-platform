from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    service_name: str = os.getenv("SERVICE_NAME", "neural-render-service")
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8090"))
    storage_root: str = os.getenv("STORAGE_ROOT", "./data")
    database_url: str = os.getenv("DATABASE_URL", "")
    render_backend: str = os.getenv("RENDER_BACKEND", "placeholder")

    @property
    def database_configured(self) -> bool:
        return bool(self.database_url.strip())


settings = Settings()
