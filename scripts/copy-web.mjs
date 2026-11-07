import { cpSync } from 'node:fs';
cpSync('src/web/public', 'dist/web/public', { recursive: true });
cpSync('src/graph/context.jsonld', 'dist/graph/context.jsonld'); // read at runtime by graph.ts
