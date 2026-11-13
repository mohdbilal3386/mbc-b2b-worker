FROM docker.io/searxng/searxng:latest

# Pin JSON-format search on and the limiter off. The worker is the only public
# entry point; SearXNG is reached over Render's private network.
COPY --chown=977:977 settings.yml /etc/searxng/settings.yml
