# Integrations (prepared, not published)

Every framework below speaks MCP, so each integration is just "start `npx -y constellate mcp` over stdio".
Check each snippet against the framework's current version before publishing.

## OpenClaw
```json
{ "mcpServers": { "constellate": { "command": "npx", "args": ["-y", "constellate", "mcp"] } } }
```

## Claude Agent SDK (TypeScript)
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const m of query({ prompt: 'Fix the failing build', options: { mcpServers: { constellate: { command: 'npx', args: ['-y', 'constellate', 'mcp'] } } } })) console.log(m);
```

## LangChain (Python, langchain-mcp-adapters)
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({"constellate": {"command": "npx", "args": ["-y", "constellate", "mcp"], "transport": "stdio"}})
tools = await client.get_tools()
```

## CrewAI (crewai-tools MCP adapter)
```python
from crewai_tools import MCPServerAdapter
from mcp import StdioServerParameters
with MCPServerAdapter(StdioServerParameters(command="npx", args=["-y", "constellate", "mcp"])) as tools:
    agent = Agent(role="engineer", goal="ship", backstory="", tools=tools)
```

## AutoGen (autogen-ext MCP)
```python
from autogen_ext.tools.mcp import StdioServerParams, mcp_server_tools
tools = await mcp_server_tools(StdioServerParams(command="npx", args=["-y", "constellate", "mcp"]))
```
