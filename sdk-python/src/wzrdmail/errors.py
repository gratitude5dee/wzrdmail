from __future__ import annotations


class WzrdmailError(Exception):
    """API error carrying the §7 envelope: {"name": ..., "message": ...}."""

    def __init__(self, status: int, name: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.name = name
        self.message = message

    def __repr__(self) -> str:
        return f"WzrdmailError(status={self.status}, name={self.name!r}, message={self.message!r})"
