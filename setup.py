from setuptools import setup, find_packages

setup(
    name="werewolf",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "jinja2",
        "tqdm",
        "absl-py",
        "openai",
        "pyyaml",
        "google-genai",
        "anthropic",
        "marko",
        "pandas",
        "fastapi",
        "uvicorn[standard]",
        "pydantic",
        "livekit",
        "livekit-api",
        "aiohttp",
        "pipecat-ai>=0.0.72",
        "pipecat-ai[openai, silero]",
    ],
) 