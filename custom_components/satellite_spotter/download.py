"""Reading what a server sends: no more of it than can make sense."""

from __future__ import annotations

import aiohttp

_CHUNK_BYTES = 64 * 1024


class TooMuchData(ValueError):
    """A server sent more than an answer of this kind can be."""


async def async_read_capped(response: aiohttp.ClientResponse, limit: int) -> bytes:
    """Return a response's body, stopping once it is past a limit, as it expands if compressed."""
    body = bytearray()
    async for chunk in response.content.iter_chunked(_CHUNK_BYTES):
        body += chunk
        if len(body) > limit:
            raise TooMuchData(f"The answer is over {limit} bytes")
    return bytes(body)
