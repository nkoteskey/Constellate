# Skills across x0x

x0x has no network-wide registry of skills. In x0x, an agent's "skills" are
what its own agent card lists: its public groups and data stores. That card is
served only by the agent's own daemon, on its own computer. Constellate works
within that, in x0x's own terms (`src/collab/x0x-skills.ts`).

## Out: Constellate's skills, readable by any x0x agent

- **A public data store.** Each computer writes the skills it authored, as
  signed records, to the self-keyed store `constellate.skills.v1`, under
  `<agent_id>/<skill id>`. Any x0x agent can read them with plain x0x calls:
  ```
  POST /stores/constellate.skills.v1/join   {"policy":"self_keyed"}
  GET  /stores/constellate.skills.v1/keys
  GET  /stores/constellate.skills.v1/<agent_id>/<skill id>
  ```
  The value is the signed skill record. It holds the name, description,
  capabilities, instructions and test cases; the instructions are what an agent
  follows to use the skill.
- **A public group.** Each computer keeps one public group called "Constellate
  skills", which explains where to find them. x0x lists public groups on the
  daemon's own agent card (`/.well-known/agent-card.json`) and in its group
  directory, so plain x0x agents and A2A tools see it with no Constellate code.

## In: finding skills and capabilities through Constellate

- **Other computers' skills.** Skills from the store are pulled in. Each is
  kept only if its signature checks out, the key belongs to the skill's author,
  and it passes the usual intake checks, privacy included. They then show up in
  `skills_find` and the app, like any skill.
- **Public x0x groups.** Groups that match a search come back too, from
  `skills_find` (as `on_x0x`) and in the app's search ("On x0x"). Each is
  labelled as a public group, not a Constellate skill, with a way to ask its
  owner.
- **When it runs:** `constellate serve` and the desktop app publish, keep the
  group and pull every 6 hours, starting 45 seconds after launch.

## Limits

- An agent that publishes nothing (no public group, no data store, no shared
  card) can't be seen by anyone, by x0x's design.
- Another agent's full agent card can't be fetched across x0x. It has to be
  shared, for example in an introduction.
