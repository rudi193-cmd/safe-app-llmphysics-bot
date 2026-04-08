# b17: 7922L
import wikipediaapi

wiki = wikipediaapi.Wikipedia(
    language="en",
    extract_format=wikipediaapi.ExtractFormat.WIKI,
    user_agent="llmphysics-bot/0.1 (https://www.reddit.com/r/LLMPhysics)",
)


def lookup(term: str, sentences: int = 3) -> str:
    """Return a short Wikipedia summary for a physics term."""
    page = wiki.page(term)

    if not page.exists():
        return f'No Wikipedia article found for "{term}".'

    summary = " ".join(page.summary.split(". ")[:sentences])
    if not summary.endswith("."):
        summary += "."

    return f"**{page.title}**\n\n{summary}\n\n[Read more]({page.fullurl})"
