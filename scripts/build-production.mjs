import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { buildApplication } = require('../setup/installer');

const ok = await buildApplication(process.cwd(), { target: 'desktop' });
process.exit(ok ? 0 : 1);
