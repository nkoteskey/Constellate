import { cpSync } from 'node:fs';
cpSync('src/web/public', 'dist/web/public', { recursive: true });
