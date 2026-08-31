from __future__ import annotations

import math
import time
from collections.abc import Callable
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote

import httpx

from .errors import WzrdmailError

DEFAULT_BASE_URL = "https://api.wzrd.tech"
MAX_RETRIES = 3


def encode_path(segment: str) -> str:
    return quote(segment, safe="")


def _parse_retry_after_ms(header: str | None) -> float | None:
    if header is None or header.strip() == "":
        return None
    try:
        seconds = float(header)
    except ValueError:
        pass
    else:
        if not math.isfinite(seconds):
            return None
        return max(0.0, seconds * 1000)
    try:
        dt = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    return max(0.0, dt.timestamp() * 1000 - time.time() * 1000)


class HttpClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._client = httpx.Client(transport=transport, timeout=timeout)
        self._sleep: Callable[[float], None] = time.sleep

    def close(self) -> None:
        self._client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> Any:
        headers: dict[str, str] = {"Accept": "application/json"}
        if auth:
            if not self._api_key:
                raise WzrdmailError(
                    0,
                    "unauthorized",
                    "wzrdmail: api_key is required for this call "
                    "(set WZRDMAIL_API_KEY or pass api_key=...)",
                )
            headers["Authorization"] = f"Bearer {self._api_key}"

        params = (
            {k: v for k, v in query.items() if v is not None} if query else None
        )

        attempt = 0
        while True:
            response = self._client.request(
                method,
                f"{self._base_url}{path}",
                params=params,
                json=body,
                headers=headers,
            )
            if response.status_code == 429 and attempt < MAX_RETRIES:
                retry_after_ms = _parse_retry_after_ms(response.headers.get("Retry-After"))
                delay_ms = retry_after_ms if retry_after_ms is not None else (2**attempt) * 500
                self._sleep(delay_ms / 1000)
                attempt += 1
                continue
            break

        if response.status_code >= 400:
            try:
                data = response.json()
            except ValueError:
                data = None
            if isinstance(data, dict) and "name" in data and "message" in data:
                raise WzrdmailError(
                    response.status_code, str(data["name"]), str(data["message"])
                )
            raise WzrdmailError(
                response.status_code,
                "internal_error",
                f"unexpected error response (HTTP {response.status_code})",
            )

        if response.status_code == 204 or not response.content:
            return None
        return response.json()
