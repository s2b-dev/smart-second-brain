<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/s2b-dev/smart-second-brain/main/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/s2b-dev/smart-second-brain/main/assets/logo-light.svg">
  <img alt="Smart Second Brain" src="https://raw.githubusercontent.com/s2b-dev/smart-second-brain/main/assets/logo-light.svg" width="300">
</picture>

</div>

<br>

Your Smart Second Brain is a **free** and **open-source** Obsidian plugin that makes your vault smarter: better search, an interactive knowledge graph, and an AI assistant that actually knows your notes.

Search surfaces your notes, the graph groups them into the topics your vault is actually about, and the assistant can draw on both when answering. **Search and the graph work right away with no AI provider.** Connecting one unlocks the full agent. Runs on desktop and mobile.

**[smartsecondbrain.dev](https://smartsecondbrain.dev)** has a demo video, the features, setup guides, and documentation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/s2b-dev/smart-second-brain/main/assets/hero-desktop-dark.png">
  <img alt="Smart Second Brain: the smart graph with the vault grouped into topics, beside a chat that reads your notes and proposes an edit" src="https://raw.githubusercontent.com/s2b-dev/smart-second-brain/main/assets/hero-desktop-light.png">
</picture>

## Features

- **[Search](https://smartsecondbrain.dev/search/)** that combines keyword matching with meaning, so you find the note you were thinking of rather than the one you typed ([how it works](https://smartsecondbrain.dev/search/how-it-works/))
- **[Smart Graph](https://smartsecondbrain.dev/graph/)** that works out what your vault is about: notes grouped into topics from your links, your tags, and what you wrote, with nothing to maintain ([how it works](https://smartsecondbrain.dev/graph/how-it-works/))
- **[Agents](https://smartsecondbrain.dev/agents/)** that read and write your notes, draw charts and dashboards live from them as [widgets](https://smartsecondbrain.dev/agents/widgets/), with skills, memory, MCP, and integrations with your other plugins

## Install

Install **Smart Second Brain** from Obsidian's community plugins and enable it. Search and the Smart Graph work immediately, with no configuration.

Add an embedding model and pick it for search and for the graph to unlock semantic search and topics that read what your notes say, not just how they link; add an AI provider to enable the agent. See the [getting started guide](https://smartsecondbrain.dev/start/installation/).

Out of the box, nothing leaves your machine. The only network requests are to the providers you configure, and there is no telemetry — see [privacy](https://smartsecondbrain.dev/privacy/model/).

## Contributing

- Report a bug or request a feature [here](https://github.com/s2b-dev/smart-second-brain/issues/new/choose)
- Ask a question in the [Q&A](https://github.com/s2b-dev/smart-second-brain/discussions/categories/q-a)
- Share a skill, agent, or workflow in [Show and tell](https://github.com/s2b-dev/smart-second-brain/discussions/categories/show-and-tell)
- Pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the development setup and how we handle AI-assisted contributions; [AGENTS.md](AGENTS.md) has the architecture, commands, and conventions

We initially built this as a university project. That's long finished, but we keep developing it in our spare time, as an experimental playground for state-of-the-art AI and as a tool for the Obsidian workflow we're passionate about. Much of the code is written with AI coding agents; we review, test, and stand behind every change, and commits and pull requests say when an agent was involved.

## License

[MIT](LICENSE)
