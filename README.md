# Kiln

Kiln is a software factory: GitHub issues in, pull requests out, with Claude Code agents
orchestrated through Herdr.

| Path                                       | What it is                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| [`apps/control-plane`](apps/control-plane) | The server and dashboard: intake, pipeline, autonomy policy, agent runtime |

New apps and shared packages go under `apps/` and `packages/` (npm workspaces).

```bash
npm install            # once, from the repository root
npm run dev            # control plane with reload
npm test               # every workspace
```

See the [control plane README](apps/control-plane/README.md) for configuration and usage.
