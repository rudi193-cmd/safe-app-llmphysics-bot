# safe-app-llmphysics-bot

A Reddit bot for [r/LLMPhysics](https://www.reddit.com/r/LLMPhysics/) that responds to `!define <term>` commands with a 3-sentence Wikipedia summary and a link to the full article.

---

## What It Does

The bot streams comments from r/LLMPhysics in real time. When it sees a comment starting with `!define`, it queries the Wikipedia API, extracts the first three sentences of the article summary, and replies with the result.

If no article is found, it says so cleanly and moves on.

---

## File Structure

```
safe-app-llmphysics-bot/
├── bot.py                  # Entry point. Reddit stream loop.
├── config.py               # Loads env vars, defines constants.
├── plugins/
│   └── physics_define.py   # Wikipedia lookup logic.
├── requirements.txt
├── .env.example
└── .gitignore
```

---

## Setup

**1. Clone and enter the repo**

```bash
git clone https://github.com/your-org/safe-app-llmphysics-bot.git
cd safe-app-llmphysics-bot
```

**2. Copy `.env.example` to `.env` and fill in your credentials**

```bash
cp .env.example .env
```

**3. Install dependencies**

```bash
pip install -r requirements.txt
```

**4. Run the bot**

```bash
python bot.py
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `REDDIT_CLIENT_ID` | Yes | Client ID from your Reddit app |
| `REDDIT_CLIENT_SECRET` | Yes | Client secret from your Reddit app |
| `REDDIT_USERNAME` | Yes | Username of the bot account |
| `REDDIT_PASSWORD` | Yes | Password of the bot account |
| `REDDIT_USER_AGENT` | Yes | User agent string (e.g. `llmphysics-bot/0.1 by u/YourBotAccount`) |
| `SUBREDDIT` | No | Subreddit to monitor. Defaults to `LLMPhysics` |

### Getting Reddit Credentials

1. Log in as your **dedicated bot account** (a Reddit alt — not your personal account).
2. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).
3. Create a new app. Select **script** as the type.
4. Set the redirect URI to `http://localhost:8080` (unused, but required).
5. Copy the client ID (shown under the app name) and the client secret.

---

## Usage Example

A user posts in r/LLMPhysics:

> `!define quantum entanglement`

The bot replies:

> **Quantum entanglement**
>
> Quantum entanglement is a phenomenon where two or more particles become correlated in such a way that the quantum state of each particle cannot be described independently of the others. Measuring one particle instantly influences the state of its entangled partner, regardless of the distance between them. Einstein famously called this "spooky action at a distance."
>
> [Read more](https://en.wikipedia.org/wiki/Quantum_entanglement)
>
> ---
> *I'm a bot for r/LLMPhysics. Use `!define <term>` to look up a physics concept.*

---

## Adding Plugins

New commands go in `plugins/`. Each plugin is a module with its own lookup or handler logic. `bot.py` imports from `plugins/` directly — add a new file, wire it into `handle_comment()` in `bot.py`, and it's live.

The `physics_define` plugin is the reference implementation.

---

## Dependencies

- [praw](https://praw.readthedocs.io/) — Reddit API wrapper
- [wikipedia-api](https://wikipedia-api.readthedocs.io/) — Wikipedia article fetching
- [python-dotenv](https://pypi.org/project/python-dotenv/) — `.env` loading
