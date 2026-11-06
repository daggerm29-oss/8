import re


def slugify(text: str) -> str:
    """Convert text to a URL slug: lowercase words joined by single hyphens."""
    words = re.findall(r"[A-Za-z0-9]+", text)
    return "-".join(words)


def truncate(text: str, limit: int) -> str:
    """Shorten text to at most `limit` characters, ending with an ellipsis when cut."""
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"
